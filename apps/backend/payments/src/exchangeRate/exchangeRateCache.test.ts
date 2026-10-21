/**
 * Unit tests for the Issue #379 exchange-rate cache (Redis-backed, with
 * stale fallback and circuit-breaker-protected oracle refreshes).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  refreshRate,
  getExchangeRate,
  invalidateRate,
  rateKey,
  lastGoodRateKey,
  getCacheMetrics,
  resetCacheMetrics,
  setRateOracleClient,
  resetRateOracleClient,
  setExchangeRateCacheConfig,
  resetExchangeRateCacheConfig,
  getExchangeRateHealth,
  defaultOracleClient,
  ExchangeRateUnavailableError,
  _setRateRedisClientForTesting,
  _resetRateRedisClientForTesting,
  type RateCacheRedisClient,
  type ExchangeRateRecord,
} from "./exchangeRateCache.js";
import {
  CircuitBreaker,
  CircuitBreakerOpenError,
  getRateOracleCircuitBreaker,
  setRateOracleCircuitBreaker,
  resetRateOracleCircuitBreakerForTesting,
} from "./circuitBreaker.js";

function makeFakeRedis(): RateCacheRedisClient & {
  store: Map<string, { value: string; expiresAt: number }>;
} {
  const store = new Map<string, { value: string; expiresAt: number }>();
  return {
    store,
    async get(key) {
      const entry = store.get(key);
      if (!entry) return null;
      if (entry.expiresAt <= Date.now()) {
        store.delete(key);
        return null;
      }
      return entry.value;
    },
    async set(key, value, _mode, ttlSeconds) {
      store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
      return "OK";
    },
    async del(key) {
      return store.delete(key) ? 1 : 0;
    },
  };
}

/** Open the breaker by pointing it at an always-failing oracle. */
async function openCircuit(): Promise<void> {
  setRateOracleClient(async () => {
    throw new Error("oracle unreachable");
  });
  setRateOracleCircuitBreaker(new CircuitBreaker({ failureThreshold: 1, recoveryTimeoutMs: 60_000 }));
  await expect(refreshRate("USD", "XLM")).rejects.toThrow("oracle unreachable");
  expect(getRateOracleCircuitBreaker().getState()).toBe("open");
}

