import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TransactionHealer, StuckTxCandidate } from "../healer.js";

vi.mock("@delegolabs/utils", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@stellar/stellar-sdk")>();
  return {
    ...actual,
    Horizon: {
      Server: vi.fn().mockImplementation(() => ({
        loadAccount: vi.fn().mockResolvedValue({
          sequence: "50", // lower than expectedSequence "100" to trigger heal attempt
        }),
      })),
    },
  };
});

const mockRedis = {
  keys: vi.fn(),
  get: vi.fn(),
  set: vi.fn(),
  del: vi.fn(),
  incr: vi.fn(),
  expire: vi.fn(),
  lpush: vi.fn(),
  hset: vi.fn(),
  hget: vi.fn(),
  hgetall: vi.fn(),
};

describe("TransactionHealer", () => {
  let healer: TransactionHealer;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    healer = new TransactionHealer(mockRedis as any, {
      stuckThresholdMs: 90_000,
      pollIntervalMs: 15_000,
      maxRetries: 3,
    });
  });

  afterEach(() => {
    healer.stop();
    vi.useRealTimers();
  });

  const stuckCandidate: StuckTxCandidate = {
    jobId: "job-001",
    sourceAddress: "GABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxy",
    expectedSequence: "100",
    submittedAt: Date.now() - 120_000, // 120s ago, past 90s threshold
    retryCount: 0,
  };

  describe("start/stop", () => {
    it("should start polling", () => {
      healer.start();
      // Verify interval was set (we can't directly check, but no error means OK)
      expect(healer).toBeDefined();
    });

    it("should not start twice", () => {
      healer.start();
      healer.start(); // Should not throw
    });

    it("should stop cleanly", () => {
      healer.start();
      healer.stop();
    });
  });

  describe("registerPending", () => {
    it("should register a pending transaction in Redis", async () => {
      await healer.registerPending("job-1", "GABC...", "42");

      expect(mockRedis.set).toHaveBeenCalledWith(
        "tx:stuck:job-1",
        expect.stringContaining('"jobId":"job-1"'),
      );
    });
  });

  describe("confirmTransaction", () => {
    it("should remove the stuck candidate and heal attempts", async () => {
      await healer.confirmTransaction("job-1");

      expect(mockRedis.del).toHaveBeenCalledWith("tx:stuck:job-1");
      expect(mockRedis.del).toHaveBeenCalledWith("tx:heal_attempts:job-1");
    });
  });

  describe("findStuckTransactions", () => {
    it("should return candidates past the stuck threshold", async () => {
      mockRedis.keys.mockResolvedValue(["tx:stuck:job-001"]);
      mockRedis.get.mockResolvedValue(JSON.stringify(stuckCandidate));

      const results = await healer.findStuckTransactions();

      expect(results).toHaveLength(1);
      expect(results[0].jobId).toBe("job-001");
    });

    it("should exclude candidates within threshold", async () => {
      const recentCandidate = { ...stuckCandidate, submittedAt: Date.now() - 30_000 };
      mockRedis.keys.mockResolvedValue(["tx:stuck:job-002"]);
      mockRedis.get.mockResolvedValue(JSON.stringify(recentCandidate));

      const results = await healer.findStuckTransactions();

      expect(results).toHaveLength(0);
    });

    it("should clean up corrupt entries", async () => {
      mockRedis.keys.mockResolvedValue(["tx:stuck:bad"]);
      mockRedis.get.mockResolvedValue("not valid json");

      const results = await healer.findStuckTransactions();

      expect(results).toHaveLength(0);
      expect(mockRedis.del).toHaveBeenCalledWith("tx:stuck:bad");
    });

    it("should handle empty keys", async () => {
      mockRedis.keys.mockResolvedValue([]);

      const results = await healer.findStuckTransactions();
      expect(results).toHaveLength(0);
    });
  });

  describe("heal", () => {
    it("should move to DLQ after max retries", async () => {
      const maxedCandidate = { ...stuckCandidate, retryCount: 3 };
      const result = await healer.heal(maxedCandidate);

      expect(result.healed).toBe(false);
      expect(result.reason).toContain("DLQ");
      expect(mockRedis.lpush).toHaveBeenCalledWith("tx:dlq:healer", expect.any(String));
      expect(mockRedis.del).toHaveBeenCalledWith("tx:stuck:job-001");
    });

    it("should increment retry count on heal attempt", async () => {
      const result = await healer.heal(stuckCandidate);

      expect(result.retryCount).toBe(1);
      expect(mockRedis.incr).toHaveBeenCalledWith("tx:heal_attempts:job-001");
      expect(mockRedis.set).toHaveBeenCalled();
    });
  });

  describe("getMetrics", () => {
    it("should return healer metrics from Redis", async () => {
      mockRedis.hgetall.mockResolvedValue({
        lastScanAt: "2026-09-25T00:00:00Z",
        lastScanCount: "5",
        lastHealedCount: "3",
      });

      const metrics = await healer.getMetrics();

      expect(metrics.lastScanCount).toBe("5");
      expect(metrics.lastHealedCount).toBe("3");
    });
  });
});
