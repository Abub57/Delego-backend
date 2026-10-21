import { Redis } from 'ioredis';

export interface ExchangeRateRecord {
  baseCurrency: string;
  quoteCurrency: string;
  rate: number;
  cachedAt: Date;
  source: string;
}

export interface OracleClient {
  fetchRate(baseCurrency: string, quoteCurrency: string): Promise<number>;
}

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  resetTimeoutMs?: number;
}

export interface ExchangeRateCacheOptions {
  redis: Redis;
  oracle: OracleClient;
  ttlSeconds?: number;
  staleTtlSeconds?: number;
  circuitBreaker?: CircuitBreakerOptions;
  keyPrefix?: string;
}

type CircuitState = 'closed' | 'open' | 'half-open';

const DEFAULT_TTL_SECONDS = 60;
const DEFAULT_STALE_TTL_SECONDS = 60 * 60 * 24;
const DEFAULT_FAILURE_THRESHOLD = 5;
const DEFAULT_RESET_TIMEOUT_MS = 30_000;

/**
 * Caches fiat-to-crypto exchange rates in Redis with a circuit breaker around
 * the oracle API. When the oracle is unreachable (or the circuit is open), the
 * last known good rate is served from the stale cache.
 */
export class ExchangeRateCache {
  private readonly redis: Redis;
  private readonly oracle: OracleClient;
  private readonly ttlSeconds: number;
  private readonly staleTtlSeconds: number;
  private readonly keyPrefix: string;
  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;

  private state: CircuitState = 'closed';
  private failureCount = 0;
  private openedAt = 0;

  constructor(options: ExchangeRateCacheOptions) {
    this.redis = options.redis;
    this.oracle = options.oracle;
    this.ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    this.staleTtlSeconds = options.staleTtlSeconds ?? DEFAULT_STALE_TTL_SECONDS;
    this.keyPrefix = options.keyPrefix ?? 'exchange-rate';
    this.failureThreshold =
      options.circuitBreaker?.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.resetTimeoutMs =
      options.circuitBreaker?.resetTimeoutMs ?? DEFAULT_RESET_TIMEOUT_MS;
  }

  async getRate(baseCurrency: string, quoteCurrency: string): Promise<ExchangeRateRecord> {
    const base = baseCurrency.toUpperCase();
    const quote = quoteCurrency.toUpperCase();

    const fresh = await this.readRecord(this.freshKey(base, quote));
    if (fresh) {
      return fresh;
    }

    if (this.canAttemptOracle()) {
      try {
        const rate = await this.oracle.fetchRate(base, quote);
        const record: ExchangeRateRecord = {
          baseCurrency: base,
          quoteCurrency: quote,
          rate,
          cachedAt: new Date(),
          source: 'oracle',
        };
        await this.writeRecord(record);
        this.onSuccess();
        return record;
      } catch (error) {
        this.onFailure();
      }
    }

    const stale = await this.readRecord(this.staleKey(base, quote));
    if (stale) {
      return { ...stale, source: `${stale.source}:stale` };
    }

    throw new Error(
      `No exchange rate available for ${base}/${quote}: oracle unreachable and no cached rate`,
    );
  }

  private canAttemptOracle(): boolean {
    if (this.state === 'closed') {
      return true;
    }
    if (this.state === 'open') {
      if (Date.now() - this.openedAt >= this.resetTimeoutMs) {
        this.state = 'half-open';
        return true;
      }
      return false;
    }
    // half-open: allow a single probe request
    return true;
  }

  private onSuccess(): void {
    this.failureCount = 0;
    this.state = 'closed';
  }

  private onFailure(): void {
    this.failureCount += 1;
    if (this.state === 'half-open' || this.failureCount >= this.failureThreshold) {
      this.state = 'open';
      this.openedAt = Date.now();
    }
  }

  private async writeRecord(record: ExchangeRateRecord): Promise<void> {
    const payload = JSON.stringify(record);
    const freshKey = this.freshKey(record.baseCurrency, record.quoteCurrency);
    const staleKey = this.staleKey(record.baseCurrency, record.quoteCurrency);
    await this.redis
      .multi()
      .set(freshKey, payload, 'EX', this.ttlSeconds)
      .set(staleKey, payload, 'EX', this.staleTtlSeconds)
      .exec();
  }

  private async readRecord(key: string): Promise<ExchangeRateRecord | null> {
    const raw = await this.redis.get(key);
    if (!raw) {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as ExchangeRateRecord;
      return { ...parsed, cachedAt: new Date(parsed.cachedAt) };
    } catch {
      return null;
    }
  }

  private freshKey(base: string, quote: string): string {
    return `${this.keyPrefix}:fresh:${base}:${quote}`;
  }

  private staleKey(base: string, quote: string): string {
    return `${this.keyPrefix}:stale:${base}:${quote}`;
  }
}
