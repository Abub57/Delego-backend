/**
 * Distributed sliding-window-log rate limiting (Issue #71).
 *
 * Each request timestamp for a key is recorded in a Redis sorted set (score
 * = timestamp), old entries outside the window are trimmed, and the
 * decision is made atomically via a Lua script so concurrent requests
 * across multiple service instances see a consistent count — a plain
 * GET-then-SET counter would race under concurrent load. A tier's optional
 * `burstAllowance` admits a bounded surplus above `maxRequests` before the
 * request is denied; the advertised `X-RateLimit-Limit` stays `maxRequests`.
 *
 * Redis key schema:
 *   ratelimit:{tier}:{key} → ZSET of request timestamps (ms), scored by timestamp
 *
 * Out of scope for this change (left as follow-ups): a real-time usage
 * dashboard, adaptive limits based on system load, and rate-limit
 * inheritance across user -> org -> global — this module answers "is this
 * one (key, tier) pair within its configured limit right now," which the
 * inheritance/dashboard features would be built on top of.
 */

/** Minimal subset of the ioredis client API this module depends on. */
export interface RateLimitRedisClient {
  eval(
    script: string,
    numKeys: number,
    ...args: (string | number)[]
  ): Promise<[number, number, number]>;
}

export interface RateLimitTier {
  tier: string;
  windowMs: number;
  maxRequests: number;
  /**
   * Extra requests admitted above `maxRequests` before the tier throttles.
   * Burst requests are counted in the same sliding window, so a caller who
   * exhausts both the steady-state quota and the burst is blocked until the
   * oldest in-window request ages out. Defaults to 0 (no burst).
   */
  burstAllowance?: number;
}

export interface RateLimitRule {
  keyPrefix: string;
  limits: RateLimitTier[];
  /** Keys exempt from limiting entirely (e.g. internal service identities). */
  exemptKeys?: string[];
}

export interface RateLimitCheck {
  key: string;
  tier: string;
  /** Cost of this request against the limit; defaults to 1. */
  cost?: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** Unix ms when the window resets and `remaining` returns to `limit`. */
  resetAt: number;
  limit: number;
  retryAfterMs?: number;
  /** RFC 6585-style headers. */
  headers: Record<string, string>;
}

// Atomically: trim entries outside the window, count remaining entries, and
// (only if under limit) add the new request. Returns [allowed, count, oldestInWindow].
const SLIDING_WINDOW_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local maxRequests = tonumber(ARGV[3])
local burstAllowance = tonumber(ARGV[4])
local cost = tonumber(ARGV[5])
local windowStart = now - windowMs

redis.call('ZREMRANGEBYSCORE', key, '-inf', windowStart)
local count = redis.call('ZCARD', key)

local allowed = 0
if count + cost <= maxRequests + burstAllowance then
  for i = 1, cost do
    redis.call('ZADD', key, now, now .. ':' .. i .. ':' .. math.random())
  end
  allowed = 1
  count = count + cost
end

redis.call('PEXPIRE', key, windowMs)

local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
local oldestScore = now
if #oldest > 0 then
  oldestScore = tonumber(oldest[2])
end

return {allowed, count, oldestScore}
`;

export class SlidingWindowRateLimiter {
  constructor(private readonly redis: RateLimitRedisClient) {}

  /**
   * Checks and (if allowed) records one request against `rule`'s tier
   * matching `check.tier`. Exempt keys always return `allowed: true` without
   * touching Redis.
   */
  async check(rule: RateLimitRule, check: RateLimitCheck): Promise<RateLimitResult> {
    if (rule.exemptKeys?.includes(check.key)) {
      return {
        allowed: true,
        remaining: Number.POSITIVE_INFINITY,
        resetAt: 0,
        limit: Number.POSITIVE_INFINITY,
        headers: { "X-RateLimit-Exempt": "true" },
      };
    }

    const tierConfig = rule.limits.find((l) => l.tier === check.tier);
    if (!tierConfig) {
      throw new Error(`No rate limit tier "${check.tier}" configured for rule "${rule.keyPrefix}"`);
    }

    const cost = check.cost ?? 1;
    const burstAllowance = tierConfig.burstAllowance ?? 0;
    const now = Date.now();
    const redisKey = `ratelimit:${check.tier}:${rule.keyPrefix}:${check.key}`;

    const [allowedRaw, count, oldestScore] = await this.redis.eval(
      SLIDING_WINDOW_LUA,
      1,
      redisKey,
      now,
      tierConfig.windowMs,
      tierConfig.maxRequests,
      burstAllowance,
      cost,
    );

    const allowed = allowedRaw === 1;
    // `remaining` tracks the steady-state quota only; while a caller is inside
    // its burst allowance this floors at 0 even though requests still succeed.
    const remaining = Math.max(0, tierConfig.maxRequests - count);
    const resetAt = oldestScore + tierConfig.windowMs;
    const retryAfterMs = allowed ? undefined : Math.max(0, resetAt - now);

    const headers: Record<string, string> = {
      "X-RateLimit-Limit": String(tierConfig.maxRequests),
      "X-RateLimit-Remaining": String(remaining),
      "X-RateLimit-Reset": String(Math.ceil(resetAt / 1000)),
    };
    if (retryAfterMs !== undefined) {
      headers["Retry-After"] = String(Math.ceil(retryAfterMs / 1000));
    }

    return {
      allowed,
      remaining,
      resetAt,
      limit: tierConfig.maxRequests,
      retryAfterMs,
      headers,
    };
  }
}
