import type { Redis } from 'ioredis';

export interface RevokedTokenEntry {
  jti: string;
  userId: string;
  revokedAt: number;
  expiresAt: number;
}

const KEY_PREFIX = 'jwt:revoked:';

function keyFor(jti: string): string {
  return `${KEY_PREFIX}${jti}`;
}

/**
 * Distributed JWT revocation blacklist backed by Redis.
 *
 * Revoked token `jti` identifiers are stored with a TTL equal to the
 * remaining lifetime of the token, so entries expire automatically once
 * the token would have expired anyway.
 */
export class RedisTokenBlacklist {
  constructor(private readonly redis: Redis) {}

  /**
   * Revoke a token by its `jti`. The entry is stored with a TTL matching the
   * remaining token lifetime (in seconds). Already-expired tokens are ignored.
   */
  async revoke(entry: RevokedTokenEntry): Promise<void> {
    const ttlSeconds = Math.floor((entry.expiresAt - Date.now()) / 1000);
    if (ttlSeconds <= 0) {
      return;
    }

    await this.redis.set(
      keyFor(entry.jti),
      JSON.stringify(entry),
      'EX',
      ttlSeconds,
    );
  }

  /**
   * Returns true when the given `jti` has been revoked and has not yet
   * expired from the blacklist.
   */
  async isRevoked(jti: string): Promise<boolean> {
    if (!jti) {
      return false;
    }
    const result = await this.redis.exists(keyFor(jti));
    return result === 1;
  }

  /**
   * Fetch the stored revocation entry for a `jti`, or null when it is not
   * present (never revoked or already expired).
   */
  async getEntry(jti: string): Promise<RevokedTokenEntry | null> {
    if (!jti) {
      return null;
    }
    const raw = await this.redis.get(keyFor(jti));
    if (!raw) {
      return null;
    }
    try {
      return JSON.parse(raw) as RevokedTokenEntry;
    } catch {
      return null;
    }
  }
}
