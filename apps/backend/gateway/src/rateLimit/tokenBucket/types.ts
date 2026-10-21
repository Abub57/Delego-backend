/**
 * Token Bucket Rate Limiting with Tiers (Issue #51).
 *
 * Lives alongside the legacy fixed-window limiter (`../rateLimiter.ts`).
 * Since issue #309 the gateway's `rateLimitMiddleware` enforces tenant tiers
 * with the Redis sliding-window engine in `../tenantRateLimiter.ts`; this
 * token-bucket engine remains as the source of the endpoint overrides and the
 * in-process tiered metrics the admin dashboard reads.
 */

export type RateLimitTier = "free" | "pro" | "enterprise" | "internal";

export interface RateLimitConfig {
  tier: RateLimitTier;
  /** Steady-state requests allowed per window — also the bucket's base capacity. */
  requestsPerWindow: number;
  windowMs: number;
  /** Extra tokens available on top of the steady-state capacity for bursts. */
  burstAllowance: number;
  /** Tokens restored per second once consumed (drives how fast a caller recovers after a burst). */
  refillRatePerSecond: number;
}

export interface RateLimitKey {
  /** User ID, API key, or IP — whatever identifies the caller. */
  identifier: string;
  tier: string;
  endpoint?: string;
  method?: string;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** ISO-8601 timestamp for when the bucket is back to full capacity. */
  resetAt: string;
  limit: number;
  /** Present only when `allowed` is false — ms until at least one token is available. */
  retryAfterMs?: number;
}

export interface RateLimitMetrics {
  totalRequests: number;
  allowedRequests: number;
  deniedRequests: number;
  /** 0-1 — deniedRequests / totalRequests over the observed window (0 when no requests seen). */
  currentUtilization: number;
  topDeniedKeys: Array<{ key: string; count: number }>;
}
