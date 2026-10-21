/**
 * Unit tests for the Issue #379 background rate-refresh scheduler.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  startRateRefreshScheduler,
  setRateOracleClient,
  resetRateOracleClient,
  _setRateRedisClientForTesting,
  _resetRateRedisClientForTesting,
  type RateCacheRedisClient,
} from "./exchangeRateCache.js";
import {
  setRateOracleCircuitBreaker,
  resetRateOracleCircuitBreakerForTesting,
} from "./circuitBreaker.js";

function makeFakeRedis(): RateCacheRedisClient {
  const store = new Map<string, { value: string; expiresAt: number }>();
  return {
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

describe("rate refresh scheduler (Issue #379)", () => {
  beforeEach(() => {
    _setRateRedisClientForTesting(makeFakeRedis());
    resetRateOracleCircuitBreakerForTesting();
    resetRateOracleClient();
  });

  afterEach(() => {
    _resetRateRedisClientForTesting();
  });

  it("refreshes all configured pairs on start", async () => {
    const oracle = vi.fn(async (base: string, quote: string) =>
      base === "USD" && quote === "XLM" ? 2.5 : 1
    );
    setRateOracleClient(oracle);

    const handle = startRateRefreshScheduler([
      ["USD", "XLM"],
      ["EUR", "XLM"],
    ]);

    // The initial refresh runs asynchronously — yield to the microtask queue.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(oracle).toHaveBeenCalledTimes(2);
    expect(oracle).toHaveBeenCalledWith("USD", "XLM");
    expect(oracle).toHaveBeenCalledWith("EUR", "XLM");

    handle.stop();
  });

  it("keeps running after individual pair failures (does not throw)", async () => {
    let calls = 0;
    setRateOracleClient(async (base) => {
      calls++;
      if (base === "USD") throw new Error("partial outage");
      return 1;
    });

    const handle = startRateRefreshScheduler([
      ["USD", "XLM"],
      ["EUR", "XLM"],
    ]);

    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    // The failing pair did not abort the loop — EUR was still attempted.
    expect(calls).toBe(2);

    handle.stop();
  });

  it("stop() is idempotent and safe to call multiple times", () => {
    const handle = startRateRefreshScheduler([["USD", "XLM"]]);
    handle.stop();
    expect(() => handle.stop()).not.toThrow();
  });

  it("normalizes mixed-case pair input", async () => {
    const oracle = vi.fn(async () => 1);
    setRateOracleClient(oracle);

    const handle = startRateRefreshScheduler([["usd", "xlm"]]);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(oracle).toHaveBeenCalledWith("USD", "XLM");
    handle.stop();
  });
});
