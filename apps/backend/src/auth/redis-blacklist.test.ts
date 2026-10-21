import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RedisBlacklist } from './redis-blacklist';

/**
 * In-memory Redis stand-in that honors TTL semantics so we can verify that
 * revoked token entries automatically expire without a live Redis instance.
 */
class FakeRedis {
  private store = new Map<string, { value: string; expiresAt: number | null }>();

  private isExpired(entry: { expiresAt: number | null }): boolean {
    return entry.expiresAt !== null && entry.expiresAt <= Date.now();
  }

  async set(key: string, value: string, mode?: string, ttlSeconds?: number): Promise<'OK'> {
    const expiresAt =
      mode === 'EX' && typeof ttlSeconds === 'number' ? Date.now() + ttlSeconds * 1000 : null;
    this.store.set(key, { value, expiresAt });
    return 'OK';
  }

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (this.isExpired(entry)) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async exists(key: string): Promise<number> {
    return (await this.get(key)) !== null ? 1 : 0;
  }

  async del(key: string): Promise<number> {
    return this.store.delete(key) ? 1 : 0;
  }
}

describe('RedisBlacklist', () => {
  let redis: FakeRedis;
  let blacklist: RedisBlacklist;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));
    redis = new FakeRedis();
    blacklist = new RedisBlacklist(redis as unknown as never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stores a revoked jti with a TTL matching the remaining token lifetime', async () => {
    const now = Date.now();
    const expiresAt = now + 60_000;

    await blacklist.revoke({
      jti: 'jti-abc',
      userId: 'user-1',
      revokedAt: now,
      expiresAt,
    });

    const ttl = await blacklist.getRemainingTtl('jti-abc');
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);
  });

  it('rejects a revoked token immediately', async () => {
    await blacklist.revoke({
      jti: 'jti-revoked',
      userId: 'user-1',
      revokedAt: Date.now(),
      expiresAt: Date.now() + 300_000,
    });

    await expect(blacklist.isRevoked('jti-revoked')).resolves.toBe(true);
  });

  it('does not flag tokens that were never revoked', async () => {
    await expect(blacklist.isRevoked('jti-unknown')).resolves.toBe(false);
  });

  it('automatically expires blacklist entries once the token lifetime elapses', async () => {
    await blacklist.revoke({
      jti: 'jti-expiring',
      userId: 'user-1',
      revokedAt: Date.now(),
      expiresAt: Date.now() + 30_000,
    });

    await expect(blacklist.isRevoked('jti-expiring')).resolves.toBe(true);

    vi.advanceTimersByTime(31_000);

    await expect(blacklist.isRevoked('jti-expiring')).resolves.toBe(false);
  });

  it('does not persist entries for already-expired tokens', async () => {
    await blacklist.revoke({
      jti: 'jti-past',
      userId: 'user-1',
      revokedAt: Date.now() - 120_000,
      expiresAt: Date.now() - 60_000,
    });

    await expect(blacklist.isRevoked('jti-past')).resolves.toBe(false);
  });
});
