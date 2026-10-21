/**
 * Integration coverage (Issue #379): exchange-rate cache against real Redis.
 *
 * The unit suites run with NODE_ENV=test, which forces the exchange-rate
 * cache onto its in-memory Redis stub — the same pattern as the escrow
 * funding locks and the gateway rate limiter. That means real Redis
 * behavior (TTL expiry, key persistence across "processes", GET/SET/DEL
 * semantics) is never exercised for the rate cache. This suite follows the
 * rate-limit integration test's seam: it injects a real ioredis connection
 * via the cache module's `_setRateRedisClientForTesting` hook, so the real
 * read/write/fallback logic runs against actual Redis commands.
 *
 * Covers:
 * - fresh + last-known-good keys are written with TTLs on refresh
 * - fresh hits are served without oracle calls
 * - after the fresh key expires in real Redis, the last-known-good copy is
 *   served (stale fallback) when the oracle is unreachable
 * - once the last-known-good key's real TTL lapses, reads fail with
 *   ExchangeRateUnavailableError (oracle down)
 * - invalidation deletes both keys in real Redis
 *
 * Requires a reachable Redis and a built payments service; skips itself
 * otherwise (mirroring rate-limit.integration.test.js).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";
import { isRedisReachable, isServiceBuilt, REDIS_URL, uniqueId } from "./helpers/infra.js";

const redisAvailable = await isRedisReachable();
if (!redisAvailable) {
  console.log(
    `[tests] Skipping exchange-rate cache integration tests — no Redis reachable at ${REDIS_URL} (start it with 'docker compose up -d redis')`,
  );
}

const paymentsBuilt = isServiceBuilt("payments");
if (redisAvailable && !paymentsBuilt) {
  console.log(
    "[tests] Skipping exchange-rate cache integration tests — apps/backend/payments/dist not found (run `pnpm --filter @delegolabs/payments build` first)",
  );
}

const suite = redisAvailable && paymentsBuilt ? describe : describe.skip;

suite("exchange rate cache against real Redis (#379)", () => {
  let redis;
  let cache;

  before(async () => {
    redis = new Redis(REDIS_URL);
    cache = await import("../../../apps/backend/payments/dist/src/exchangeRate/index.js");
    cache._setRateRedisClientForTesting(redis);
    cache.resetRateOracleClient();
    cache.resetRateOracleCircuitBreakerForTesting();
    cache.resetCacheMetrics();
  });

  after(async () => {
    cache._resetRateRedisClientForTesting();
    redis.disconnect();
  });

  it("writes fresh and last-known-good copies with TTLs on refresh", async () => {
    const base = uniqueId("USD");
    const quote = uniqueId("XLM");

    cache.setRateOracleClient(async () => 0.4);
    const record = await cache.refreshRate(base, quote);

    assert.equal(record.rate, 0.4);

    // Keys are upper-cased, so the uniqueId suffix keeps test runs independent
    // while the BASE/QUOTE normalization still applies.
    const freshKey = cache.rateKey(base, quote);
    const lastGoodKey = cache.lastGoodRateKey(base, quote);

    const freshTtl = await redis.ttl(freshKey);
    const lastGoodTtl = await redis.ttl(lastGoodKey);
    assert.ok(freshTtl > 0, "fresh key must exist with a positive real-Redis TTL");
    assert.ok(lastGoodTtl > 0, "last-good key must exist with a positive real-Redis TTL");
    assert.ok(
      lastGoodTtl >= freshTtl,
      "last-known-good copy must outlive the fresh copy",
    );

    const stored = JSON.parse(await redis.get(freshKey));
    assert.equal(stored.rate, 0.4);
    assert.equal(stored.baseCurrency, base.toUpperCase());
    assert.equal(stored.quoteCurrency, quote.toUpperCase());
  });

  it("serves fresh hits from real Redis without calling the oracle", async () => {
    const base = uniqueId("USD");
    const quote = uniqueId("XLM");

    cache.setRateOracleClient(async () => 0.4);
    await cache.refreshRate(base, quote);

    let oracleCalls = 0;
    cache.setRateOracleClient(async () => {
      oracleCalls += 1;
      return 999;
    });

    const result = await cache.getExchangeRate(base, quote);
    assert.equal(result.rate, 0.4);
    assert.equal(result.stale, false);
    assert.equal(oracleCalls, 0, "a fresh cache hit must not reach the oracle");
  });

  it("falls back to the last known good rate after the fresh key expires in real Redis", async () => {
    const base = uniqueId("USD");
    const quote = uniqueId("XLM");

    cache.setRateOracleClient(async () => 0.4);
    await cache.refreshRate(base, quote);

    // Force the fresh key to expire in real Redis immediately (simulates the
    // TTL elapsing while the oracle is down); the last-good key keeps its TTL.
    const freshKey = cache.rateKey(base, quote);
    await redis.del(freshKey);

    cache.setRateOracleClient(async () => {
      throw new Error("oracle unreachable");
    });

    const result = await cache.getExchangeRate(base, quote);
    assert.equal(result.rate, 0.4);
    assert.equal(result.stale, true, "fallback from the last-known-good copy must be flagged stale");
    assert.equal(cache.getCacheMetrics().staleFallbackHits >= 1, true);
  });

  it("fails with ExchangeRateUnavailableError once no copy survives and the oracle is down", async () => {
    const base = uniqueId("USD");
    const quote = uniqueId("XLM");

    cache.setRateOracleClient(async () => {
      throw new Error("oracle unreachable");
    });

    await assert.rejects(
      () => cache.getExchangeRate(base, quote),
      cache.ExchangeRateUnavailableError,
    );
  });

  it("invalidates both copies in real Redis", async () => {
    const base = uniqueId("EUR");
    const quote = uniqueId("XLM");

    cache.setRateOracleClient(async () => 1.08 / 0.4);
    await cache.refreshRate(base, quote);
    assert.ok(await redis.get(cache.rateKey(base, quote)));

    const deleted = await cache.invalidateRate(base, quote);
    assert.equal(deleted, 2);
    assert.equal(await redis.get(cache.rateKey(base, quote)), null);
    assert.equal(await redis.get(cache.lastGoodRateKey(base, quote)), null);
  });

  it("reports health combining circuit breaker stats and cache metrics", async () => {
    const health = cache.getExchangeRateHealth();
    assert.ok(health.circuitBreaker);
    assert.ok(health.cache);
    assert.ok(typeof health.cache.oracleRefreshes === "number");
  });
});
