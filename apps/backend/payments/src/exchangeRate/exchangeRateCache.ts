/**
 * Automated Currency Conversion Rate Cache with Circuit Breaker (Issue #379)
 *
 * Cache fiat-to-crypto exchange rates with fallback to last known good rates
 * if the rate oracle API is unreachable.
 *
 * Design (mirrors this repo's existing patterns):
 * - Redis-backed cache: rates are persisted under
 *   `exchange:rate:<BASE>:<QUOTE>` (fresh copy) and
 *   `exchange:rate:last-good:<BASE>:<QUOTE>` (stale fallback copy, longer
 *   TTL) — following the same "singleton client + in-memory stub under
 *   NODE_ENV=test/MOCK_REDIS=true" convention as the escrow funding locks
 *   (src/validation.ts) so unit tests never need a live Redis.
 * - Circuit breaker: oracle refreshes go through
 *   src/exchangeRate/circuitBreaker.ts (same pattern as
 *   escrow/circuitBreaker.ts #353) so an unreachable oracle opens the
 *   circuit instead of stalling every read.
 * - Stale fallback: when the circuit is open OR the oracle call fails,
 *   readers get the last known good rate (marked `stale: true`) rather
 *   than an error — payments keep working while the oracle is down.
 *
 * Scope note: like the rest of this workspace, the default oracle client is
 * a deterministic stub (see `defaultOracleClient`) — wiring a specific
 * commercial oracle provider is configuration, not new logic.
 */

import { createRequire } from "node:module";
import { createLogger } from "@delegolabs/utils";
import {
  getRateOracleCircuitBreaker,
  CircuitBreakerOpenError,
  type CircuitBreakerStats,
} from "./circuitBreaker.js";

const log = createLogger(
  "payments:exchange-rate-cache",
  process.env.LOG_LEVEL ?? "info"
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A cached exchange-rate record, as specified in Issue #379. */
export interface ExchangeRateRecord {
  baseCurrency: string;
  quoteCurrency: string;
  rate: number;
  cachedAt: Date;
  source: string;
}

/** Result of a cache read — `stale` distinguishes fallback hits from fresh hits. */
export interface ExchangeRateResult extends ExchangeRateRecord {
  /** True when the value came from the last-known-good fallback copy. */
  stale: boolean;
}

/** Fetches a fresh rate from an upstream oracle. Throwing signals oracle failure. */
export type RateOracleClient = (
  baseCurrency: string,
  quoteCurrency: string
) => Promise<number>;

export interface ExchangeRateCacheConfig {
  /** TTL (seconds) for the fresh rate copy. Default: 300 (5 min). */
  freshTtlSeconds: number;
  /** TTL (seconds) for the last-known-good fallback copy. Default: 86400 (24 h). */
  staleTtlSeconds: number;
  /** Reject oracle rates outside (0, this]. Default: 100000. */
  maxSaneRate: number;
}

export interface CacheMetrics {
  hits: number;
  staleFallbackHits: number;
  misses: number;
  oracleRefreshes: number;
  oracleFailures: number;
}

// ---------------------------------------------------------------------------
// Redis client (same convention as src/validation.ts escrow funding locks)
// ---------------------------------------------------------------------------

/** Minimal Redis command surface the cache needs. */
export type RateCacheRedisClient = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "EX", ttlSeconds: number): Promise<string | null>;
  del(key: string): Promise<number>;
};

let _redisClient: RateCacheRedisClient | null = null;

