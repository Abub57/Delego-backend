/**
 * Sponsorship end-to-end integration test.
 *
 * Wires GasTankManager + checkEligibility + SponsoredSubmitter with a
 * shared in-memory Redis mock and a stubbed RPC sender. Verifies the
 * full sponsored-submission lifecycle:
 *
 *   1. First submission succeeds and records spend.
 *   2. Subsequent submissions for the same account deplete the
 *      per-account budget.
 *   3. Once the per-account budget is exhausted, further submissions
 *      are denied with ACCOUNT_BUDGET_EXCEEDED.
 *   4. The daily ledger cap is honoured independently.
 *
 * Uses one shared Redis mock so budget accounting is genuinely
 * stateful across calls.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { GasTankManager } from "../gasTankManager.js";
import { SponsoredSubmitter } from "../sponsoredSubmitter.js";
import type { GasSponsorshipPolicy } from "../types.js";
import { Keypair } from "@stellar/stellar-sdk";

vi.mock("@delegolabs/utils", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// In-memory Redis mock (stateful)
// ---------------------------------------------------------------------------

function makeInMemoryRedis() {
  const strings = new Map<string, string>();
  const lists = new Map<string, string[]>();

  return {
    async get(key: string): Promise<string | null> {
      return strings.get(key) ?? null;
    },
    async incr(key: string): Promise<number> {
      const current = parseInt(strings.get(key) ?? "0", 10);
      const next = current + 1;
      strings.set(key, String(next));
      return next;
    },
    async incrby(key: string, by: number): Promise<number> {
      const current = parseInt(strings.get(key) ?? "0", 10);
      const next = current + by;
      strings.set(key, String(next));
      return next;
    },
    async expire(_key: string, _seconds: number): Promise<number> {
      return 1;
    },
    async lpush(key: string, value: string): Promise<number> {
      const list = lists.get(key) ?? [];
      list.unshift(value);
      lists.set(key, list);
      return list.length;
    },
    async ltrim(key: string, start: number, stop: number): Promise<string> {
      const list = lists.get(key) ?? [];
      lists.set(key, list.slice(start, stop + 1));
      return "OK";
    },
    async lrange(key: string, start: number, stop: number): Promise<string[]> {
      const list = lists.get(key) ?? [];
      return list.slice(start, stop + 1);
    },
    // test helpers
    _strings: strings,
    _lists: lists,
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_BUYER = "G" + "A".repeat(55);
const VALID_CONTRACT = "C" + "A".repeat(55);
const FIXED_DATE = new Date("2026-01-15T10:00:00Z");

const SPONSOR_KEYPAIR = Keypair.random();

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe("sponsorship end-to-end", () => {
  let redis: ReturnType<typeof makeInMemoryRedis>;
  let policy: GasSponsorshipPolicy;
  let manager: GasTankManager;
  let sender: ReturnType<typeof vi.fn>;
  let submitter: SponsoredSubmitter;

  beforeEach(async () => {
    vi.clearAllMocks();

    const sdk = await import("@stellar/stellar-sdk");
    const fakeTx = { sign: vi.fn(), toXDR: () => "signed-xdr" };
    vi.spyOn(sdk.TransactionBuilder, "fromXDR").mockReturnValue(fakeTx as any);

    redis = makeInMemoryRedis();

    policy = {
      maxDailySponsoredLedgers: 10,
      maxSpendPerAccountStroops: "300", // room for exactly 3 × 100 stroop submissions
      authorizedContracts: [VALID_CONTRACT],
    };

    manager = new GasTankManager({
      redis: redis as any,
      policy,
      sponsorSecret: SPONSOR_KEYPAIR.secret(),
      now: () => FIXED_DATE,
    });

    sender = vi.fn(async () => ({ hash: "hash-" + Math.random().toString(36).slice(2), status: "PENDING" }));

    submitter = new SponsoredSubmitter({
      manager,
      rpcUrl: "http://test",
      sendTransaction: sender as any,
      now: () => FIXED_DATE,
    });
  });

  it("first submission succeeds and records spend", async () => {
    const res = await submitter.submit({
      buyerAccount: VALID_BUYER,
      txXdr: "AAAA",
      contractId: VALID_CONTRACT,
      feeStroops: "100",
    });

    expect(res.success).toBe(true);
    expect(res.txHash).toBeTruthy();

    // Spend was recorded
    expect(await manager.getAccountSpendStroops(VALID_BUYER)).toBe(100n);
    expect(await manager.getDailyLedgers()).toBe(1);

    // Audit log has one entry
    const log = await manager.recentLedgers();
    expect(log).toHaveLength(1);
    expect(log[0].account).toBe(VALID_BUYER);
    expect(log[0].feeStroops).toBe("100");
  });

  it("depletes per-account budget across three submissions, then denies the fourth", async () => {
    const makeReq = () => ({
      buyerAccount: VALID_BUYER,
      txXdr: "AAAA",
      contractId: VALID_CONTRACT,
      feeStroops: "100",
    });

    // 3 × 100 stroops fits exactly in 300 stroops budget
    const r1 = await submitter.submit(makeReq());
    const r2 = await submitter.submit(makeReq());
    const r3 = await submitter.submit(makeReq());
    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
    expect(r3.success).toBe(true);

    expect(await manager.getAccountSpendStroops(VALID_BUYER)).toBe(300n);
    expect(await manager.getAccountRemainingStroops(VALID_BUYER)).toBe(0n);

    // 4th submission: budget exhausted → denied, sender NOT called again
    const senderCallCount = sender.mock.calls.length;
    const r4 = await submitter.submit(makeReq());
    expect(r4.success).toBe(false);
    expect(r4.reason).toBe("ACCOUNT_BUDGET_EXCEEDED");
    expect(sender.mock.calls.length).toBe(senderCallCount); // no new call
  });

  it("honours the daily ledger cap independently of per-account budget", async () => {
    // Shrink daily cap to 2 for this test
    const tinyRedis = makeInMemoryRedis();
    const tinyPolicy: GasSponsorshipPolicy = {
      maxDailySponsoredLedgers: 2,
      maxSpendPerAccountStroops: "100000", // plenty
      authorizedContracts: [VALID_CONTRACT],
    };
    const tinyManager = new GasTankManager({
      redis: tinyRedis as any,
      policy: tinyPolicy,
      sponsorSecret: SPONSOR_KEYPAIR.secret(),
      now: () => FIXED_DATE,
    });
    const tinySubmitter = new SponsoredSubmitter({
      manager: tinyManager,
      rpcUrl: "http://test",
      sendTransaction: sender as any,
      now: () => FIXED_DATE,
    });

    const req = {
      buyerAccount: VALID_BUYER,
      txXdr: "AAAA",
      contractId: VALID_CONTRACT,
      feeStroops: "50",
    };

    expect((await tinySubmitter.submit(req)).success).toBe(true);
    expect((await tinySubmitter.submit(req)).success).toBe(true);

    // Third one exceeds daily cap of 2
    const r3 = await tinySubmitter.submit(req);
    expect(r3.success).toBe(false);
    expect(r3.reason).toBe("DAILY_LEDGER_BUDGET_EXCEEDED");
  });

  it("denies unauthorized contracts and does not consume budget", async () => {
    const otherContract = "C" + "B".repeat(55);
    const res = await submitter.submit({
      buyerAccount: VALID_BUYER,
      txXdr: "AAAA",
      contractId: otherContract,
      feeStroops: "100",
    });

    expect(res.success).toBe(false);
    expect(res.reason).toBe("CONTRACT_NOT_AUTHORIZED");

    // Budget untouched
    expect(await manager.getAccountSpendStroops(VALID_BUYER)).toBe(0n);
    expect(await manager.getDailyLedgers()).toBe(0);
    expect(sender).not.toHaveBeenCalled();
  });

  it("does not consume budget when the RPC returns a non-PENDING status", async () => {
    sender.mockResolvedValueOnce({ hash: "rejected", status: "ERROR" });

    const res = await submitter.submit({
      buyerAccount: VALID_BUYER,
      txXdr: "AAAA",
      contractId: VALID_CONTRACT,
      feeStroops: "100",
    });

    expect(res.success).toBe(false);
    expect(res.reason).toBe("SUBMIT_FAILED");

    // No spend recorded
    expect(await manager.getAccountSpendStroops(VALID_BUYER)).toBe(0n);
    expect(await manager.getDailyLedgers()).toBe(0);
  });
});
