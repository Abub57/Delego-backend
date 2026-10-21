/**
 * Tenant & tier-based per-minute rate limits (Issue #309).
 *
 * Tiers cap steady-state throughput at `requestsPerMinute` and admit a bounded
 * `burstAllowance` of surplus requests above that cap before the caller is
 * throttled with HTTP 429. They are resolved server-side from the verified
 * JWT's roles (never from a client-supplied header); `pro` is kept as an alias
 * for the legacy token-bucket tier of the same name.
 *
 * The rules built here feed the Redis sliding-window engine in
 * `./tenantRateLimiter.ts`.
 */

import type { RateLimitRule } from "@delegolabs/utils";
import { ENDPOINT_OVERRIDES } from "./tokenBucket/tierConfig.js";

export type TenantTierName = "free" | "merchant" | "enterprise";

/** The tier shape named by issue #309. */
export interface RateLimitTier {
  name: TenantTierName;
  requestsPerMinute: number;
  burstAllowance: number;
}

/** Every tenant tier shares the same one-minute sliding window. */
export const TENANT_WINDOW_MS = 60_000;

export const TENANT_RATE_LIMIT_TIERS: Record<TenantTierName, RateLimitTier> = {
  free: { name: "free", requestsPerMinute: 60, burstAllowance: 10 },
  merchant: { name: "merchant", requestsPerMinute: 300, burstAllowance: 50 },
  enterprise: { name: "enterprise", requestsPerMinute: 1200, burstAllowance: 200 },
};

export const DEFAULT_TENANT_TIER: TenantTierName = "free";

/** Highest role wins when a caller carries more than one tier role. */
const ROLE_TIER_PRECEDENCE: ReadonlyArray<{ role: string; tier: TenantTierName }> = [
  { role: "enterprise", tier: "enterprise" },
  { role: "merchant", tier: "merchant" },
  { role: "pro", tier: "merchant" },
];

/** Resolve a tenant tier from a caller's verified roles, defaulting to "free". */
export function resolveTenantTier(roles: string[] | undefined): TenantTierName {
  for (const { role, tier } of ROLE_TIER_PRECEDENCE) {
    if (roles?.includes(role)) return tier;
  }
  return DEFAULT_TENANT_TIER;
}

/**
 * Build the sliding-window rule for `tier`. Sensitive endpoints keep the same
 * tightening the token-bucket engine applied (`ENDPOINT_OVERRIDES`), so moving
 * the gateway onto the sliding-window engine does not loosen credential-stuffing
 * protection on auth routes.
 */
export function buildTenantRule(
  tier: RateLimitTier,
  endpoint?: string,
  method?: string,
): RateLimitRule {
  let maxRequests = tier.requestsPerMinute;
  let burstAllowance = tier.burstAllowance;

  const overrideKey = method && endpoint ? `${method}:${endpoint}` : undefined;
  const override = overrideKey ? ENDPOINT_OVERRIDES[overrideKey] : undefined;
  if (override) {
    if (override.requestsPerWindow !== undefined) {
      maxRequests = Math.min(maxRequests, override.requestsPerWindow);
    }
    if (override.burstAllowance !== undefined) {
      burstAllowance = Math.min(burstAllowance, override.burstAllowance);
    }
  }

  return {
    keyPrefix: endpoint ? `${method ?? "*"}:${endpoint}` : "global",
    limits: [{ tier: tier.name, windowMs: TENANT_WINDOW_MS, maxRequests, burstAllowance }],
  };
}