/** In-memory stub so unit tests (NODE_ENV=test / MOCK_REDIS=true / CI) run without Redis. */
function makeInMemoryRateRedis(): RateCacheRedisClient {
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

function getRateRedisClient(): RateCacheRedisClient {
  if (_redisClient) return _redisClient;

  const isTest =
    process.env.NODE_ENV === "test" ||
    process.env.MOCK_REDIS === "true" ||
    process.env.CI === "true";

  if (isTest) {
    log.info("Using in-memory Redis stub for exchange-rate cache");
    _redisClient = makeInMemoryRateRedis();
  } else {
    try {
      // Use createRequire so this ESM module can load CommonJS ioredis safely
      // (same pattern as src/events/index.ts and src/validation.ts).
      const _require = createRequire(import.meta.url);
      const { Redis } = _require("ioredis") as any;
      _redisClient = new Redis(
        process.env.REDIS_URL ?? "redis://localhost:6379"
      ) as unknown as RateCacheRedisClient;
    } catch {
      log.warn("ioredis unavailable — falling back to in-memory rate cache");
      _redisClient = makeInMemoryRateRedis();
    }
  }

  return _redisClient!;
}

export function _setRateRedisClientForTesting(client: RateCacheRedisClient): void {
  _redisClient = client;
}

export function _resetRateRedisClientForTesting(): void {
  _redisClient = null;
}

// ---------------------------------------------------------------------------
// Key helpers + serialization
// ---------------------------------------------------------------------------

export function rateKey(baseCurrency: string, quoteCurrency: string): string {
  return `exchange:rate:${baseCurrency.toUpperCase()}:${quoteCurrency.toUpperCase()}`;
}

export function lastGoodRateKey(baseCurrency: string, quoteCurrency: string): string {
  return `exchange:rate:last-good:${baseCurrency.toUpperCase()}:${quoteCurrency.toUpperCase()}`;
}

function serializeRecord(record: ExchangeRateRecord): string {
  return JSON.stringify({ ...record, cachedAt: record.cachedAt.toISOString() });
}

function deserializeRecord(raw: string): ExchangeRateRecord {
  const parsed = JSON.parse(raw) as Omit<ExchangeRateRecord, "cachedAt"> & {
    cachedAt: string;
  };
  return { ...parsed, cachedAt: new Date(parsed.cachedAt) };
}

// ---------------------------------------------------------------------------
// Metrics + config
// ---------------------------------------------------------------------------

const metrics: CacheMetrics = {
  hits: 0,
  staleFallbackHits: 0,
  misses: 0,
  oracleRefreshes: 0,
  oracleFailures: 0,
};

export function getCacheMetrics(): CacheMetrics {
  return { ...metrics };
}

export function resetCacheMetrics(): void {
  metrics.hits = 0;
  metrics.staleFallbackHits = 0;
  metrics.misses = 0;
  metrics.oracleRefreshes = 0;
  metrics.oracleFailures = 0;
}

export function exchangeRateConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env
): ExchangeRateCacheConfig {
  return {
    freshTtlSeconds: parseInt(env.EXCHANGE_RATE_CACHE_TTL_SECONDS ?? "300", 10),
    staleTtlSeconds: parseInt(env.EXCHANGE_RATE_STALE_TTL_SECONDS ?? "86400", 10),
    maxSaneRate: parseInt(env.EXCHANGE_RATE_MAX_SANE_RATE ?? "100000", 10),
  };
}

let config: ExchangeRateCacheConfig = exchangeRateConfigFromEnv();

export function getExchangeRateCacheConfig(): ExchangeRateCacheConfig {
  return { ...config };
}

export function setExchangeRateCacheConfig(
  overrides: Partial<ExchangeRateCacheConfig>
): void {
  config = { ...config, ...overrides };
}

export function resetExchangeRateCacheConfig(): void {
  config = exchangeRateConfigFromEnv();
}

// ---------------------------------------------------------------------------
// Default oracle client (deterministic stub — swap via config in production)
// ---------------------------------------------------------------------------

/**
 * Deterministic offline oracle. In production set EXCHANGE_RATE_ORACLE_URL and
 * an HTTP-backed client (or inject one via `setRateOracleClient`) — the cache
 * and circuit breaker logic is provider-agnostic.
 */
export const defaultOracleClient: RateOracleClient = async (
  baseCurrency,
  quoteCurrency
) => {
  const base = baseCurrency.toUpperCase();
  const quote = quoteCurrency.toUpperCase();

  // Anchors: XLM≈$0.40, USDC=$1, BTC=$45000, ETH=$2500 (fiat pairs = 1)
  const usdPrices: Record<string, number> = {
    USD: 1,
    EUR: 1.08,
    GBP: 1.27,
    XLM: 0.4,
    USDC: 1,
    BTC: 45000,
    ETH: 2500,
  };

  const baseUsd = usdPrices[base];
  const quoteUsd = usdPrices[quote];
  if (baseUsd === undefined || quoteUsd === undefined || quoteUsd === 0) {
    throw new Error(`No rate available for ${base}/${quote}`);
  }
  return baseUsd / quoteUsd;
};

