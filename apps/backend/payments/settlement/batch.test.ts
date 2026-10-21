import { describe, expect, it } from "vitest";
import { calculateMerchantSettlements, settlementCsv } from "./batch.js";

const start = new Date("2026-01-01T00:00:00.000Z");
const end = new Date("2026-01-02T00:00:00.000Z");

describe("merchant settlement batch calculation", () => {
  it("balances gross amount, fee, and net payout by merchant", () => {
    const result = calculateMerchantSettlements([
      { orderId: "b", merchantId: "m1", payoutAddress: "G1", grossAmount: 1000n, completedAt: new Date("2026-01-01T01:00:00Z"), status: "completed" },
      { orderId: "a", merchantId: "m1", payoutAddress: "G1", grossAmount: 3000n, completedAt: new Date("2026-01-01T02:00:00Z"), status: "completed" },
      { orderId: "outside", merchantId: "m1", payoutAddress: "G1", grossAmount: 9000n, completedAt: end, status: "completed" },
    ], start, end, 250n);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ totalGrossAmount: 4000n, platformFees: 100n, netDisbursement: 3900n, orderCount: 2, orderIds: ["a", "b"] });
  });

  it("emits a deterministic CSV report with bigint values intact", () => {
    const [settlement] = calculateMerchantSettlements([{ orderId: "1", merchantId: "m", payoutAddress: "G", grossAmount: 1000000000000000001n, completedAt: new Date("2026-01-01T00:00:00Z"), status: "completed" }], start, end);
    expect(settlementCsv([settlement!])).toContain("1000000000000000001");
    expect(settlementCsv([settlement!]).split("\n")).toHaveLength(3);
  });
});
