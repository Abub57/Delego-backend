/**
 * Cross-package unit tests for the Issue #379 exchange-rate cache
 * (circuit breaker + Redis-backed caching + stale fallback).
 *
 * Imports compiled dist output, matching this workspace's convention
 * (see payments-validation.test.js). Redis stays mocked: the cache module
 * falls back to its in-memory stub under NODE_ENV=test (see
 * apps/backend/payments/src/exchangeRate/exchangeRateCache.ts), so these
 * tests exercise the real cache/fallback/circuit-breaker logic without a
 * live Redis. Real-Redis behavior is covered by the integration suite
 * (tests/integration/src/exchange-rate-cache.integration.test.js).
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  getExchangeRate,
  refreshRate,
  invalidateRate,
  rateKey,
  lastGoodRateKey,
  getCacheMetrics,
  resetCacheMetrics,
  getExchangeRateHealth,
  getRateOracleCircuitBreaker,
  setRateOracleClient,
  resetRateOracleClient,
  setRateOracleCircuitBreaker,
  resetRateOracleCircuitBreakerForTesting,
  _setRateRedisClientForTesting,
  _resetRateRedisClientForTesting,
  CircuitBreaker,
  CircuitBreakerOpenError,
  ExchangeRateUnavailableError,
} from "../../../apps/backend/payments/dist/src/exchangeRate/index.js";

/** Minimal in-memory Redis double matching the cache's command surface. */
function makeMemoryRedis() {
  const store = new Map();
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

function seedRateRecord(rate, source = "oracle") {
  return JSON.stringify({
    baseCurrency: "USD",
    quoteCurrency: "XLM",
    rate,
    cachedAt: new Date().toISOString(),
    source,
  });
}

describe("exchange rate cache with circuit breaker (#379)", () => {
  beforeEach(() => {
    resetCacheMetrics();
    resetRateOracleClient();
    resetRateOracleCircuitBreakerForTesting();
    setRateOracleCircuitBreaker(new CircuitBreaker({ failureThreshold: 3 }));
  });

  it("builds normalized fresh and last-good cache keys", () => {
    assert.equal(rateKey("usd", "xlm"), "exchange:rate:USD:XLM");
    assert.equal(lastGoodRateKey("EUR", "BTC"), "exchange:rate:last-good:EUR:BTC");
  });

  it("caches fresh and last-known-good copies on refresh", async () => {
    const redis = makeMemoryRedis();
    _setRateRedisClientForTesting(redis);
    setRateOracleClient(async () => 0.4);

    const record = await refreshRate("USD", "XLM");

    assert.equal(record.rate, 0.4);
    assert.equal(record.source, "oracle");
    assert.ok(redis.store.has(rateKey("USD", "XLM")));
    assert.ok(redis.store.has(lastGoodRateKey("USD", "XLM")));
    assert.equal(getCacheMetrics().oracleRefreshes, 1);

    _resetRateRedisClientForTesting();
  });

  it("serves fresh hits without calling the oracle", async () => {
    const redis = makeMemoryRedis();
    _setRateRedisClientForTesting(redis);
    await redis.set(rateKey("USD", "XLM"), seedRateRecord(0.4), "EX", 300);

    let oracleCalls = 0;
    setRateOracleClient(async () => {
      oracleCalls++;
      return 999;
    });

    const result = await getExchangeRate("USD", "XLM");

    assert.equal(result.rate, 0.4);
    assert.equal(result.stale, false);
    assert.equal(oracleCalls, 0);
    assert.equal(getCacheMetrics().hits, 1);

    _resetRateRedisClientForTesting();
  });

  it("falls back to the last known good rate when the oracle fails", async () => {
    const redis = makeMemoryRedis();
    _setRateRedisClientForTesting(redis);

    // Only the last-good copy exists — the fresh copy has expired (outage scenario).
    await redis.set(lastGoodRateKey("USD", "XLM"), seedRateRecord(0.39), "EX", 86400);

    setRateOracleClient(async () => {
      throw new Error("oracle unreachable");
    });

    const result = await getExchangeRate("USD", "XLM");

    assert.equal(result.rate, 0.39);
    assert.equal(result.stale, true, "fallback result must be flagged stale");
    assert.equal(getCacheMetrics().staleFallbackHits, 1);

    _resetRateRedisClientForTesting();
  });

  it("rejects with ExchangeRateUnavailableError when nothing is cached and the oracle is down", async () => {
    const redis = makeMemoryRedis();
    _setRateRedisClientForTesting(redis);

    setRateOracleClient(async () => {
      throw new Error("oracle unreachable");
    });

    await assert.rejects(() => getExchangeRate("USD", "XLM"), ExchangeRateUnavailableError);
    assert.equal(getCacheMetrics().misses, 1);

    _resetRateRedisClientForTesting();
  });

  it("serves stale rates while the circuit is open without calling the oracle", async () => {
    const redis = makeMemoryRedis();
    _setRateRedisClientForTesting(redis);
    await redis.set(lastGoodRateKey("USD", "XLM"), seedRateRecord(0.38), "EX", 86400);

    // Open the circuit: threshold 1, always-failing oracle
    setRateOracleCircuitBreaker(new CircuitBreaker({ failureThreshold: 1 }));
    setRateOracleClient(async () => {
      throw new Error("oracle unreachable");
    });
    await assert.rejects(() => refreshRate("USD", "XLM"), Error);
    assert.equal(getRateOracleCircuitBreaker().getState(), "open");

    let oracleCalls = 0;
    setRateOracleClient(async () => {
      oracleCalls++;
      return 123;
    });

    const result = await getExchangeRate("USD", "XLM");

    assert.equal(result.rate, 0.38);
    assert.equal(result.stale, true);
    assert.equal(oracleCalls, 0, "open circuit must short-circuit oracle calls");
    assert.ok(getRateOracleCircuitBreaker().getStats().totalRejections >= 1);

    _resetRateRedisClientForTesting();
  });

  it("returns identity rate 1 for same-currency pairs", async () => {
    const redis = makeMemoryRedis();
    _setRateRedisClientForTesting(redis);

    const result = await getExchangeRate("XLM", "xlm");
    assert.equal(result.rate, 1);
    assert.equal(result.stale, false);

    _resetRateRedisClientForTesting();
  });

  it("invalidates both copies for a pair", async () => {
    const redis = makeMemoryRedis();
    _setRateRedisClientForTesting(redis);
    await redis.set(rateKey("USD", "XLM"), seedRateRecord(0.4), "EX", 300);
    await redis.set(lastGoodRateKey("USD", "XLM"), seedRateRecord(0.4), "EX", 86400);

    const deleted = await invalidateRate("USD", "XLM");
    assert.equal(deleted, 2);
    assert.equal(redis.store.size, 0);

    _resetRateRedisClientForTesting();
  });

  it("exposes circuit breaker and cache metrics together for health reporting", async () => {
    const redis = makeMemoryRedis();
    _setRateRedisClientForTesting(redis);
    setRateOracleClient(async () => 0.4);
    await refreshRate("USD", "XLM");

    const health = getExchangeRateHealth();
    assert.equal(health.circuitBreaker.state, "closed");
    assert.equal(health.cache.oracleRefreshes, 1);

    _resetRateRedisClientForTesting();
  });

  it("exports CircuitBreakerOpenError as a distinct error type", () => {
    const err = new CircuitBreakerOpenError("open");
    assert.equal(err.name, "CircuitBreakerOpenError");
    assert.ok(err instanceof Error);
  });
});