let oracleClient: RateOracleClient = defaultOracleClient;

export function setRateOracleClient(client: RateOracleClient): void {
  oracleClient = client;
}

export function resetRateOracleClient(): void {
  oracleClient = defaultOracleClient;
}

// ---------------------------------------------------------------------------
// Cache write path
// ---------------------------------------------------------------------------

/**
 * Fetch a fresh rate from the oracle (through the circuit breaker) and write
 * it to both the fresh key and the last-known-good key.
 *
 * Throws when the circuit is open or the oracle fails — callers who just want
 * "best effort refresh" should use `getExchangeRate` instead.
 */
export async function refreshRate(
  baseCurrency: string,
  quoteCurrency: string
): Promise<ExchangeRateRecord> {
  const base = baseCurrency.toUpperCase();
  const quote = quoteCurrency.toUpperCase();

  if (base === quote) {
    return {
      baseCurrency: base,
      quoteCurrency: quote,
      rate: 1,
      cachedAt: new Date(),
      source: "identity",
    };
  }

  const breaker = getRateOracleCircuitBreaker();
  let rate: number;
  try {
    rate = await breaker.execute(() => oracleClient(base, quote));
  } catch (err) {
    // Oracle unreachable / circuit open — count it so metrics reflect reality.
    metrics.oracleFailures++;
    throw err;
  }

  if (!Number.isFinite(rate) || rate <= 0 || rate > config.maxSaneRate) {
    metrics.oracleFailures++;
    throw new Error(
      `Oracle returned an implausible rate for ${base}/${quote}: ${rate}`
    );
  }

  const record: ExchangeRateRecord = {
    baseCurrency: base,
    quoteCurrency: quote,
    rate,
    cachedAt: new Date(),
    source: "oracle",
  };

  const redis = getRateRedisClient();
  await redis.set(rateKey(base, quote), serializeRecord(record), "EX", config.freshTtlSeconds);
  // Last-known-good copy outlives the fresh copy so stale fallback can serve
  // long oracle outages.
  await redis.set(
    lastGoodRateKey(base, quote),
    serializeRecord(record),
    "EX",
    config.staleTtlSeconds
  );

  metrics.oracleRefreshes++;
  log.info("Exchange rate refreshed", { base, quote, rate });
  return record;
}

// ---------------------------------------------------------------------------
// Cache read path (fresh → stale fallback → miss/refresh)
// ---------------------------------------------------------------------------

/**
 * Read a rate:
 * 1. Fresh cache hit → return it (`stale: false`).
 * 2. Fresh miss → try the oracle refresh (circuit-breaker protected).
 *    - Success → cached, returned (`stale: false`).
 *    - Failure/open circuit → serve the last-known-good copy (`stale: true`).
 * 3. No cached copy at all and the oracle is unreachable → throws
 *    ExchangeRateUnavailableError.
 */
