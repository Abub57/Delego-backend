import { describe, it, expect, beforeEach, vi } from "vitest";
import type { TaggedCacheRedisClient, RedisPipeline } from "@delegolabs/utils/cache/taggedCache.js";
import { MerchantReputationService } from "./merchantReputationService.js";

// ─── In-memory fake Redis client (same shape used by taggedCache.test.ts) ──
function buildFakeRedis(): TaggedCacheRedisClient {
  const store = new Map<string, string>();
  const sets = new Map<string, Set<string>>();

  const client: TaggedCacheRedisClient = {
    async get(key) {
      return store.has(key) ? store.get(key)! : null;
    },
    async set(key, value) {
      store.set(key, value);
      return "OK";
    },
    async del(...keys) {
      let count = 0;
      for (const key of keys) {
        if (store.delete(key)) count++;
        if (sets.delete(key)) count++;
      }
      return count;
    },
    async smembers(key) {
      return [...(sets.get(key) ?? new Set())];
    },
    async scan(cursor, _matchFlag, pattern) {
      if (cursor !== "0") return ["0", []];
      const regex = new RegExp(`^${pattern.replace(/\*/g, ".*")}$`);
      const matches = [...sets.keys()].filter((k) => regex.test(k));
      return ["0", matches];
    },
    async incr(key) {
      const current = store.has(key) ? parseInt(store.get(key)!, 10) : 0;
      const next = current + 1;
      store.set(key, String(next));
      return next;
    },
    multi() {
      const ops: Array<() => void> = [];
      const pipeline: RedisPipeline = {
        sadd(key, ...members) {
          ops.push(() => {
            const set = sets.get(key) ?? new Set<string>();
            for (const m of members) set.add(m);
            sets.set(key, set);
          });
          return pipeline;
        },
        async exec() {
          for (const op of ops) op();
          return ops.map(() => [null, 1]);
        },
      };
      return pipeline;
    },
  };

  return client;
}

// ─── Fake Sequelize — just enough of `.query()` to drive the service ──────
function buildFakeSequelize(row: {
  total_orders: string;
  fulfilled_orders: string;
  cancelled_orders: string;
  disputed_orders: string;
}) {
  const query = vi.fn().mockResolvedValue([row]);
  return { query } as unknown as import("sequelize").Sequelize;
}

describe("MerchantReputationService", () => {
  let redis: TaggedCacheRedisClient;

  beforeEach(() => {
    redis = buildFakeRedis();
  });

  it("aggregates DB rows into MerchantOrderCounts", async () => {
    const sequelize = buildFakeSequelize({
      total_orders: "50",
      fulfilled_orders: "45",
      cancelled_orders: "3",
      disputed_orders: "2",
    });
    const service = new MerchantReputationService(sequelize, redis);

    const counts = await service.getOrderCounts({ merchantId: "merchant-1" });

    expect(counts).toEqual({
      totalOrders: 50,
      fulfilledOrders: 45,
      cancelledOrders: 3,
      disputedOrders: 2,
    });
    expect(sequelize.query).toHaveBeenCalledTimes(1);
    const [, options] = (sequelize.query as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(options.replacements.merchantId).toBe("merchant-1");
  });

  it("computes and returns a fresh (uncached) score on first call", async () => {
    const sequelize = buildFakeSequelize({
      total_orders: "100",
      fulfilled_orders: "95",
      cancelled_orders: "3",
      disputed_orders: "1",
    });
    const service = new MerchantReputationService(sequelize, redis);

    const result = await service.getMerchantQualityMetrics({ merchantId: "merchant-2" });

    expect(result.merchantId).toBe("merchant-2");
    expect(result.sampleSize).toBe(100);
    expect(result.cached).toBe(false);
    expect(result.lowConfidence).toBe(false);
    expect(result.compositeScore).toBeGreaterThan(0);
    expect(sequelize.query).toHaveBeenCalledTimes(1);
  });

  it("serves the second lookup from cache without re-querying the DB", async () => {
    const sequelize = buildFakeSequelize({
      total_orders: "100",
      fulfilled_orders: "95",
      cancelled_orders: "3",
      disputed_orders: "1",
    });
    const service = new MerchantReputationService(sequelize, redis);

    const first = await service.getMerchantQualityMetrics({ merchantId: "merchant-3" });
    const second = await service.getMerchantQualityMetrics({ merchantId: "merchant-3" });

    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.compositeScore).toBe(first.compositeScore);
    // Only the first call should have hit the DB.
    expect(sequelize.query).toHaveBeenCalledTimes(1);
  });

  it("flags lowConfidence when the sample size is below the threshold", async () => {
    const sequelize = buildFakeSequelize({
      total_orders: "3",
      fulfilled_orders: "3",
      cancelled_orders: "0",
      disputed_orders: "0",
    });
    const service = new MerchantReputationService(sequelize, redis);

    const result = await service.getMerchantQualityMetrics({ merchantId: "merchant-4" });

    expect(result.lowConfidence).toBe(true);
  });

  it("caches distinct entries per period window rather than colliding on merchantId alone", async () => {
    const sequelize = buildFakeSequelize({
      total_orders: "10",
      fulfilled_orders: "10",
      cancelled_orders: "0",
      disputed_orders: "0",
    });
    const service = new MerchantReputationService(sequelize, redis);

    await service.getMerchantQualityMetrics({ merchantId: "merchant-5", periodStart: "2026-01-01" });
    await service.getMerchantQualityMetrics({ merchantId: "merchant-5", periodStart: "2026-06-01" });

    // Different period windows are cache misses against each other.
    expect(sequelize.query).toHaveBeenCalledTimes(2);
  });

  it("invalidateMerchant clears cached entries for that merchant", async () => {
    const sequelize = buildFakeSequelize({
      total_orders: "10",
      fulfilled_orders: "10",
      cancelled_orders: "0",
      disputed_orders: "0",
    });
    const service = new MerchantReputationService(sequelize, redis);

    await service.getMerchantQualityMetrics({ merchantId: "merchant-6" });
    await service.invalidateMerchant("merchant-6");
    const after = await service.getMerchantQualityMetrics({ merchantId: "merchant-6" });

    expect(after.cached).toBe(false);
    expect(sequelize.query).toHaveBeenCalledTimes(2);
  });

  it("still returns a computed score if the Redis cache write fails", async () => {
    const sequelize = buildFakeSequelize({
      total_orders: "10",
      fulfilled_orders: "10",
      cancelled_orders: "0",
      disputed_orders: "0",
    });
    const brokenRedis: TaggedCacheRedisClient = {
      ...redis,
      set: vi.fn().mockRejectedValue(new Error("connection reset")),
    };
    const service = new MerchantReputationService(sequelize, brokenRedis);

    const result = await service.getMerchantQualityMetrics({ merchantId: "merchant-7" });

    expect(result.cached).toBe(false);
    expect(result.compositeScore).toBeGreaterThan(0);
  });
});
