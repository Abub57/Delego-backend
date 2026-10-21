import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { escrowCoordinator } from "../escrowCoordinator/index.js";
import { getDisputeStore, resetDisputeStore } from "../disputes/disputeStore.js";
import { resetAutoReleaseConfigStore, setAutoReleaseConfig } from "./configStore.js";
import { resetConfirmationTracker } from "./confirmationTracker.js";
import { resetReleaseQueue, runDueReleaseJobs } from "./releaseQueue.js";
import { adminOverrideRelease, executeAutoRelease, handleDeliveryConfirmation } from "./service.js";
import type { DeliveryConfirmation } from "./types.js";

vi.mock("../escrowCoordinator/index.js", () => ({
  escrowCoordinator: {
    getEscrowStatus: vi.fn(),
    releaseEscrow: vi.fn(),
    fundEscrow: vi.fn(),
    refundEscrow: vi.fn(),
    disputeEscrow: vi.fn(),
  },
}));

const NO_SLEEP = { sleep: async () => undefined };

function fundedStatus(overrides: Partial<Awaited<ReturnType<typeof escrowCoordinator.getEscrowStatus>>> = {}) {
  return {
    escrowId: "42",
    buyer: "GBUYER",
    seller: "GSELLER",
    amount: "1000",
    status: "funded" as const,
    createdAt: Date.now(),
    ...overrides,
  };
}