export async function getExchangeRate(
  baseCurrency: string,
  quoteCurrency: string
): Promise<ExchangeRateResult> {
  const base = baseCurrency.toUpperCase();
  const quote = quoteCurrency.toUpperCase();
  const redis = getRateRedisClient();

  if (base === quote) {
    return {
      baseCurrency: base,
      quoteCurrency: quote,
      rate: 1,
      cachedAt: new Date(),
      source: "identity",
      stale: false,
    };
  }

  // 1. Fresh copy
  const fresh = await redis.get(rateKey(base, quote));
  if (fresh !== null) {
    metrics.hits++;
    const record = deserializeRecord(fresh);
    return { ...record, stale: false };
  }

  // 2. Fresh miss → attempt an oracle refresh
  try {
    const record = await refreshRate(base, quote);
    return { ...record, stale: false };
  } catch (err) {
    if (err instanceof CircuitBreakerOpenError) {
      log.warn("Rate oracle circuit breaker open — serving last known good rate", {
        base,
        quote,
      });
    } else {
      metrics.oracleFailures++;
      log.error("Rate oracle refresh failed — falling back to last known good rate", {
        base,
        quote,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 3. Stale fallback
  const lastGood = await redis.get(lastGoodRateKey(base, quote));
  if (lastGood !== null) {
    metrics.staleFallbackHits++;
    const record = deserializeRecord(lastGood);
    return { ...record, stale: true };
  }

  metrics.misses++;
  throw new ExchangeRateUnavailableError(
    `No exchange rate available for ${base}/${quote} — cache miss, oracle unreachable, and no last-known-good rate cached`
  );
}

export class ExchangeRateUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExchangeRateUnavailableError";
  }
}

// ---------------------------------------------------------------------------
// Administrative helpers
// ---------------------------------------------------------------------------

/** Drop both copies for a pair (e.g. a merchant reports a wildly wrong rate). */
export async function invalidateRate(
  baseCurrency: string,
  quoteCurrency: string
): Promise<number> {
  const base = baseCurrency.toUpperCase();
  const quote = quoteCurrency.toUpperCase();
  const redis = getRateRedisClient();
  const deleted =
    (await redis.del(rateKey(base, quote))) +
    (await redis.del(lastGoodRateKey(base, quote)));
  return deleted;
}

/** Circuit breaker stats + cache metrics in one snapshot (for /health or admin routes). */
export function getExchangeRateHealth(): {
  circuitBreaker: CircuitBreakerStats;
  cache: CacheMetrics;
} {
  return {
    circuitBreaker: getRateOracleCircuitBreaker().getStats(),
    cache: getCacheMetrics(),
  };
}

// ---------------------------------------------------------------------------
// Background auto-refresh scheduler
// ---------------------------------------------------------------------------

export interface RateRefreshSchedulerHandle {
  stop(): void;
}

/**
 * Periodically refresh all configured fiat→crypto pairs so the cache never
 * goes cold for the pairs the platform actually quotes.
 *
 * Pairs come from EXCHANGE_RATE_PAIRS (comma-separated `BASE/QUOTE`, default
 * "USD/XLM,EUR/XLM,USD/BTC,USD/ETH,USD/USDC"). Interval via
 * EXCHANGE_RATE_REFRESH_INTERVAL_SECONDS (default 300; "0" disables).
 */
export function startRateRefreshScheduler(
  pairs?: Array<[string, string]>
): RateRefreshSchedulerHandle {
  const intervalSeconds = parseInt(
    process.env.EXCHANGE_RATE_REFRESH_INTERVAL_SECONDS ?? "300",
    10
  );

  if (intervalSeconds <= 0) {
    log.info("Exchange rate refresh scheduler disabled");
    return { stop: () => {} };
  }

  const configuredPairs: Array<[string, string]> =
    pairs ??
    (process.env.EXCHANGE_RATE_PAIRS ?? "USD/XLM,EUR/XLM,USD/BTC,USD/ETH,USD/USDC")
      .split(",")
      .map((pair) => pair.trim())
      .filter((pair) => pair.includes("/"))
      .map((pair) => {
        const [base, quote] = pair.split("/");
        return [base.trim().toUpperCase(), quote.trim().toUpperCase()] as [string, string];
      });

  log.info("Starting exchange rate refresh scheduler", {
    intervalSeconds,
    pairs: configuredPairs.map(([b, q]) => `${b}/${q}`),
  });

  const refreshAll = async (): Promise<void> => {
    for (const [base, quote] of configuredPairs) {
      try {
        await refreshRate(base, quote);
      } catch (err) {
        // Expected while the oracle is down — the circuit breaker + stale
        // fallback handle readers; just log so operators can see the cadence.
        log.warn("Scheduled rate refresh failed", {
          base,
          quote,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  };

  void refreshAll().catch(() => {}); // initial refresh
  const timer = setInterval(() => {
    void refreshAll().catch(() => {});
  }, intervalSeconds * 1000);
  timer.unref();

  return {
    stop: () => {
      clearInterval(timer);
      log.info("Exchange rate refresh scheduler stopped");
    },
  };
}
