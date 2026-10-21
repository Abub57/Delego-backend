import { ExchangeRateRecord } from './exchangeRate.types';
import { ExchangeRateCache } from './exchangeRate.cache';
import { CircuitBreaker } from './circuitBreaker';
import { ExchangeRateService } from './exchangeRate.service';

describe('ExchangeRateRecord', () => {
  it('matches the specified schema', () => {
    const record: ExchangeRateRecord = {
      baseCurrency: 'USD',
      quoteCurrency: 'BTC',
      rate: 0.000025,
      cachedAt: new Date('2024-01-01T00:00:00.000Z'),
      source: 'oracle',
    };

    expect(record.baseCurrency).toBe('USD');
    expect(record.quoteCurrency).toBe('BTC');
    expect(record.rate).toBe(0.000025);
    expect(record.cachedAt).toBeInstanceOf(Date);
    expect(record.source).toBe('oracle');
  });
});

describe('ExchangeRateCache', () => {
  let redis: { get: jest.Mock; set: jest.Mock };
  let cache: ExchangeRateCache;

  beforeEach(() => {
    redis = { get: jest.fn(), set: jest.fn() };
    cache = new ExchangeRateCache(redis as any, 60);
  });

  it('stores a rate with a TTL', async () => {
    const record: ExchangeRateRecord = {
      baseCurrency: 'USD',
      quoteCurrency: 'BTC',
      rate: 0.000025,
      cachedAt: new Date('2024-01-01T00:00:00.000Z'),
      source: 'oracle',
    };

    await cache.set(record);

    expect(redis.set).toHaveBeenCalledWith(
      'exchange-rate:USD:BTC',
      JSON.stringify(record),
      'EX',
      60,
    );
  });

  it('returns a cached rate', async () => {
    const record: ExchangeRateRecord = {
      baseCurrency: 'USD',
      quoteCurrency: 'BTC',
      rate: 0.000025,
      cachedAt: new Date('2024-01-01T00:00:00.000Z'),
      source: 'oracle',
    };
    redis.get.mockResolvedValue(JSON.stringify(record));

    const result = await cache.get('USD', 'BTC');

    expect(redis.get).toHaveBeenCalledWith('exchange-rate:USD:BTC');
    expect(result).toEqual(record);
  });

  it('returns null when no rate is cached', async () => {
    redis.get.mockResolvedValue(null);

    const result = await cache.get('USD', 'BTC');

    expect(result).toBeNull();
  });
});

describe('CircuitBreaker', () => {
  it('opens after repeated failures', async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 1000 });
    const failing = jest.fn().mockRejectedValue(new Error('oracle down'));

    await expect(breaker.execute(failing)).rejects.toThrow('oracle down');
    await expect(breaker.execute(failing)).rejects.toThrow('oracle down');

    expect(breaker.isOpen()).toBe(true);
    await expect(breaker.execute(failing)).rejects.toThrow('Circuit breaker is open');
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it('half-opens and recovers after the reset timeout', async () => {
    jest.useFakeTimers();
    const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 1000 });
    const failing = jest.fn().mockRejectedValue(new Error('oracle down'));

    await expect(breaker.execute(failing)).rejects.toThrow('oracle down');
    expect(breaker.isOpen()).toBe(true);

    jest.advanceTimersByTime(1000);

    const succeeding = jest.fn().mockResolvedValue(0.000025);
    await expect(breaker.execute(succeeding)).resolves.toBe(0.000025);
    expect(breaker.isOpen()).toBe(false);

    jest.useRealTimers();
  });
});

describe('ExchangeRateService', () => {
  let redis: { get: jest.Mock; set: jest.Mock };
  let cache: ExchangeRateCache;
  let oracle: { fetchRate: jest.Mock };
  let service: ExchangeRateService;

  beforeEach(() => {
    redis = { get: jest.fn(), set: jest.fn() };
    cache = new ExchangeRateCache(redis as any, 60);
    oracle = { fetchRate: jest.fn() };
    service = new ExchangeRateService(cache, oracle as any, {
      failureThreshold: 2,
      resetTimeoutMs: 1000,
    });
  });

  it('fetches from the oracle and caches the result', async () => {
    oracle.fetchRate.mockResolvedValue(0.000025);

    const result = await service.getRate('USD', 'BTC');

    expect(oracle.fetchRate).toHaveBeenCalledWith('USD', 'BTC');
    expect(result.rate).toBe(0.000025);
    expect(result.source).toBe('oracle');
    expect(redis.set).toHaveBeenCalled();
  });

  it('returns the cached rate without calling the oracle', async () => {
    const record: ExchangeRateRecord = {
      baseCurrency: 'USD',
      quoteCurrency: 'BTC',
      rate: 0.000025,
      cachedAt: new Date('2024-01-01T00:00:00.000Z'),
      source: 'oracle',
    };
    redis.get.mockResolvedValue(JSON.stringify(record));

    const result = await service.getRate('USD', 'BTC');

    expect(oracle.fetchRate).not.toHaveBeenCalled();
    expect(result).toEqual(record);
  });

  it('falls back to the last known good rate when the oracle fails', async () => {
    const stale: ExchangeRateRecord = {
      baseCurrency: 'USD',
      quoteCurrency: 'BTC',
      rate: 0.000024,
      cachedAt: new Date('2023-12-31T00:00:00.000Z'),
      source: 'oracle',
    };
    redis.get.mockResolvedValue(JSON.stringify(stale));
    oracle.fetchRate.mockRejectedValue(new Error('oracle down'));

    const result = await service.getRate('USD', 'BTC');

    expect(result.rate).toBe(0.000024);
    expect(result.source).toBe('stale-cache');
  });

  it('throws when the oracle fails and no stale rate exists', async () => {
    redis.get.mockResolvedValue(null);
    oracle.fetchRate.mockRejectedValue(new Error('oracle down'));

    await expect(service.getRate('USD', 'BTC')).rejects.toThrow('oracle down');
  });
});
