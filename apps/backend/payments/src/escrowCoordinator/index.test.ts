import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FundEscrowParams, PaymentRecord } from "./types.js";
import { escrowCoordinator } from "./index.js";
import { extractEscrowIdFromTx, submitContractInvocation } from "./contractClient.js";
import { checkEscrowVelocity } from "./fraudGuard.js";
import {
  createPaymentRecord,
  findPaymentRecordByOrderId,
  updatePaymentRecord,
} from "./paymentRecordStore.js";

vi.mock("./contractClient.js", () => ({
  submitContractInvocation: vi.fn(),
  extractEscrowIdFromTx: vi.fn(),
  getContractReadSourceAddress: vi.fn((fallback?: string) => fallback ?? "GREAD"),
  mapChainEscrowStatus: vi.fn(),
  orderIdToContractBytes: vi.fn(() => Buffer.alloc(32)),
  readEscrowFromChain: vi.fn(),
}));

vi.mock("./paymentRecordStore.js", () => ({
  findPaymentRecordByOrderId: vi.fn(),
  findPaymentRecordByEscrowId: vi.fn(),
  createPaymentRecord: vi.fn(),
  updatePaymentRecord: vi.fn(),
  incrementPaymentRecordAmounts: vi.fn(),
}));

vi.mock("./redisEvents.js", () => ({
  publishPaymentStatusEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./escrowFundingLock.js", () => ({
  getEscrowFundingLockManager: vi.fn(() => ({
    acquireLock: vi.fn().mockResolvedValue(null),
    releaseLock: vi.fn(),
  })),
}));

// `fundEscrow` calls the fraud guard before submitting, and the real guard
// fetches FRAUD_DETECTION_URL (localhost:3013 by default). Under fake timers
// that fetch never settles, so the test would time out instead of exercising
// the retry logic.
vi.mock("./fraudGuard.js", () => ({
  checkEscrowVelocity: vi.fn().mockResolvedValue({ paused: false }),
}));

function makeRecord(overrides: Partial<PaymentRecord> = {}): PaymentRecord {
  return {
    id: "rec-1",
    orderId: "order-1",
    escrowId: null,
    escrowContractId: "CCONTRACTID00000000000000000000000000000000000000000000000",
    buyerAddress: "GBUYERADDRESS0000000000000000000000000000000000000000000000",
    sellerAddress: "GSELLERADDRESS000000000000000000000000000000000000000000000",
    tokenContractId: "CTOKENID0000000000000000000000000000000000000000000000000",
    amountStroops: "1000",
    status: "pending",
    fundTxHash: null,
    releaseTxHash: null,
    refundTxHash: null,
    disputeTxHash: null,
    releasedAmountStroops: "0",
    refundedAmountStroops: "0",
    failureReason: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

const fundParams: FundEscrowParams = {
  orderId: "order-1",
  buyerAddress: "GBUYERADDRESS0000000000000000000000000000000000000000000000",
  sellerAddress: "GSELLERADDRESS000000000000000000000000000000000000000000000",
  tokenContractId: "CTOKENID0000000000000000000000000000000000000000000000000",
  amountStroops: "1000",
  escrowContractId: "CCONTRACTID00000000000000000000000000000000000000000000000",
  timeoutLedgers: 100,
};

/**
 * Drives the fake clock until `promise` settles.
 *
 * The retry helper schedules its next backoff sleep only once the previous
 * attempt has settled, so a single `advanceTimersByTimeAsync` call cannot walk
 * the whole 2s/4s/8s schedule — the clock has to be pumped repeatedly while the
 * promise chain between sleeps makes progress.
 */
async function settleWithClock<T>(promise: Promise<T>): Promise<T> {
  let settled = false;
  const markSettled = (): void => {
    settled = true;
  };
  void promise.then(markSettled, markSettled);
  for (let pass = 0; pass < 50 && !settled; pass++) {
    await vi.advanceTimersByTimeAsync(60_000);
  }
  return promise;
}

describe("escrowCoordinator.fundEscrow — contract invocation retry (Issue #11)", () => {
  beforeEach(() => {
    vi.mocked(submitContractInvocation).mockReset();
    vi.mocked(extractEscrowIdFromTx).mockReset();
    vi.mocked(findPaymentRecordByOrderId).mockReset();
    vi.mocked(createPaymentRecord).mockReset();
    vi.mocked(updatePaymentRecord).mockReset();
    vi.mocked(checkEscrowVelocity).mockReset();

    vi.mocked(findPaymentRecordByOrderId).mockResolvedValue(null);
    vi.mocked(createPaymentRecord).mockImplementation(async () => makeRecord());
    vi.mocked(updatePaymentRecord).mockImplementation(async (id, update) =>
      makeRecord({ id, ...update } as Partial<PaymentRecord>)
    );
    vi.mocked(checkEscrowVelocity).mockResolvedValue({ paused: false });

    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("retries transient RPC failures before marking the payment funded", async () => {
    vi.mocked(submitContractInvocation)
      .mockRejectedValueOnce(new Error("Wallet service unavailable: fetch failed"))
      .mockRejectedValueOnce(new Error("Wallet service unavailable: ECONNRESET"))
      .mockResolvedValueOnce({ hash: "tx-fund", ledger: 7, success: true });
    vi.mocked(extractEscrowIdFromTx).mockResolvedValue("99");

    const result = await settleWithClock(escrowCoordinator.fundEscrow(fundParams));

    expect(result).toEqual({ escrowId: "99", txHash: "tx-fund", ledger: 7, status: "funded" });
    expect(submitContractInvocation).toHaveBeenCalledTimes(3);
  });

  it("does not retry contract logic errors and fails the payment immediately", async () => {
    const contractError = new Error("Error(Contract, #35) CollateralRatioBelowMinimum");
    vi.mocked(submitContractInvocation).mockRejectedValue(contractError);

    const result = await settleWithClock(escrowCoordinator.fundEscrow(fundParams));

    expect(result.status).toBe("failed");
    expect(submitContractInvocation).toHaveBeenCalledTimes(1);
    expect(updatePaymentRecord).toHaveBeenCalledWith("rec-1", {
      status: "failed",
      failureReason: contractError.message,
    });
  });

  it("marks the payment failed once transient retries are exhausted", async () => {
    const lastError = new Error("Wallet service unavailable: ETIMEDOUT");
    vi.mocked(submitContractInvocation).mockRejectedValue(lastError);

    const result = await settleWithClock(escrowCoordinator.fundEscrow(fundParams));

    expect(result.status).toBe("failed");
    // Initial attempt + 3 retries.
    expect(submitContractInvocation).toHaveBeenCalledTimes(4);
    expect(updatePaymentRecord).toHaveBeenCalledWith("rec-1", {
      status: "failed",
      failureReason: lastError.message,
    });
  });
});
