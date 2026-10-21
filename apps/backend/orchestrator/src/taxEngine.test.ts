import { describe, it, expect } from "vitest";
import { calculateTax } from "./taxEngine.js";

describe("tax engine", () => {
  it("calculates EU VAT for intra-EU shipments", async () => {
    const result = await calculateTax({
      merchantCountry: "DE",
      destinationCountry: "FR",
      destinationPostalCode: "75001",
      itemsSubtotalStroops: "1000",
      shippingFeeStroops: "100",
      productCategory: "physical",
    });

    expect(result.taxJurisdiction).toBe("FR");
    expect(result.taxRatePercent).toBe(20);
    expect(result.taxAmountStroops).toBe("220");
    expect(result.reverseChargeApplied).toBe(false);
  });

  it("applies reverse charge for B2B intra-EU orders", async () => {
    const result = await calculateTax({
      merchantCountry: "DE",
      destinationCountry: "FR",
      destinationPostalCode: "75001",
      itemsSubtotalStroops: "1000",
      shippingFeeStroops: "100",
      productCategory: "digital",
    });

    expect(result.taxRatePercent).toBe(20);
    expect(result.taxAmountStroops).toBe("0");
    expect(result.reverseChargeApplied).toBe(true);
  });

  it("returns zero tax for exempt international exports", async () => {
    const result = await calculateTax({
      merchantCountry: "US",
      destinationCountry: "JP",
      destinationPostalCode: "100-0001",
      itemsSubtotalStroops: "1000",
      shippingFeeStroops: "100",
      productCategory: "physical",
    });

    expect(result.taxRatePercent).toBe(0);
    expect(result.taxAmountStroops).toBe("0");
    expect(result.isTaxExempt).toBe(true);
  });
});
