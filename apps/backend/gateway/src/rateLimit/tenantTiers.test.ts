import { describe, it, expect } from "vitest";
import {
  TENANT_RATE_LIMIT_TIERS,
  TENANT_WINDOW_MS,
  resolveTenantTier,
  buildTenantRule,
} from "./tenantTiers.js";

describe("tenant rate-limit tiers (issue #309)", () => {
  it("defines the three tiers with the required per-minute limits", () => {
    expect(TENANT_RATE_LIMIT_TIERS.free.name).toBe("free");
    expect(TENANT_RATE_LIMIT_TIERS.merchant.name).toBe("merchant");
    expect(TENANT_RATE_LIMIT_TIERS.enterprise.name).toBe("enterprise");

    expect(TENANT_RATE_LIMIT_TIERS.free.requestsPerMinute).toBe(60);
    expect(TENANT_RATE_LIMIT_TIERS.merchant.requestsPerMinute).toBe(300);
    expect(TENANT_RATE_LIMIT_TIERS.enterprise.requestsPerMinute).toBe(1200);
  });

  it("gives every tier a positive burst allowance", () => {
    for (const tier of Object.values(TENANT_RATE_LIMIT_TIERS)) {
      expect(tier.burstAllowance).toBeGreaterThan(0);
    }
  });

  it("resolves a tier from roles, highest tier first", () => {
    expect(resolveTenantTier(undefined)).toBe("free");
    expect(resolveTenantTier([])).toBe("free");
    expect(resolveTenantTier(["unknown"])).toBe("free");
    expect(resolveTenantTier(["pro"])).toBe("merchant");
    expect(resolveTenantTier(["merchant"])).toBe("merchant");
    expect(resolveTenantTier(["enterprise"])).toBe("enterprise");
    expect(resolveTenantTier(["pro", "enterprise"])).toBe("enterprise");
  });

  it("builds one-minute sliding-window rules from the tier", () => {
    const rule = buildTenantRule(TENANT_RATE_LIMIT_TIERS.merchant, "/api/v1/orders", "POST");

    expect(TENANT_WINDOW_MS).toBe(60_000);
    expect(rule.keyPrefix).toBe("POST:/api/v1/orders");
    expect(rule.limits).toEqual([
      { tier: "merchant", windowMs: 60_000, maxRequests: 300, burstAllowance: 50 },
    ]);
  });

  it("keeps auth endpoints tightened below the tier limit", () => {
    const enterpriseLogin = buildTenantRule(
      TENANT_RATE_LIMIT_TIERS.enterprise,
      "/api/v1/auth/login",
      "POST",
    );
    expect(enterpriseLogin.limits[0].maxRequests).toBeLessThanOrEqual(5);
    expect(enterpriseLogin.limits[0].burstAllowance).toBeLessThanOrEqual(2);
  });
});
