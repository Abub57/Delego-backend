/**
 * Automated tests for Stellar Trustline Pre-Flight Checks — Issue #594.
 * Tests trustline verification using mocked Horizon account balances.
 */
import { describe, expect, it, vi } from "vitest";
import {
  checkTrustline,
  verifyTrustline,
  isTrustlineValidForPayout,
  generateTrustlineSetupInstructions,
  TrustlinePreflightWorker,
  createTrustlinePreflightWorker,
  type PayoutBatchItem,
} from "./trustlines.js";

const MERCHANT_ADDRESS = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const EURC_ISSUER = "GD6WNOAELSTGN2PCXEZBPGVIWFLQ3TKXAIB3ST3Q5KVZOGCBTC7T2A6S";

function createMockHorizonServer(balances: any[], shouldThrow = false) {
  return {
    loadAccount: vi.fn(async (account: string) => {
      if (shouldThrow) {
        const error: any = new Error("Account not found");
        error.response = { status: 404 };
        throw error;
      }
      return { id: account, balances };
    }),
  };
}

describe("checkTrustline (Issue #594)", () => {
  it("detects native XLM without requiring a credit trustline", async () => {
    const result = await checkTrustline(MERCHANT_ADDRESS, "XLM", "");

    expect(result.trustlineEstablished).toBe(true);
    expect(result.authorized).toBe(true);
    expect(result.assetCode).toBe("XLM");
    expect(isTrustlineValidForPayout(result)).toBe(true);
  });

  it("detects valid established and authorized trustline for non-native asset (USDC)", async () => {
    const mockServer = createMockHorizonServer([
      { asset_type: "native", balance: "100.0000000" },
      {
        asset_type: "credit_alphanum4",
        asset_code: "USDC",
        asset_issuer: USDC_ISSUER,
        balance: "500.2500000",
        limit: "10000.0000000",
        is_authorized: true,
      },
    ]);

    const result = await checkTrustline(MERCHANT_ADDRESS, "USDC", USDC_ISSUER, {
      server: mockServer as any,
    });

    expect(mockServer.loadAccount).toHaveBeenCalledWith(MERCHANT_ADDRESS);
    expect(result.trustlineEstablished).toBe(true);
    expect(result.authorized).toBe(true);
    expect(result.currentBalance).toBe("500.2500000");
    expect(result.creditLimit).toBe("10000.0000000");
    expect(isTrustlineValidForPayout(result)).toBe(true);
  });

  it("detects missing trustline when asset is not found on merchant destination address", async () => {
    const mockServer = createMockHorizonServer([
      { asset_type: "native", balance: "50.0000000" },
      {
        asset_type: "credit_alphanum4",
        asset_code: "OTHER",
        asset_issuer: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
        balance: "10.0000000",
      },
    ]);

    const result = await checkTrustline(MERCHANT_ADDRESS, "USDC", USDC_ISSUER, {
      server: mockServer as any,
    });

    expect(result.trustlineEstablished).toBe(false);
    expect(result.authorized).toBe(false);
    expect(result.currentBalance).toBe("0");
    expect(result.creditLimit).toBe("0");
    expect(isTrustlineValidForPayout(result)).toBe(false);
  });

  it("detects unauthorized trustline when issuer has not authorized the account", async () => {
    const mockServer = createMockHorizonServer([
      {
        asset_type: "credit_alphanum4",
        asset_code: "EURC",
        asset_issuer: EURC_ISSUER,
        balance: "0.0000000",
        limit: "5000.0000000",
        is_authorized: false,
      },
    ]);

    const result = await verifyTrustline(MERCHANT_ADDRESS, "EURC", EURC_ISSUER, {
      server: mockServer as any,
    });

    expect(result.trustlineEstablished).toBe(true);
    expect(result.authorized).toBe(false);
    expect(isTrustlineValidForPayout(result)).toBe(false);
  });

  it("handles Horizon 404 (unfunded account) safely without throwing unhandled exceptions", async () => {
    const mockServer = createMockHorizonServer([], true);

    const result = await checkTrustline(MERCHANT_ADDRESS, "USDC", USDC_ISSUER, {
      server: mockServer as any,
    });

    expect(result.trustlineEstablished).toBe(false);
    expect(result.authorized).toBe(false);
    expect(isTrustlineValidForPayout(result)).toBe(false);
  });

  it("generates actionable setup instructions for missing trustline", () => {
    const instructions = generateTrustlineSetupInstructions(
      MERCHANT_ADDRESS,
      "USDC",
      USDC_ISSUER
    );

    expect(instructions.account).toBe(MERCHANT_ADDRESS);
    expect(instructions.assetCode).toBe("USDC");
    expect(instructions.assetIssuer).toBe(USDC_ISSUER);
    expect(instructions.steps.length).toBeGreaterThan(0);
    expect(instructions.instructions).toContain("ChangeTrust");
    expect(instructions.stellarLaboratoryUrl).toContain("laboratory.stellar.org");
  });
});

describe("TrustlinePreflightWorker (Issue #594)", () => {
  it("validates a batch and separates valid transfers from paused transfers", async () => {
    const mockServer = {
      loadAccount: vi.fn(async (account: string) => {
        if (account === "MERCHANT_WITH_USDC") {
          return {
            id: account,
            balances: [
              {
                asset_type: "credit_alphanum4",
                asset_code: "USDC",
                asset_issuer: USDC_ISSUER,
                balance: "100.0000000",
                limit: "1000.0000000",
                is_authorized: true,
              },
            ],
          };
        }
        // MERCHANT_WITHOUT_USDC has only native XLM
        return {
          id: account,
          balances: [{ asset_type: "native", balance: "10.0000000" }],
        };
      }),
    };

    const notifyMerchantMock = vi.fn().mockResolvedValue(undefined);
    const onPausePayoutMock = vi.fn().mockResolvedValue(undefined);

    const worker = createTrustlinePreflightWorker({
      server: mockServer as any,
      notifyMerchant: notifyMerchantMock,
      onPausePayout: onPausePayoutMock,
    });

    const items: PayoutBatchItem[] = [
      {
        id: "payout_1",
        merchantAddress: "MERCHANT_WITH_USDC",
        assetCode: "USDC",
        assetIssuer: USDC_ISSUER,
        amount: "50000000",
      },
      {
        id: "payout_2",
        merchantAddress: "MERCHANT_WITHOUT_USDC",
        assetCode: "USDC",
        assetIssuer: USDC_ISSUER,
        amount: "75000000",
      },
      {
        id: "payout_3",
        merchantAddress: "MERCHANT_WITHOUT_USDC",
        assetCode: "XLM",
        assetIssuer: "",
        amount: "10000000",
      },
    ];

    const result = await worker.validateBatch(items);

    expect(result.validItems).toHaveLength(2);
    expect(result.validItems[0].id).toBe("payout_1");
    expect(result.validItems[1].id).toBe("payout_3");

    expect(result.pausedItems).toHaveLength(1);
    expect(result.pausedItems[0].item.id).toBe("payout_2");
    expect(result.pausedItems[0].reason).toBe("MISSING_TRUSTLINE");
    expect(result.pausedItems[0].instructions.account).toBe("MERCHANT_WITHOUT_USDC");

    expect(onPausePayoutMock).toHaveBeenCalledTimes(1);
    expect(notifyMerchantMock).toHaveBeenCalledTimes(1);
  });
});
