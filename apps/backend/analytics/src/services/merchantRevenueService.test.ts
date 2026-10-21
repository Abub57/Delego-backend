import { describe, it, expect, vi } from "vitest";
import type { Logger } from "@delegolabs/utils";
import type { RevenueAggregateBucket, RevenueAggregateQuery, RevenueGroupBy } from "@delegolabs/types";
import {
  MerchantRevenueService,
  REVENUE_BUCKETS_SQL,
  REVENUE_CACHE_TTL_SECONDS,
  addPeriods,
  enumeratePeriods,
  revenueCacheKey,
  sumRevenueBuckets,
  truncateToPeriod,
  type RevenueCacheClient,
  type RevenueQueryExecutor,
} from "./merchantRevenueService.js";

const MERCHANT = "6f1c2a9e-1b2c-4d3e-8f00-0123456789ab";
const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;

/** Above Number.MAX_SAFE_INTEGER (9007199254740991): Number() would corrupt these. */
const HUGE_A = "9007199254740993";
const HUGE_B = "9007199254740995";

type Amounts = Pick<
  RevenueAggregateBucket,
  "grossVolumeStroops" | "platformFeesStroops" | "refundedStroops" | "orderCount"
>;

function bucket(periodStart: string, a: Partial<Amounts> = {}): RevenueAggregateBucket {
  const gross = BigInt(a.grossVolumeStroops ?? "0");
  const fees = BigInt(a.platformFeesStroops ?? "0");
  const refunded = BigInt(a.refundedStroops ?? "0");
  return {
    periodStart,
    grossVolumeStroops: gross.toString(),
    platformFeesStroops: fees.toString(),
    refundedStroops: refunded.toString(),
    netRevenueStroops: (gross - fees - refunded).toString(),
    orderCount: a.orderCount ?? 0,
    netRevenueGrowthPct: null,
  };
}

/**
 * Stands in for Postgres: returns gap-filled rows for exactly the requested
 * periods, from per-currency fixtures. It does not re-implement the SQL; it
 * lets us verify how the service splits, caches and sums results.
 */
function fakeDatabase(fixtures: Record<string, Record<string, Partial<Amounts>>>) {
  const calls: Array<Record<string, unknown>> = [];
  const execute: RevenueQueryExecutor = async (_sql, replacements) => {
    calls.push(replacements);
    const unit = replacements.unit as RevenueGroupBy;
    const first = new Date(`${String(replacements.firstPeriod).replace(" ", "T")}Z`);
    const last = new Date(`${String(replacements.lastPeriod).replace(" ", "T")}Z`);
    const byPeriod = fixtures[String(replacements.currency)] ?? {};
    return enumeratePeriods(first, last, unit).map((p) => bucket(p.toISOString(), byPeriod[p.toISOString()]));
  };
  return { execute, calls };
}

function fakeRedis() {
  const store = new Map<string, { value: string; ttl: number }>();
  const client: RevenueCacheClient = {
    mget: vi.fn(async (...keys: string[]) => keys.map((k) => store.get(k)?.value ?? null)),
    multi: () => {
      const ops: Array<() => void> = [];
      const tx = {
        set(key: string, value: string, _mode: "EX", seconds: number) {
          ops.push(() => store.set(key, { value, ttl: seconds }));
          return tx;
        },
        async exec() {
          ops.forEach((op) => op());
          return [];
        },
      };
      return tx;
    },
  };
  return { client, store };
}

function query(overrides: Partial<RevenueAggregateQuery> = {}): RevenueAggregateQuery {
  return {
    merchantId: MERCHANT,
    startDate: "2026-10-01T00:00:00.000Z",
    endDate: "2026-10-03T00:00:00.000Z",
    groupBy: "day",
    currency: "USDC",
    ...overrides,
  };
}

const NOW = new Date("2026-10-03T12:00:00.000Z");

// ---------------------------------------------------------------------------