function confirmation(overrides: Partial<DeliveryConfirmation> = {}): DeliveryConfirmation {
  return {
    escrowId: "42",
    orderId: "order-1",
    deliveryProof: { deliveredAt: new Date().toISOString() },
    confirmedBy: "merchant-1",
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe("escrow auto-release service", () => {
  beforeEach(() => {
    process.env.ESCROW_CONTRACT_ID = "CCONTRACTID000000000000000000000000000000000000000000000000";
    process.env.ESCROW_AUTO_RELEASE_CALLER_ADDRESS = "GCALLERADDRESS0000000000000000000000000000000000000000000";
    resetAutoReleaseConfigStore();
    resetConfirmationTracker();
    resetReleaseQueue();
    resetDisputeStore();
    vi.mocked(escrowCoordinator.getEscrowStatus).mockReset();
    vi.mocked(escrowCoordinator.releaseEscrow).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.ESCROW_CONTRACT_ID;
    delete process.env.ESCROW_AUTO_RELEASE_CALLER_ADDRESS;
  });

  describe("executeAutoRelease — status transitions", () => {
    it("releases a funded escrow immediately and emits success", async () => {
      vi.mocked(escrowCoordinator.getEscrowStatus).mockResolvedValue(fundedStatus());
      vi.mocked(escrowCoordinator.releaseEscrow).mockResolvedValue({
        txHash: "tx-1",
        ledger: 5,
        status: "released",
        sellerAddress: "GSELLER",
        amount: "1000",
      });

      const result = await executeAutoRelease({
        escrowId: "42",
        orderId: "order-1",
        confirmedBy: "merchant-1",
        retryOptions: NO_SLEEP,
      });

      expect(result.success).toBe(true);
      expect(result.transactionHash).toBe("tx-1");
      expect(result.releasedAmount).toBe("1000");
      expect(result.remainingAmount).toBe("0");
      expect(result.retryCount).toBe(0);
    });

    it("blocks release when the escrow is disputed", async () => {
      vi.mocked(escrowCoordinator.getEscrowStatus).mockResolvedValue(fundedStatus({ status: "disputed" }));

      const result = await executeAutoRelease({
        escrowId: "42",
        orderId: "order-1",
        confirmedBy: "merchant-1",
        retryOptions: NO_SLEEP,
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/disputed/i);
      expect(escrowCoordinator.releaseEscrow).not.toHaveBeenCalled();
    });

    it("blocks release when a mediation dispute exists but the on-chain flag failed", async () => {
      vi.mocked(escrowCoordinator.getEscrowStatus).mockResolvedValue(fundedStatus());
      await getDisputeStore().create({
        escrowId: "42", orderId: "order-1", initiatedBy: "buyer", reason: "not delivered",
        slaDeadline: "2026-10-01T00:00:00Z",
      });

      const result = await executeAutoRelease({
        escrowId: "42", orderId: "order-1", confirmedBy: "merchant-1", retryOptions: NO_SLEEP,
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/disputed/i);
      expect(escrowCoordinator.releaseEscrow).not.toHaveBeenCalled();
    });

    it("blocks release when the escrow is not funded (already released)", async () => {
      vi.mocked(escrowCoordinator.getEscrowStatus).mockResolvedValue(fundedStatus({ status: "released" }));

      const result = await executeAutoRelease({
        escrowId: "42",
        orderId: "order-1",
        confirmedBy: "merchant-1",
        retryOptions: NO_SLEEP,
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/not releasable/i);
      expect(escrowCoordinator.releaseEscrow).not.toHaveBeenCalled();
    });
  });

  describe("executeAutoRelease — Soroban retry/backoff", () => {
    it("retries on transient failures and succeeds", async () => {
      vi.mocked(escrowCoordinator.getEscrowStatus).mockResolvedValue(fundedStatus());
      vi.mocked(escrowCoordinator.releaseEscrow)
        .mockRejectedValueOnce(new Error("RPC timeout"))
        .mockRejectedValueOnce(new Error("RPC timeout"))
        .mockResolvedValueOnce({
          txHash: "tx-recovered",
          ledger: 9,
          status: "released",
          sellerAddress: "GSELLER",
          amount: "1000",
        });

      const result = await executeAutoRelease({
        escrowId: "42",
        orderId: "order-1",
        confirmedBy: "merchant-1",
        retryOptions: NO_SLEEP,
      });

      expect(result.success).toBe(true);
      expect(result.retryCount).toBe(2);
      expect(escrowCoordinator.releaseEscrow).toHaveBeenCalledTimes(3);
    });

    it("gives up after 3 retries and reports failure", async () => {
      vi.mocked(escrowCoordinator.getEscrowStatus).mockResolvedValue(fundedStatus());
      vi.mocked(escrowCoordinator.releaseEscrow).mockRejectedValue(new Error("Soroban RPC down"));

      const result = await executeAutoRelease({
        escrowId: "42",
        orderId: "order-1",
        confirmedBy: "merchant-1",
        retryOptions: NO_SLEEP,
      });

      expect(result.success).toBe(false);
      expect(result.retryCount).toBe(3);
      expect(result.error).toMatch(/Soroban RPC down/);
      // Initial attempt + 3 retries.
      expect(escrowCoordinator.releaseEscrow).toHaveBeenCalledTimes(4);
    });
  });

  describe("executeAutoRelease — partial (pro-rata) release", () => {
    it("accrues a pro-rata share on interim confirmations without an on-chain call", async () => {
      await setAutoReleaseConfig({
        escrowId: "42",
        enabled: true,
        delayMinutes: 0,
        partialReleaseEnabled: true,
        requiredConfirmations: 2,
      });
      vi.mocked(escrowCoordinator.getEscrowStatus).mockResolvedValue(fundedStatus({ amount: "1000" }));

      const result = await executeAutoRelease({
        escrowId: "42",
        orderId: "order-1",
        confirmedBy: "merchant-1",
        retryOptions: NO_SLEEP,
      });

      expect(result.success).toBe(true);
      expect(result.releasedAmount).toBe("500");
      expect(result.remainingAmount).toBe("500");
      expect(result.transactionHash).toBeUndefined();
      expect(escrowCoordinator.releaseEscrow).not.toHaveBeenCalled();
    });

    it("submits the on-chain release on the final required confirmation", async () => {
      await setAutoReleaseConfig({
        escrowId: "42",
        enabled: true,
        delayMinutes: 0,
        partialReleaseEnabled: true,
        requiredConfirmations: 2,
      });
      vi.mocked(escrowCoordinator.getEscrowStatus).mockResolvedValue(fundedStatus({ amount: "1000" }));
      vi.mocked(escrowCoordinator.releaseEscrow).mockResolvedValue({
        txHash: "tx-final",
        ledger: 12,
        status: "released",
        sellerAddress: "GSELLER",
        amount: "1000",
      });

      const first = await executeAutoRelease({
        escrowId: "42",
        orderId: "order-1",
        confirmedBy: "merchant-1",
        retryOptions: NO_SLEEP,
      });
      const second = await executeAutoRelease({
        escrowId: "42",
        orderId: "order-1",
        confirmedBy: "merchant-1",
        retryOptions: NO_SLEEP,
      });

      expect(first.transactionHash).toBeUndefined();
      expect(second.success).toBe(true);
      expect(second.transactionHash).toBe("tx-final");
      expect(second.releasedAmount).toBe("500");
      expect(second.remainingAmount).toBe("0");
      expect(escrowCoordinator.releaseEscrow).toHaveBeenCalledTimes(1);
    });
  });

  describe("handleDeliveryConfirmation", () => {
    it("executes immediately when delayMinutes is 0 (default)", async () => {
      vi.mocked(escrowCoordinator.getEscrowStatus).mockResolvedValue(fundedStatus());
      vi.mocked(escrowCoordinator.releaseEscrow).mockResolvedValue({
        txHash: "tx-immediate",
        ledger: 1,
        status: "released",
        sellerAddress: "GSELLER",
        amount: "1000",
      });

      const result = await handleDeliveryConfirmation(confirmation());

      expect("scheduled" in result).toBe(false);
      if (!("scheduled" in result)) {
        expect(result.success).toBe(true);
        expect(result.transactionHash).toBe("tx-immediate");
      }
      expect(escrowCoordinator.releaseEscrow).toHaveBeenCalledTimes(1);
    });

    it("schedules the release and defers the Soroban call when delayMinutes > 0", async () => {
      process.env.NODE_ENV = "test";
      await setAutoReleaseConfig({
        escrowId: "42",
        enabled: true,
        delayMinutes: 5,
        partialReleaseEnabled: false,
        requiredConfirmations: 1,
      });
      vi.mocked(escrowCoordinator.getEscrowStatus).mockResolvedValue(fundedStatus());
      vi.mocked(escrowCoordinator.releaseEscrow).mockResolvedValue({
        txHash: "tx-delayed",
        ledger: 1,
        status: "released",
        sellerAddress: "GSELLER",
        amount: "1000",
      });

      const start = Date.now();
      const result = await handleDeliveryConfirmation(confirmation());

      expect("scheduled" in result && result.scheduled).toBe(true);
      expect(escrowCoordinator.releaseEscrow).not.toHaveBeenCalled();

      const ran = await runDueReleaseJobs(start + 5 * 60_000 + 5_000);
      expect(ran).toBe(1);
      expect(escrowCoordinator.releaseEscrow).toHaveBeenCalledTimes(1);
    });

    it("rejects (throws) for a disputed escrow before scheduling anything", async () => {
      vi.mocked(escrowCoordinator.getEscrowStatus).mockResolvedValue(fundedStatus({ status: "disputed" }));

      await expect(handleDeliveryConfirmation(confirmation())).rejects.toThrow(/disputed/i);
      expect(escrowCoordinator.releaseEscrow).not.toHaveBeenCalled();
    });

    it("returns a disabled-auto-release failure without touching escrow status", async () => {
      await setAutoReleaseConfig({
        escrowId: "42",
        enabled: false,
        delayMinutes: 0,
        partialReleaseEnabled: false,
        requiredConfirmations: 1,
      });

      const result = await handleDeliveryConfirmation(confirmation());

      expect("scheduled" in result).toBe(false);
      if (!("scheduled" in result)) {
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/disabled/i);
      }
      expect(escrowCoordinator.getEscrowStatus).not.toHaveBeenCalled();
    });
  });

  describe("adminOverrideRelease", () => {
    it("releases a disputed escrow by bypassing the automated dispute guard", async () => {
      vi.mocked(escrowCoordinator.getEscrowStatus).mockResolvedValue(fundedStatus({ status: "disputed" }));
      vi.mocked(escrowCoordinator.releaseEscrow).mockResolvedValue({
        txHash: "tx-override",
        ledger: 3,
        status: "released",
        sellerAddress: "GSELLER",
        amount: "1000",
      });

      const result = await adminOverrideRelease({
        escrowId: "42",
        orderId: "order-1",
        adminId: "admin-1",
        reason: "Dispute resolved in seller's favor",
        retryOptions: NO_SLEEP,
      });

      expect(result.success).toBe(true);
      expect(result.transactionHash).toBe("tx-override");
      expect(escrowCoordinator.releaseEscrow).toHaveBeenCalledTimes(1);
    });
  });
});
