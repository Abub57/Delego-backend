import Redis from 'ioredis';

export interface ExchangeRateRecord {
  baseCurrency: string;
  quoteCurrency: string;
  rate: number;
  cachedAt: Date;
  source: string;
}

export interface OracleClientOptions {
  redis: Redis;
  /** Fetches a fresh rate from the oracle API. */
  fetchRate: (baseCurrency: string, quoteCurrency: string) => Promise<number>;
  /** Cache TTL in seconds for fresh rates. */
  ttlSeconds?: number;
  /** Number of consecutive failures before the circuit opens. */
  failureThreshold?: number;
  /** How long (ms) the circuit stays open before allowing a half-open probe. */
  resetTimeoutMs?: number;
  /** Source label recorded on cached records. */
  source?: string;
}

type CircuitState = 'closed' | 'open' | 'half-open';

const DEFAULT_TTL_SECONDS = 300;
const DEFAULT_FAILURE_THRESHOLD = 5;
const DEFAULT_RESET_TIMEOUT_MS = 30_000;
const DEFAULT_SOURCE = 'oracle';

/**
 * Caches fiat-to-crypto exchange rates in Redis and wraps oracle API calls
 * with a circuit breaker. When the oracle is unreachable (or the circuit is
 * open) the last known good rate is served from cache.
 */
export class ExchangeRateOracleClient {
  private readonly redis: Redis;
  private readonly fetchRate: OracleClientOptions['fetchRate'];
  private readonly ttlSeconds: number;
  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly source: string;

  private state: CircuitState = 'closed';
  private failureCount = 0;
  private openedAt = 0;

  constructor(options: OracleClientOptions) {
    this.redis = options.redis;
    this.fetchRate = options.fetchRate;
    this.ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    this.failureThreshold = options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.resetTimeoutMs = options.resetTimeoutMs ?? DEFAULT_RESET_TIMEOUT_MS;
    this.source = options.source ?? DEFAULT_SOURCE;
  }

  private cacheKey(baseCurrency: string, quoteCurrency: string): string {
    return `exchange-rate:${baseCurrency.toUpperCase()}:${quoteCurrency.toUpperCase()}`;
  }

  private async readCache(key: string): Promise<ExchangeRateRecord | null> {
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

  private async writeCache(key: string, record: ExchangeRateRecord): Promise<void> {
    await this.redis.set(key, JSON.stringify(record), 'EX', this.ttlSeconds);
  }

  private canAttempt(): boolean {
    if (this.state === 'closed') {
      return true;
    }
    if (this.state === 'open' && Date.now() - this.openedAt >= this.resetTimeoutMs) {
      this.state = 'half-open';
      return true;
    }
    return this.state === 'half-open';
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

  /**
   * Returns the exchange rate for a currency pair, preferring a fresh oracle
   * value and falling back to the last known good cached rate.
   */
  async getRate(baseCurrency: string, quoteCurrency: string): Promise<ExchangeRateRecord> {
    const key = this.cacheKey(baseCurrency, quoteCurrency);
    const cached = await this.readCache(key);

    if (this.canAttempt()) {
      try {
        const rate = await this.fetchRate(baseCurrency, quoteCurrency);
        const record: ExchangeRateRecord = {
          baseCurrency,
          quoteCurrency,
          rate,
          cachedAt: new Date(),
          source: this.source,
        };
        await this.writeCache(key, record);
        this.onSuccess();
        return record;
      } catch (error) {
        this.onFailure();
        if (cached) {
          return cached;
        }
        throw error;
      }
    }

    if (cached) {
      return cached;
    }

    throw new Error(
      `Exchange rate unavailable for ${baseCurrency}/${quoteCurrency}: oracle circuit is open and no cached rate exists`,
    );
  }
}
