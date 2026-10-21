import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  InMemorySlidingWindowClient,
  TenantRateLimiter,
} from "./tenantRateLimiter.js";
import { getRateLimitMetrics, resetRateLimitMetrics } from "./tokenBucket/metrics.js";
import {
  TENANT_RATE_LIMIT_TIERS,
  type RateLimitTier,
  type TenantTierName,
} from "./tenantTiers.js";

const SMALL_TIERS: Record<TenantTierName, RateLimitTier> = {
  free: { name: "free", requestsPerMinute: 3, burstAllowance: 1 },
  merchant: { name: "merchant", requestsPerMinute: 5, burstAllowance: 2 },
  enterprise: { name: "enterprise", requestsPerMinute: 10, burstAllowance: 0 },
};

describe("TenantRateLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    resetRateLimitMetrics();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("enforces the Free tier at 60/min, admits the burst, then denies with Retry-After", async () => {
    const limiter = new TenantRateLimiter(new InMemorySlidingWindowClient());

    let last;
    for (let i = 0; i < 60; i++) {
      last = await limiter.check("free-user", "free");
      expect(last.allowed).toBe(true);
    }
    expect(last!.remaining).toBe(0);
    expect(last!.headers["X-RateLimit-Limit"]).toBe("60");

    // Burst allowance (10) is admitted above the steady-state quota.
    for (let i = 0; i < 10; i++) {
      expect((await limiter.check("free-user", "free")).allowed).toBe(true);
    }

    const denied = await limiter.check("free-user", "free");
    expect(denied.allowed).toBe(false);
    expect(denied.limit).toBe(60);
    expect(denied.remaining).toBe(0);
    expect(denied.retryAfterSeconds).toBe(60);
    expect(denied.headers["Retry-After"]).toBe("60");
    expect(TENANT_RATE_LIMIT_TIERS.free.burstAllowance).toBe(10);
  });

  it("reports the three RateLimit headers on allowed requests", async () => {
    const limiter = new TenantRateLimiter(new InMemorySlidingWindowClient(), SMALL_TIERS);

    const decision = await limiter.check("u1", "merchant", {
      endpoint: "/api/v1/orders",
      method: "GET",
    });

    expect(decision.allowed).toBe(true);
    expect(decision.headers["X-RateLimit-Limit"]).toBe("5");
    expect(decision.headers["X-RateLimit-Remaining"]).toBe("4");
    expect(Number(decision.headers["X-RateLimit-Reset"])).toBeGreaterThan(0);
    expect(decision.headers["Retry-After"]).toBeUndefined();
  });

  it("enforces each tier's own quota independently", async () => {
    const limiter = new TenantRateLimiter(new InMemorySlidingWindowClient(), SMALL_TIERS);

    // merchant: 5 + 2 burst => 7 admitted, 8th denied.
    for (let i = 0; i < 7; i++) {
      await limiter.check("merchant-user", "merchant");
    }
    expect((await limiter.check("merchant-user", "merchant")).allowed).toBe(false);

    // enterprise is a different (larger) bucket and is still allowed.
    expect((await limiter.check("enterprise-user", "enterprise")).allowed).toBe(true);
  });

  it("keeps separate sliding windows per identifier", async () => {
    const limiter = new TenantRateLimiter(new InMemorySlidingWindowClient(), SMALL_TIERS);

    for (let i = 0; i < 4; i++) {
      await limiter.check("ip-a", "free");
    }
    expect((await limiter.check("ip-a", "free")).allowed).toBe(false);
    expect((await limiter.check("ip-b", "free")).allowed).toBe(true);
  });

  it("keeps separate sliding windows per endpoint", async () => {
    const limiter = new TenantRateLimiter(new InMemorySlidingWindowClient(), SMALL_TIERS);

    for (let i = 0; i < 4; i++) {
      await limiter.check("u2", "free", { endpoint: "/api/v1/orders", method: "GET" });
    }
    expect(
      (await limiter.check("u2", "free", { endpoint: "/api/v1/orders", method: "GET" })).allowed,
    ).toBe(false);
    expect(
      (await limiter.check("u2", "free", { endpoint: "/api/v1/wallets", method: "GET" })).allowed,
    ).toBe(true);
  });

  it("feeds the tiered-metrics dashboard", async () => {
    const limiter = new TenantRateLimiter(new InMemorySlidingWindowClient(), SMALL_TIERS);

    for (let i = 0; i < 5; i++) {
      await limiter.check("metrics-user", "free", { endpoint: "/api/v1/orders" });
    }

    const metrics = getRateLimitMetrics();
    expect(metrics.totalRequests).toBe(5);
    expect(metrics.allowedRequests).toBe(4);
    expect(metrics.deniedRequests).toBe(1);
    expect(metrics.topDeniedKeys[0].key).toContain("metrics-user");
  });
});
