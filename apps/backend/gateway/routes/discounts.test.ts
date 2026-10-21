import { describe, expect, it } from "vitest";
import {
  CreateDiscountSchema,
  registerDiscountRoutes,
  createDiscountHandler,
} from "./discounts.js";

describe("Gateway routes/discounts re-export and route registration", () => {
  it("exports createDiscountHandler and CreateDiscountSchema", () => {
    expect(createDiscountHandler).toBeDefined();
    expect(CreateDiscountSchema).toBeDefined();
  });

  it("registers both merchant-scoped and root discount routes", () => {
    const routes = registerDiscountRoutes();
    expect(routes).toHaveLength(2);

    for (const r of routes) {
      expect(r.method).toBe("POST");
    }

    const merchantScoped = routes.find((r) => r.paramNames.includes("merchantId"));
    expect(merchantScoped).toBeDefined();
    expect(merchantScoped!.pattern.test("/api/v1/merchants/m-123/discounts")).toBe(true);
    expect(merchantScoped!.pattern.test("/api/v1/discounts")).toBe(false);

    const rootDiscount = routes.find((r) => r.paramNames.length === 0);
    expect(rootDiscount).toBeDefined();
    expect(rootDiscount!.pattern.test("/api/v1/discounts")).toBe(true);
    expect(rootDiscount!.pattern.test("/api/v1/merchants/m-123/discounts")).toBe(false);
  });
});