describe("period arithmetic (must match Postgres date_trunc in UTC)", () => {
  it("truncates weeks to Monday and months to the 1st", () => {
    const wednesday = new Date("2026-10-14T18:30:00Z");
    expect(truncateToPeriod(wednesday, "day").toISOString()).toBe("2026-10-14T00:00:00.000Z");
    expect(truncateToPeriod(wednesday, "week").toISOString()).toBe("2026-10-12T00:00:00.000Z");
    expect(truncateToPeriod(new Date("2026-10-18T23:59:59Z"), "week").toISOString()).toBe("2026-10-12T00:00:00.000Z");
    expect(truncateToPeriod(wednesday, "month").toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });

  it("steps months across year boundaries and handles a negative step", () => {
    expect(addPeriods(new Date("2026-12-01T00:00:00Z"), "month", 1).toISOString()).toBe("2027-01-01T00:00:00.000Z");
    expect(addPeriods(new Date("2026-03-01T00:00:00Z"), "month", -1).toISOString()).toBe("2026-02-01T00:00:00.000Z");
  });

  it("expands a mid-period range to whole periods", () => {
    const periods = enumeratePeriods(new Date("2026-09-15T10:00:00Z"), new Date("2026-11-02T00:00:00Z"), "month");
    expect(periods.map((p) => p.toISOString())).toEqual([
      "2026-09-01T00:00:00.000Z",
      "2026-10-01T00:00:00.000Z",
      "2026-11-01T00:00:00.000Z",
    ]);
  });
});

describe("REVENUE_BUCKETS_SQL", () => {
  it("aggregates with date_trunc, conditional sums and a LAG window over a gap-filled series", () => {
    expect(REVENUE_BUCKETS_SQL).toContain("date_trunc(:unit, pr.settled_at AT TIME ZONE 'UTC')");
    expect(REVENUE_BUCKETS_SQL).toContain("FILTER (WHERE pr.status <> 'refunded')");
    expect(REVENUE_BUCKETS_SQL).toContain("LAG(f.net) OVER (ORDER BY f.period_start)");
    expect(REVENUE_BUCKETS_SQL).toContain("generate_series(:seriesStart::timestamp");
    // Amounts leave Postgres as text so BigInt sees every digit.
    expect(REVENUE_BUCKETS_SQL).toContain('gross::text');
  });

  it("reads one period before the range so the first bucket's growth is real", async () => {
    const db = fakeDatabase({});
    const service = new MerchantRevenueService({ execute: db.execute, now: () => NOW, logger: silentLogger });

    await service.getRevenueAggregates(query({ groupBy: "week", startDate: "2026-09-16T00:00:00.000Z" }));

    expect(db.calls[0]).toMatchObject({
      unit: "week",
      step: "1 week",
      seriesStart: "2026-09-07 00:00:00.000",
      firstPeriod: "2026-09-14 00:00:00.000",
      lastPeriod: "2026-09-28 00:00:00.000",
      rangeEnd: "2026-10-05 00:00:00.000",
    });
  });
});

describe("BigInt aggregation across currencies", () => {
  const fixtures = {
    USDC: {
      "2026-10-01T00:00:00.000Z": { grossVolumeStroops: HUGE_A, platformFeesStroops: "1", refundedStroops: "2", orderCount: 3 },
      "2026-10-02T00:00:00.000Z": { grossVolumeStroops: HUGE_B, platformFeesStroops: "3", refundedStroops: "0", orderCount: 4 },
    },
    EURC: {
      "2026-10-02T00:00:00.000Z": { grossVolumeStroops: "500", platformFeesStroops: "5", refundedStroops: "45", orderCount: 1 },
    },
  };

  it("sums stroop amounts above 2^53 exactly", async () => {
    const db = fakeDatabase(fixtures);
    const service = new MerchantRevenueService({ execute: db.execute, now: () => NOW, logger: silentLogger });

    const report = await service.getRevenueAggregates(query({ currency: "USDC" }));

    expect(report.totals).toEqual({
      grossVolumeStroops: "18014398509481988",
      platformFeesStroops: "4",
      refundedStroops: "2",
      netRevenueStroops: "18014398509481982",
      orderCount: 7,
    });
    // Sanity: these inputs really are unrepresentable as doubles.
    expect(String(Number(HUGE_A))).not.toBe(HUGE_A);
    expect(report.buckets[0].grossVolumeStroops).toBe(HUGE_A);
  });

  it("keeps each currency's totals separate", async () => {
    const db = fakeDatabase(fixtures);
    const service = new MerchantRevenueService({ execute: db.execute, now: () => NOW, logger: silentLogger });

    const usdc = await service.getRevenueAggregates(query({ currency: "USDC" }));
    const eurc = await service.getRevenueAggregates(query({ currency: "EURC" }));

    expect(db.calls.map((c) => c.currency)).toEqual(["USDC", "EURC"]);
    expect(eurc.totals).toEqual({
      grossVolumeStroops: "500",
      platformFeesStroops: "5",
      refundedStroops: "45",
      netRevenueStroops: "450",
      orderCount: 1,
    });
    expect(usdc.totals.grossVolumeStroops).toBe("18014398509481988");
  });

  it("does not serve one currency's cached buckets to another", async () => {
    const db = fakeDatabase(fixtures);
    const redis = fakeRedis();
    const service = new MerchantRevenueService({ execute: db.execute, cache: redis.client, now: () => NOW, logger: silentLogger });

    await service.getRevenueAggregates(query({ currency: "USDC" }));
    const eurc = await service.getRevenueAggregates(query({ currency: "EURC" }));

    expect(db.calls).toHaveLength(2);
    expect(eurc.totals.grossVolumeStroops).toBe("500");
  });

  it("sumRevenueBuckets handles negative net revenue (refunds exceeding volume in a period)", () => {
    const totals = sumRevenueBuckets([
      bucket("2026-10-01T00:00:00.000Z", { grossVolumeStroops: "100", refundedStroops: "250" }),
      bucket("2026-10-02T00:00:00.000Z", { grossVolumeStroops: HUGE_A }),
    ]);
    expect(totals.netRevenueStroops).toBe((BigInt(HUGE_A) - 150n).toString());
  });

  it("rejects non-integer amounts instead of silently rounding", async () => {
    const service = new MerchantRevenueService({
      execute: async () => [{ ...bucket("2026-10-01T00:00:00.000Z"), grossVolumeStroops: "1.5e3" }],
      now: () => NOW,
      logger: silentLogger,
    });
    await expect(
      service.getRevenueAggregates(query({ endDate: "2026-10-01T00:00:00.000Z" }))
    ).rejects.toThrow("non-integer grossVolumeStroops");
  });
});

describe("Redis caching of historical buckets", () => {
  it("caches only fully elapsed periods, with a one-hour TTL", async () => {
    const db = fakeDatabase({});
    const redis = fakeRedis();
    const service = new MerchantRevenueService({ execute: db.execute, cache: redis.client, now: () => NOW, logger: silentLogger });

    await service.getRevenueAggregates(query());

    // Oct 1 and Oct 2 are closed; Oct 3 (contains NOW) is still open.
    expect([...redis.store.keys()]).toEqual([
      revenueCacheKey(query(), new Date("2026-10-01T00:00:00.000Z")),
      revenueCacheKey(query(), new Date("2026-10-02T00:00:00.000Z")),
    ]);
    expect([...redis.store.values()].every((e) => e.ttl === REVENUE_CACHE_TTL_SECONDS)).toBe(true);
    expect(REVENUE_CACHE_TTL_SECONDS).toBe(3600);
  });

  it("serves cached history and queries only the open period on a repeat request", async () => {
    const db = fakeDatabase({ USDC: { "2026-10-03T00:00:00.000Z": { grossVolumeStroops: "7", orderCount: 1 } } });
    const redis = fakeRedis();
    const service = new MerchantRevenueService({ execute: db.execute, cache: redis.client, now: () => NOW, logger: silentLogger });

    await service.getRevenueAggregates(query());
    const second = await service.getRevenueAggregates(query());

    expect(db.calls).toHaveLength(2);
    expect(db.calls[1].firstPeriod).toBe("2026-10-03 00:00:00.000");
    expect(second.buckets.map((b) => b.periodStart)).toEqual([
      "2026-10-01T00:00:00.000Z",
      "2026-10-02T00:00:00.000Z",
      "2026-10-03T00:00:00.000Z",
    ]);
    expect(second.totals.grossVolumeStroops).toBe("7");
  });

  it("answers a fully historical range entirely from cache", async () => {
    const db = fakeDatabase({});
    const redis = fakeRedis();
    const service = new MerchantRevenueService({ execute: db.execute, cache: redis.client, now: () => NOW, logger: silentLogger });
    const historical = query({ endDate: "2026-10-02T00:00:00.000Z" });

    await service.getRevenueAggregates(historical);
    await service.getRevenueAggregates(historical);

    expect(db.calls).toHaveLength(1);
  });

  it("refetches from the first missing bucket when the cache has a hole", async () => {
    const db = fakeDatabase({});
    const redis = fakeRedis();
    const service = new MerchantRevenueService({ execute: db.execute, cache: redis.client, now: () => NOW, logger: silentLogger });

    await service.getRevenueAggregates(query());
    redis.store.delete(revenueCacheKey(query(), new Date("2026-10-02T00:00:00.000Z")));
    await service.getRevenueAggregates(query());

    expect(db.calls[1].firstPeriod).toBe("2026-10-02 00:00:00.000");
  });

  it("falls back to the database when Redis is down", async () => {
    const db = fakeDatabase({});
    const broken: RevenueCacheClient = {
      mget: async () => Promise.reject(new Error("ECONNREFUSED")),
      multi: () => ({ set: () => undefined, exec: async () => Promise.reject(new Error("ECONNREFUSED")) }),
    };
    const service = new MerchantRevenueService({ execute: db.execute, cache: broken, now: () => NOW, logger: silentLogger });

    const report = await service.getRevenueAggregates(query());

    expect(report.buckets).toHaveLength(3);
    expect(db.calls).toHaveLength(1);
  });

  it("refuses to cache buckets that do not align with the requested periods", async () => {
    const redis = fakeRedis();
    const service = new MerchantRevenueService({
      execute: async () => [bucket("2026-09-30T00:00:00.000Z")],
      cache: redis.client,
      now: () => NOW,
      logger: silentLogger,
    });

    await expect(
      service.getRevenueAggregates(query({ endDate: "2026-10-01T00:00:00.000Z" }))
    ).rejects.toThrow("do not align");
    expect(redis.store.size).toBe(0);
  });
});
