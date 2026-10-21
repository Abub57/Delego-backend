/**
 * Automated tests for Payout Orchestrator Pre-Flight Trustline Checks — Issue #594.
 *
 * Verifies that missing or unauthorized trustlines are detected before submitting
 * payment transactions, pausing the payout and notifying the merchant, while
 * preventing failed transaction fees and blockchain error logs.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  initiatePayout,
  PayoutOrchestrator,
  createPayoutOrchestrator,
  getPayoutRecordById,
} from "./index.js";
import * as paymentRecordStore from "../escrowCoordinator/paymentRecordStore.js";

const MERCHANT_ADDRESS = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const SOURCE_ADDRESS = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const USDC_ISSUER = "GD6WNOAELSTGN2PCXEZBPGVIWFLQ3TKXAIB3ST3Q5KVZOGCBTC7T2A6S";

describe("Payout Orchestrator Pre-Flight Trustline Checks (Issue #594)", () => {
  const mockEscrowRecord = {
    id: "payment_rec_1",
    orderId: "order_123",
    escrowId: "escrow_test_123",
    escrowContractId: "contract_escrow_123",
    buyerAddress: "GBUYER",
    sellerAddress: MERCHANT_ADDRESS,
    tokenContractId: "token_usdc",
    amountStroops: "100000000", // 10 USDC
    status: "funded",
    releasedAmountStroops: "0",
    refundedAmountStroops: "0",
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(() => {
    vi.spyOn(paymentRecordStore, "findPaymentRecordByEscrowId").mockResolvedValue(
      mockEscrowRecord as any
    );
  });

  it("detects missing trustline and pauses payout before submitting payment transaction", async () => {
    const escrowReleaseMock = vi.fn();
    const notifyMerchantMock = vi.fn().mockResolvedValue(undefined);

    const checkTrustlineMock = vi.fn().mockResolvedValue({
      account: MERCHANT_ADDRESS,
      assetCode: "USDC",
      assetIssuer: USDC_ISSUER,
      trustlineEstablished: false,
      authorized: false,
      currentBalance: "0",
      creditLimit: "0",
    });

    const response = await initiatePayout(
      {
        escrowId: "escrow_test_123",
        merchantAddress: MERCHANT_ADDRESS,
        sourceAddress: SOURCE_ADDRESS,
        assetCode: "USDC",
        assetIssuer: USDC_ISSUER,
      },
      {
        checkTrustlineFn: checkTrustlineMock,
        notifyMerchantFn: notifyMerchantMock,
        escrowReleaseFn: escrowReleaseMock,
      }
    );

    // Acceptance Criteria: Missing trustline detected before submitting payment transaction
    expect(checkTrustlineMock).toHaveBeenCalledWith(MERCHANT_ADDRESS, "USDC", USDC_ISSUER);

    // Acceptance Criteria: Prevents failed transaction fees and blockchain error logs
    expect(escrowReleaseMock).not.toHaveBeenCalled();

    // Verifies status is paused
    expect(response.status).toBe("paused");
    expect(response.pausedReason).toBe("MISSING_TRUSTLINE");
    expect(response.trustlineCheck?.trustlineEstablished).toBe(false);
    expect(response.instructions).toBeDefined();
    expect(response.instructions?.steps.length).toBeGreaterThan(0);

    // Verifies merchant is notified with setup instructions
    expect(notifyMerchantMock).toHaveBeenCalledTimes(1);
    expect(notifyMerchantMock).toHaveBeenCalledWith(
      expect.objectContaining({
        merchantAddress: MERCHANT_ADDRESS,
        assetCode: "USDC",
        assetIssuer: USDC_ISSUER,
        instructions: expect.objectContaining({
          account: MERCHANT_ADDRESS,
          assetCode: "USDC",
        }),
      })
    );

    // Verifies stored payout record has status 'paused'
    const storedRecord = await getPayoutRecordById(response.payoutId);
    expect(storedRecord).toBeDefined();
    expect(storedRecord?.status).toBe("paused");
    expect(storedRecord?.transactionHash).toBeNull();
  });

  it("detects unauthorized trustline and pauses payout without submitting transaction", async () => {
    const escrowReleaseMock = vi.fn();
    const notifyMerchantMock = vi.fn().mockResolvedValue(undefined);

    const checkTrustlineMock = vi.fn().mockResolvedValue({
      account: MERCHANT_ADDRESS,
      assetCode: "USDC",
      assetIssuer: USDC_ISSUER,
      trustlineEstablished: true,
      authorized: false,
      currentBalance: "0",
      creditLimit: "1000",
    });

    const response = await initiatePayout(
      {
        escrowId: "escrow_test_123",
        merchantAddress: MERCHANT_ADDRESS,
        sourceAddress: SOURCE_ADDRESS,
        assetCode: "USDC",
        assetIssuer: USDC_ISSUER,
      },
      {
        checkTrustlineFn: checkTrustlineMock,
        notifyMerchantFn: notifyMerchantMock,
        escrowReleaseFn: escrowReleaseMock,
      }
    );

    expect(escrowReleaseMock).not.toHaveBeenCalled();
    expect(response.status).toBe("paused");
    expect(response.pausedReason).toBe("UNAUTHORIZED_TRUSTLINE");
    expect(notifyMerchantMock).toHaveBeenCalledTimes(1);
  });

  it("submits transaction when destination address has valid established trustline", async () => {
    const escrowReleaseMock = vi.fn().mockResolvedValue({
      success: true,
      txHash: "tx_valid_stellar_hash_456",
      ledger: 123456,
    });

    const checkTrustlineMock = vi.fn().mockResolvedValue({
      account: MERCHANT_ADDRESS,
      assetCode: "USDC",
      assetIssuer: USDC_ISSUER,
      trustlineEstablished: true,
      authorized: true,
      currentBalance: "50.0000000",
      creditLimit: "10000.0000000",
    });

    const response = await initiatePayout(
      {
        escrowId: "escrow_test_123",
        merchantAddress: MERCHANT_ADDRESS,
        sourceAddress: SOURCE_ADDRESS,
        assetCode: "USDC",
        assetIssuer: USDC_ISSUER,
      },
      {
        checkTrustlineFn: checkTrustlineMock,
        escrowReleaseFn: escrowReleaseMock,
      }
    );

    expect(escrowReleaseMock).toHaveBeenCalledWith({
      sourceAddress: SOURCE_ADDRESS,
      escrowId: "escrow_test_123",
    });

    expect(response.status).toBe("confirmed");
    expect(response.transactionHash).toBe("tx_valid_stellar_hash_456");
    expect(response.ledger).toBe(123456);
  });

  it("orchestrates batch payouts, pausing missing trustlines and submitting valid ones", async () => {
    const escrowReleaseMock = vi.fn().mockResolvedValue({
      success: true,
      txHash: "tx_batch_hash_789",
      ledger: 99999,
    });

    const notifyMerchantMock = vi.fn().mockResolvedValue(undefined);

    const orchestrator = createPayoutOrchestrator({
      checkTrustlineFn: async (account, code, issuer) => {
        if (account === "MERCHANT_PAUSED") {
          return {
            account,
            assetCode: code,
            assetIssuer: issuer,
            trustlineEstablished: false,
            authorized: false,
            currentBalance: "0",
            creditLimit: "0",
          };
        }
        return {
          account,
          assetCode: code,
          assetIssuer: issuer,
          trustlineEstablished: true,
          authorized: true,
          currentBalance: "100",
          creditLimit: "1000",
        };
      },
      notifyMerchantFn: notifyMerchantMock,
      escrowReleaseFn: escrowReleaseMock,
    });

    const batchResult = await orchestrator.orchestrateBatchPayouts([
      {
        escrowId: "escrow_test_123",
        merchantAddress: "MERCHANT_VALID",
        sourceAddress: SOURCE_ADDRESS,
        assetCode: "USDC",
        assetIssuer: USDC_ISSUER,
      },
      {
        escrowId: "escrow_test_123",
        merchantAddress: "MERCHANT_PAUSED",
        sourceAddress: SOURCE_ADDRESS,
        assetCode: "USDC",
        assetIssuer: USDC_ISSUER,
      },
    ]);

    expect(batchResult.successful).toHaveLength(1);
    expect(batchResult.successful[0].status).toBe("confirmed");

    expect(batchResult.paused).toHaveLength(1);
    expect(batchResult.paused[0].status).toBe("paused");
    expect(batchResult.paused[0].pausedReason).toBe("MISSING_TRUSTLINE");

    // escrow release was only called once for the valid merchant
    expect(escrowReleaseMock).toHaveBeenCalledTimes(1);
    expect(notifyMerchantMock).toHaveBeenCalledTimes(1);
  });
});
