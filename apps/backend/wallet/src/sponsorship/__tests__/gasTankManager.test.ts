import { describe, it, expect, vi, beforeEach } from "vitest";
import { GasTankManager } from "../gasTankManager.js";
import type { GasSponsorshipPolicy } from "../types.js";

vi.mock("@delegolabs/utils", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const POLICY: GasSponsorshipPolicy = {
  maxDailySponsoredLedgers: 3,
  maxSpendPerAccountStroops: "5000",
  authorizedContracts: ["C" + "A".repeat(55)],
};

const FIXED_DATE = new Date("2026-01-15T10:00:00Z");

function makeRedisMock() {
  return {
    get: vi.fn(),
    setex: vi.fn(),
    incr: vi.fn(),
    incrby: vi.fn(),
    expire: vi.fn(),
    lpush: vi.fn(),
    ltrim: vi.fn(),
    lrange: vi.fn(),
  };
}

describe("GasTankManager", () => {
  let redis: ReturnType<typeof makeRedisMock>;
  let manager: GasTankManager;

  beforeEach(() => {
    vi.clearAllMocks();
    redis = makeRedisMock();
    manager = new GasTankManager({
      redis: redis as any,
      policy: POLICY,
      sponsorSecret: "STEST",
      now: () => FIXED_DATE,
    });
  });

  describe("configuration", () => {
    it("reports configured when sponsor secret is present", () => {
      expect(manager.isConfigured()).toBe(true);
    });

    it("reports not configured when sponsor secret is empty", () => {
      const m = new GasTankManager({
        redis: redis as any,
        policy: POLICY,
        sponsorSecret: "",
      });
      expect(m.isConfigured()).toBe(false);
    });

    it("exposes the policy", () => {
      expect(manager.getPolicy()).toEqual(POLICY);
    });
  });

  describe("daily ledger budget", () => {
    it("returns 0 when no ledgers recorded", async () => {
      redis.get.mockResolvedValueOnce(null);
      expect(await manager.getDailyLedgers()).toBe(0);
    });

    it("parses recorded count from Redis", async () => {
      redis.get.mockResolvedValueOnce("2");
      expect(await manager.getDailyLedgers()).toBe(2);
    });

    it("computes remaining as cap - used", async () => {
      redis.get.mockResolvedValueOnce("1");
      expect(await manager.getDailyRemaining()).toBe(2);
    });

    it("floors remaining at 0 when over budget", async () => {
      redis.get.mockResolvedValueOnce("5");
      expect(await manager.getDailyRemaining()).toBe(0);
    });

    it("uses UTC YYYY-MM-DD as the bucket key", async () => {
      redis.get.mockResolvedValueOnce(null);
      await manager.getDailyLedgers();
      expect(redis.get).toHaveBeenCalledWith("gasTank:dailyLedgers:2026-01-15");
    });
  });

  describe("per-account budget", () => {
    it("returns 0n for an unseen account", async () => {
      redis.get.mockResolvedValueOnce(null);
      expect(await manager.getAccountSpendStroops("GBUYER")).toBe(0n);
    });

    it("parses stroops spend from Redis", async () => {
      redis.get.mockResolvedValueOnce("2500");
      expect(await manager.getAccountSpendStroops("GBUYER")).toBe(2500n);
    });

    it("computes remaining per-account stroops", async () => {
      redis.get.mockResolvedValueOnce("1500");
      expect(await manager.getAccountRemainingStroops("GBUYER")).toBe(3500n);
    });

    it("returns 0n when account is over cap", async () => {
      redis.get.mockResolvedValueOnce("9999");
      expect(await manager.getAccountRemainingStroops("GBUYER")).toBe(0n);
    });
  });

  describe("recordSponsored", () => {
    it("increments daily counter and sets TTL on first increment", async () => {
      redis.incr.mockResolvedValueOnce(1);
      redis.incrby.mockResolvedValueOnce(0);

      await manager.recordSponsored({
        account: "GBUYER",
        contractId: "CAUTH",
        feeStroops: "100",
        txHash: "abc",
        sponsoredAt: FIXED_DATE.toISOString(),
      });

      expect(redis.incr).toHaveBeenCalledWith("gasTank:dailyLedgers:2026-01-15");
      expect(redis.expire).toHaveBeenCalledTimes(1);
    });

    it("does not reset TTL on subsequent increments", async () => {
      redis.incr.mockResolvedValueOnce(2);
      redis.incrby.mockResolvedValueOnce(0);

      await manager.recordSponsored({
        account: "GBUYER",
        contractId: "CAUTH",
        feeStroops: "100",
        txHash: "abc",
        sponsoredAt: FIXED_DATE.toISOString(),
      });

      expect(redis.expire).not.toHaveBeenCalled();
    });

    it("adds fee stroops to the per-account counter", async () => {
      redis.incr.mockResolvedValueOnce(1);
      redis.incrby.mockResolvedValueOnce(100);

      await manager.recordSponsored({
        account: "GBUYER",
        contractId: "CAUTH",
        feeStroops: "250",
        txHash: "abc",
        sponsoredAt: FIXED_DATE.toISOString(),
      });

      expect(redis.incrby).toHaveBeenCalledWith("gasTank:accountSpend:GBUYER", 250);
    });

    it("pushes the ledger entry and trims the log", async () => {
      redis.incr.mockResolvedValueOnce(1);
      redis.incrby.mockResolvedValueOnce(100);

      await manager.recordSponsored({
        account: "GBUYER",
        contractId: "CAUTH",
        feeStroops: "100",
        txHash: "abc",
        sponsoredAt: FIXED_DATE.toISOString(),
      });

      expect(redis.lpush).toHaveBeenCalledTimes(1);
      expect(redis.ltrim).toHaveBeenCalledWith("gasTank:ledgerLog", 0, 999);
    });
  });

  describe("recentLedgers", () => {
    it("returns parsed entries newest-first", async () => {
      redis.lrange.mockResolvedValueOnce([
        JSON.stringify({
          account: "GBUYER",
          contractId: "CAUTH",
          feeStroops: "100",
          txHash: "abc",
          sponsoredAt: FIXED_DATE.toISOString(),
        }),
      ]);

      const result = await manager.recentLedgers(10);
      expect(result).toHaveLength(1);
      expect(result[0].txHash).toBe("abc");
    });

    it("defaults to 50 entries", async () => {
      redis.lrange.mockResolvedValueOnce([]);
      await manager.recentLedgers();
      expect(redis.lrange).toHaveBeenCalledWith("gasTank:ledgerLog", 0, 49);
    });
  });
});
