export interface ExchangeRateRecord {
  baseCurrency: string;
  quoteCurrency: string;
  rate: number;
  cachedAt: Date;
  source: string;
}

export interface RedisLikeClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode?: string, ttlSeconds?: number): Promise<unknown>;
}

export interface OracleClient {
  fetchRate(baseCurrency: string, quoteCurrency: string): Promise<number>;
}

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  resetTimeoutMs?: number;
  cacheTtlSeconds?: number;
  staleTtlSeconds?: number;
  source?: string;
}

const DEFAULT_FAILURE_THRESHOLD = 5;
const DEFAULT_RESET_TIMEOUT_MS = 30_000;
const DEFAULT_CACHE_TTL_SECONDS = 60;
const DEFAULT_STALE_TTL_SECONDS = 86_400;
const DEFAULT_SOURCE = 'oracle';

export class ExchangeRateCache {
  private readonly redis: RedisLikeClient;
  private readonly oracle: OracleClient;
  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly cacheTtlSeconds: number;
  private readonly staleTtlSeconds: number;
  private readonly source: string;

  private state: CircuitState = 'closed';
  private failureCount = 0;
  private openedAt = 0;

  constructor(
    redis: RedisLikeClient,
    oracle: OracleClient,
    options: CircuitBreakerOptions = {},
  ) {
    this.redis = redis;
    this.oracle = oracle;
    this.failureThreshold = options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.resetTimeoutMs = options.resetTimeoutMs ?? DEFAULT_RESET_TIMEOUT_MS;
    this.cacheTtlSeconds = options.cacheTtlSeconds ?? DEFAULT_CACHE_TTL_SECONDS;
    this.staleTtlSeconds = options.staleTtlSeconds ?? DEFAULT_STALE_TTL_SECONDS;
    this.source = options.source ?? DEFAULT_SOURCE;
  }

  private freshKey(baseCurrency: string, quoteCurrency: string): string {
    return `exchange-rate:${baseCurrency}:${quoteCurrency}`;
  }

  private staleKey(baseCurrency: string, quoteCurrency: string): string {
    return `exchange-rate:stale:${baseCurrency}:${quoteCurrency}`;
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

  private async writeRecord(key: string, record: ExchangeRateRecord, ttlSeconds: number): Promise<void> {
    await this.redis.set(key, JSON.stringify(record), 'EX', ttlSeconds);
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

  async getRate(baseCurrency: string, quoteCurrency: string): Promise<ExchangeRateRecord> {
    const fresh = await this.readRecord(this.freshKey(baseCurrency, quoteCurrency));
    if (fresh) {
      return fresh;
    }

    if (this.canAttempt()) {
      try {
        const rate = await this.oracle.fetchRate(baseCurrency, quoteCurrency);
        const record: ExchangeRateRecord = {
          baseCurrency,
          quoteCurrency,
          rate,
          cachedAt: new Date(),
          source: this.source,
        };
        await this.writeRecord(this.freshKey(baseCurrency, quoteCurrency), record, this.cacheTtlSeconds);
        await this.writeRecord(this.staleKey(baseCurrency, quoteCurrency), record, this.staleTtlSeconds);
        this.onSuccess();
        return record;
      } catch {
        this.onFailure();
      }
    }

    const stale = await this.readRecord(this.staleKey(baseCurrency, quoteCurrency));
    if (stale) {
      return stale;
    }

    throw new Error(
      `Exchange rate unavailable for ${baseCurrency}/${quoteCurrency}: oracle unreachable and no cached rate`,
    );
  }

  getState(): CircuitState {
    return this.state;
  }
}
