import { describe, it, expect, vi, beforeEach } from "vitest";
import { SponsoredSubmitter } from "../sponsoredSubmitter.js";

vi.mock("@delegolabs/utils", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const VALID_BUYER = "G" + "A".repeat(55);
const VALID_CONTRACT = "C" + "A".repeat(55);

const POLICY = {
  maxDailySponsoredLedgers: 3,
  maxSpendPerAccountStroops: "5000",
  authorizedContracts: [VALID_CONTRACT],
};

// Generate a real test secret so Keypair.fromSecret works if the signing
// path is hit.
import { Keypair } from "@stellar/stellar-sdk";
const TEST_KEYPAIR = Keypair.random();
const SPONSOR_SECRET = TEST_KEYPAIR.secret();

const FIXED_DATE = new Date("2026-01-15T10:00:00Z");

function makeManagerMock(overrides: Record<string, unknown> = {}) {
  return {
    isConfigured: vi.fn(() => true),
    getPolicy: vi.fn(() => POLICY),
    getDailyRemaining: vi.fn(async () => 3),
    getAccountRemainingStroops: vi.fn(async () => 5000n),
    recordSponsored: vi.fn(async () => undefined),
    sponsorSecret: SPONSOR_SECRET,
    ...overrides,
  };
}

function makeRequest(overrides: Record<string, unknown> = {}) {
  return {
    buyerAccount: VALID_BUYER,
    txXdr: "AAAA",
    contractId: VALID_CONTRACT,
    feeStroops: "100",
    ...overrides,
  };
}

describe("SponsoredSubmitter", () => {
  let manager: ReturnType<typeof makeManagerMock>;
  let sendTransaction: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = makeManagerMock();
    sendTransaction = vi.fn(async () => ({ hash: "deadbeef", status: "PENDING" }));
  });

  describe("denial path", () => {
    it("returns the eligibility reason without calling the RPC", async () => {
      manager.getDailyRemaining.mockResolvedValueOnce(0);

      const submitter = new SponsoredSubmitter({
        manager: manager as any,
        rpcUrl: "http://test",
        sendTransaction: sendTransaction as any,
        now: () => FIXED_DATE,
      });

      const res = await submitter.submit(makeRequest());

      expect(res.success).toBe(false);
      expect(res.reason).toBe("DAILY_LEDGER_BUDGET_EXCEEDED");
      expect(sendTransaction).not.toHaveBeenCalled();
      expect(manager.recordSponsored).not.toHaveBeenCalled();
    });
  });

  describe("submission path", () => {
    it("returns SUBMIT_FAILED when the XDR cannot be parsed", async () => {
      const submitter = new SponsoredSubmitter({
        manager: manager as any,
        rpcUrl: "http://test",
        sendTransaction: sendTransaction as any,
        now: () => FIXED_DATE,
      });

      const res = await submitter.submit(makeRequest({ txXdr: "not-a-valid-xdr" }));
      expect(res.success).toBe(false);
      expect(res.reason).toBe("SUBMIT_FAILED");
      expect(sendTransaction).not.toHaveBeenCalled();
    });

    it("does not record spend when the RPC returns a non-PENDING status", async () => {
      const sdk = await import("@stellar/stellar-sdk");
      const fakeTx = { sign: vi.fn(), toXDR: () => "signed-xdr" };
      vi.spyOn(sdk.TransactionBuilder, "fromXDR").mockReturnValue(fakeTx as any);

      const sendError = vi.fn(async () => ({ hash: "deadbeef", status: "ERROR" }));
      const submitter = new SponsoredSubmitter({
        manager: manager as any,
        rpcUrl: "http://test",
        sendTransaction: sendError as any,
        now: () => FIXED_DATE,
      });

      const res = await submitter.submit(makeRequest());
      expect(res.success).toBe(false);
      expect(res.reason).toBe("SUBMIT_FAILED");
      expect(manager.recordSponsored).not.toHaveBeenCalled();
    });

    it("records spend on PENDING", async () => {
      const sdk = await import("@stellar/stellar-sdk");
      const fakeTx = { sign: vi.fn(), toXDR: () => "signed-xdr" };
      vi.spyOn(sdk.TransactionBuilder, "fromXDR").mockReturnValue(fakeTx as any);

      const submitter = new SponsoredSubmitter({
        manager: manager as any,
        rpcUrl: "http://test",
        sendTransaction: sendTransaction as any,
        now: () => FIXED_DATE,
      });

      const res = await submitter.submit(makeRequest());
      expect(res.success).toBe(true);
      expect(res.txHash).toBe("deadbeef");
      expect(manager.recordSponsored).toHaveBeenCalledTimes(1);
      expect(manager.recordSponsored).toHaveBeenCalledWith(
        expect.objectContaining({
          account: VALID_BUYER,
          contractId: VALID_CONTRACT,
          feeStroops: "100",
          txHash: "deadbeef",
          sponsoredAt: FIXED_DATE.toISOString(),
        }),
      );
    });

    it("records spend on DUPLICATE (resubmit of an already-charged tx)", async () => {
      const sdk = await import("@stellar/stellar-sdk");
      const fakeTx = { sign: vi.fn(), toXDR: () => "signed-xdr" };
      vi.spyOn(sdk.TransactionBuilder, "fromXDR").mockReturnValue(fakeTx as any);

      const sendDup = vi.fn(async () => ({ hash: "deadbeef", status: "DUPLICATE" }));
      const submitter = new SponsoredSubmitter({
        manager: manager as any,
        rpcUrl: "http://test",
        sendTransaction: sendDup as any,
        now: () => FIXED_DATE,
      });

      const res = await submitter.submit(makeRequest());
      expect(res.success).toBe(true);
      expect(manager.recordSponsored).toHaveBeenCalledTimes(1);
    });

    it("returns SUBMIT_FAILED when the sender throws", async () => {
      const sdk = await import("@stellar/stellar-sdk");
      const fakeTx = { sign: vi.fn(), toXDR: () => "signed-xdr" };
      vi.spyOn(sdk.TransactionBuilder, "fromXDR").mockReturnValue(fakeTx as any);

      const sendThrow = vi.fn(async () => {
        throw new Error("boom");
      });
      const submitter = new SponsoredSubmitter({
        manager: manager as any,
        rpcUrl: "http://test",
        sendTransaction: sendThrow as any,
        now: () => FIXED_DATE,
      });

      const res = await submitter.submit(makeRequest());
      expect(res.success).toBe(false);
      expect(res.reason).toBe("SUBMIT_FAILED");
      expect(manager.recordSponsored).not.toHaveBeenCalled();
    });

    it("still returns success if recordSponsored throws (post-confirmation)", async () => {
      const sdk = await import("@stellar/stellar-sdk");
      const fakeTx = { sign: vi.fn(), toXDR: () => "signed-xdr" };
      vi.spyOn(sdk.TransactionBuilder, "fromXDR").mockReturnValue(fakeTx as any);

      manager.recordSponsored.mockRejectedValueOnce(new Error("redis down"));

      const submitter = new SponsoredSubmitter({
        manager: manager as any,
        rpcUrl: "http://test",
        sendTransaction: sendTransaction as any,
        now: () => FIXED_DATE,
      });

      const res = await submitter.submit(makeRequest());
      expect(res.success).toBe(true);
      expect(res.txHash).toBe("deadbeef");
    });
  });
});
