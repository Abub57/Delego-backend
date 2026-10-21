/**
 * Tenant & tier-based Redis sliding-window rate limiter (Issue #309).
 *
 * Wraps the shared `SlidingWindowRateLimiter` with the gateway's tenant tiers
 * and emits the RateLimit response contract: `X-RateLimit-Limit` (the tier's
 * steady-state per-minute quota), `X-RateLimit-Remaining`, `X-RateLimit-Reset`,
 * and — only when a request is denied — an exact `Retry-After` in whole
 * seconds, so the middleware can answer with HTTP 429.
 *
 * In mock/test mode an in-process client that mirrors the limiter's Lua
 * semantics is used, matching the `InMemoryTokenBucketStore` fallback in
 * `./tokenBucket/store.ts` so the gateway still runs without a real Redis.
 */

import {
  SlidingWindowRateLimiter,
  type RateLimitRedisClient,
} from "@delegolabs/utils";
import { getRedisClient } from "./redisClient.js";
import { recordRateLimitOutcome } from "./tokenBucket/metrics.js";
import {
  buildTenantRule,
  TENANT_RATE_LIMIT_TIERS,
  TENANT_WINDOW_MS,
  type RateLimitTier,
  type TenantTierName,
} from "./tenantTiers.js";

export interface TenantRateLimitDecision {
  allowed: boolean;
  tier: TenantTierName;
  identifier: string;
  /** Advertised steady-state quota (`requestsPerMinute`), excluding burst. */
  limit: number;
  /** Requests left before the steady-state quota is hit; never negative. */
  remaining: number;
  /** Unix ms when the oldest in-window request ages out. */
  resetAt: number;
  /** Present only on a denial: whole seconds until the caller may retry. */
  retryAfterSeconds?: number;
  headers: Record<string, string>;
}

export interface TenantRateLimitOptions {
  endpoint?: string;
  method?: string;
  /** Weight of this request against the limit; defaults to 1. */
  cost?: number;
}

export class TenantRateLimiter {
  private readonly limiter: SlidingWindowRateLimiter;

  constructor(
    client: RateLimitRedisClient = defaultTenantRateLimitClient(),
    private readonly tiers: Record<TenantTierName, RateLimitTier> = TENANT_RATE_LIMIT_TIERS,
  ) {
    this.limiter = new SlidingWindowRateLimiter(client);
  }

  async check(
    identifier: string,
    tier: TenantTierName,
    options: TenantRateLimitOptions = {},
  ): Promise<TenantRateLimitDecision> {
    const rule = buildTenantRule(this.tiers[tier], options.endpoint, options.method);
    const result = await this.limiter.check(rule, {
      key: identifier,
      tier,
      cost: options.cost,
    });

    // Keep the admin tiered-metrics dashboard populated across the engine swap.
    recordRateLimitOutcome(`${identifier}:${options.endpoint ?? "global"}`, result.allowed);

    const headers: Record<string, string> = {
      "X-RateLimit-Limit": String(result.limit),
      "X-RateLimit-Remaining": String(result.remaining),
      "X-RateLimit-Reset": String(Math.ceil(result.resetAt / 1000)),
    };

    let retryAfterSeconds: number | undefined;
    if (!result.allowed) {
      // RFC 6585 Retry-After is delta-seconds; always at least 1 so a client
      // never busy-loops on a 0.
      retryAfterSeconds = Math.max(
        1,
        Math.ceil((result.retryAfterMs ?? TENANT_WINDOW_MS) / 1000),
      );
      headers["Retry-After"] = String(retryAfterSeconds);
    }

    return {
      allowed: result.allowed,
      tier,
      identifier,
      limit: result.limit,
      remaining: result.remaining,
      resetAt: result.resetAt,
      retryAfterSeconds,
      headers,
    };
  }
}

/**
 * In-process `RateLimitRedisClient` mirroring the sliding-window Lua script,
 * for mock/test mode and tests that want deterministic state.
 */
export class InMemorySlidingWindowClient implements RateLimitRedisClient {
  private readonly windows = new Map<string, number[]>();

  async eval(
    _script: string,
    _numKeys: number,
    ...args: (string | number)[]
  ): Promise<[number, number, number]> {
    const [key, now, windowMs, maxRequests, burstAllowance = 0, cost = 1] = args;
    const k = String(key);
    const windowStart = Number(now) - Number(windowMs);
    const entries = (this.windows.get(k) ?? []).filter((t) => t > windowStart);

    let allowed = 0;
    let count = entries.length;
    if (count + Number(cost) <= Number(maxRequests) + Number(burstAllowance)) {
      for (let i = 0; i < Number(cost); i++) entries.push(Number(now));
      allowed = 1;
      count = entries.length;
    }

    this.windows.set(k, entries);
    const oldest = entries.length > 0 ? Math.min(...entries) : Number(now);
    return [allowed, count, oldest];
  }

  /** Test helper — clears all windows between cases. */
  reset(): void {
    this.windows.clear();
  }
}

function isMockMode(): boolean {
  return (
    process.env.NODE_ENV === "test" ||
    process.env.MOCK_REDIS === "true" ||
    process.env.CI === "true" ||
    Object.keys(process.env).some((k) => k.includes("TEST"))
  );
}

/** Redis in production, in-process fallback under test/CI/mock mode. */
export function defaultTenantRateLimitClient(): RateLimitRedisClient {
  return isMockMode()
    ? new InMemorySlidingWindowClient()
    : (getRedisClient() as unknown as RateLimitRedisClient);
}