describe("exchange rate cache (Issue #379)", () => {
  let redis: ReturnType<typeof makeFakeRedis>;

  beforeEach(() => {
    redis = makeFakeRedis();
    _setRateRedisClientForTesting(redis);
    resetCacheMetrics();
    resetRateOracleCircuitBreakerForTesting();
    resetRateOracleClient();
    resetExchangeRateCacheConfig();
    setRateOracleCircuitBreaker(new CircuitBreaker({ failureThreshold: 3, recoveryTimeoutMs: 60_000 }));
  });

  describe("key helpers", () => {
    it("builds case-insensitive fresh and last-good keys", () => {
      expect(rateKey("usd", "xlm")).toBe("exchange:rate:USD:XLM");
      expect(lastGoodRateKey("EUR", "BTC")).toBe("exchange:rate:last-good:EUR:BTC");
    });
  });

  describe("refreshRate", () => {
    it("caches the fresh copy and the last-known-good copy", async () => {
      setRateOracleClient(async () => 0.4);

      const record = await refreshRate("USD", "XLM");

      expect(record).toMatchObject({
        baseCurrency: "USD",
        quoteCurrency: "XLM",
        rate: 0.4,
        source: "oracle",
      });
      expect(record.cachedAt).toBeInstanceOf(Date);

      expect(redis.store.has(rateKey("USD", "XLM"))).toBe(true);
      expect(redis.store.has(lastGoodRateKey("USD", "XLM"))).toBe(true);
      expect(getCacheMetrics().oracleRefreshes).toBe(1);
    });

    it("respects configured TTLs on both copies", async () => {
      setRateOracleClient(async () => 2.5);
      setExchangeRateCacheConfig({ freshTtlSeconds: 60, staleTtlSeconds: 3600 });

      await refreshRate("EUR", "USDC");

      const fresh = redis.store.get(rateKey("EUR", "USDC"))!;
      const lastGood = redis.store.get(lastGoodRateKey("EUR", "USDC"))!;
      const now = Date.now();
      expect(fresh.expiresAt - now).toBeLessThanOrEqual(60_000);
      expect(lastGood.expiresAt - now).toBeLessThanOrEqual(3_600_000);
      expect(lastGood.expiresAt - now).toBeGreaterThan(60_000);
    });

    it("rejects implausible oracle rates (<= 0 or absurd)", async () => {
      setRateOracleClient(async () => -1);
      await expect(refreshRate("USD", "XLM")).rejects.toThrow(/implausible/);

      setRateOracleClient(async () => Number.POSITIVE_INFINITY);
      await expect(refreshRate("USD", "XLM")).rejects.toThrow(/implausible/);

      setRateOracleClient(async () => 1e12);
      await expect(refreshRate("USD", "XLM")).rejects.toThrow(/implausible/);

      expect(redis.store.size).toBe(0);
      expect(getCacheMetrics().oracleFailures).toBe(3);
    });

    it("returns identity rate 1 for same-currency pairs without touching the oracle", async () => {
      const oracle = vi.fn(async () => 42);
      setRateOracleClient(oracle);

      const record = await refreshRate("USD", "usd");

      expect(record.rate).toBe(1);
      expect(record.source).toBe("identity");
      expect(oracle).not.toHaveBeenCalled();
    });

    it("propagates oracle failures and counts them", async () => {
      setRateOracleClient(async () => {
        throw new Error("boom");
      });
      await expect(refreshRate("USD", "XLM")).rejects.toThrow("boom");
      expect(getCacheMetrics().oracleFailures).toBe(1);
      expect(getCacheMetrics().oracleRefreshes).toBe(0);
    });
  });

  describe("getExchangeRate read path", () => {
    it("serves a fresh cache hit without calling the oracle", async () => {
      setRateOracleClient(async () => 0.4);
      await refreshRate("USD", "XLM");
      resetCacheMetrics();

      const oracle = vi.fn(async () => 999);
      setRateOracleClient(oracle);

      const result = await getExchangeRate("USD", "XLM");

      expect(result.rate).toBe(0.4);
      expect(result.stale).toBe(false);
      expect(oracle).not.toHaveBeenCalled();
      expect(getCacheMetrics().hits).toBe(1);
    });

    it("refreshes from the oracle on a cache miss and caches the result", async () => {
      const oracle = vi.fn(async () => 0.41);
      setRateOracleClient(oracle);

      const result = await getExchangeRate("USD", "XLM");

      expect(result.rate).toBe(0.41);
      expect(result.stale).toBe(false);
      expect(oracle).toHaveBeenCalledTimes(1);
      expect(redis.store.has(rateKey("USD", "XLM"))).toBe(true);
      expect(getCacheMetrics().oracleRefreshes).toBe(1);
    });

    it("falls back to the last known good rate when the oracle fails", async () => {
      // Seed a known-good rate
      setRateOracleClient(async () => 0.4);
      await refreshRate("USD", "XLM");

      // Expire only the fresh copy — the stale copy outlives it
      const fresh = redis.store.get(rateKey("USD", "XLM"))!;
      fresh.expiresAt = Date.now() - 1;

      // Now the oracle breaks
      setRateOracleClient(async () => {
        throw new Error("oracle unreachable");
      });

      const result = await getExchangeRate("USD", "XLM");

      expect(result.rate).toBe(0.4);
      expect(result.stale).toBe(true);
      expect(result.source).toBe("oracle");
      expect(getCacheMetrics().staleFallbackHits).toBe(1);
    });

    it("does not overwrite the last-good copy with failed refreshes", async () => {
      setRateOracleClient(async () => 0.4);
      await refreshRate("USD", "XLM");
      const lastGoodBefore = redis.store.get(lastGoodRateKey("USD", "XLM"))!;

      setRateOracleClient(async () => {
        throw new Error("down");
      });
      const fresh = redis.store.get(rateKey("USD", "XLM"))!;
      fresh.expiresAt = Date.now() - 1;

      const result = await getExchangeRate("USD", "XLM");
      expect(result.stale).toBe(true);

      expect(redis.store.get(lastGoodRateKey("USD", "XLM"))!.value).toBe(lastGoodBefore.value);
    });

    it("serves the stale rate while the circuit is open without calling the oracle", async () => {
      setRateOracleClient(async () => 0.4);
      await refreshRate("USD", "XLM");

      await openCircuit();
      const fresh = redis.store.get(rateKey("USD", "XLM"))!;
      fresh.expiresAt = Date.now() - 1;

      const oracle = vi.fn(async () => 123);
      setRateOracleClient(oracle);

      const result = await getExchangeRate("USD", "XLM");

      expect(result.rate).toBe(0.4);
      expect(result.stale).toBe(true);
      expect(oracle).not.toHaveBeenCalled();
      expect(getRateOracleCircuitBreaker().getStats().totalRejections).toBeGreaterThanOrEqual(1);
    });

    it("throws ExchangeRateUnavailableError when nothing is cached and the oracle is unreachable", async () => {
      await openCircuit();

      await expect(getExchangeRate("USD", "XLM")).rejects.toThrow(
        ExchangeRateUnavailableError
      );
      expect(getCacheMetrics().misses).toBe(1);
    });

    it("returns identity rate 1 for same-currency pairs", async () => {
      const result = await getExchangeRate("xlm", "XLM");
      expect(result.rate).toBe(1);
      expect(result.stale).toBe(false);
      expect(result.source).toBe("identity");
    });
  });

  describe("invalidateRate", () => {
    it("drops both the fresh and last-known-good copies", async () => {
      setRateOracleClient(async () => 0.4);
      await refreshRate("USD", "XLM");
      expect(redis.store.has(rateKey("USD", "XLM"))).toBe(true);

      const deleted = await invalidateRate("USD", "XLM");

      expect(deleted).toBe(2);
      expect(redis.store.has(rateKey("USD", "XLM"))).toBe(false);
      expect(redis.store.has(lastGoodRateKey("USD", "XLM"))).toBe(false);
    });

    it("returns 0 for unknown pairs", async () => {
      expect(await invalidateRate("GBP", "BTC")).toBe(0);
    });
  });

  describe("getExchangeRateHealth", () => {
    it("reports circuit breaker stats and cache metrics together", async () => {
      setRateOracleClient(async () => 0.4);
      await refreshRate("USD", "XLM");

      const health = getExchangeRateHealth();

      expect(health.circuitBreaker.state).toBe("closed");
      expect(health.circuitBreaker.totalRequests).toBe(1);
      expect(health.cache.oracleRefreshes).toBe(1);
    });
  });

  describe("defaultOracleClient", () => {
    it("computes cross rates from USD anchors", async () => {
      await expect(defaultOracleClient("USD", "XLM")).resolves.toBeCloseTo(2.5);
      await expect(defaultOracleClient("EUR", "XLM")).resolves.toBeCloseTo(1.08 / 0.4);
      await expect(defaultOracleClient("BTC", "ETH")).resolves.toBeCloseTo(45000 / 2500);
      await expect(defaultOracleClient("USDC", "USD")).resolves.toBe(1);
    });

    it("throws for unsupported currencies", async () => {
      await expect(defaultOracleClient("XYZ", "USD")).rejects.toThrow(/No rate available/);
      await expect(defaultOracleClient("USD", "JPY")).rejects.toThrow(/No rate available/);
    });
  });
});
