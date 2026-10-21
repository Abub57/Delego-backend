import { describe, it, expect, vi, beforeEach } from "vitest";
import { AdaptiveFeeEstimator, DEFAULT_ADAPTIVE_CONFIG } from "../adaptiveFeeEstimator.js";

vi.mock("@delegolabs/payments/fee-estimator", () => ({
  estimateTransactionFee: vi.fn(),
}));

import { estimateTransactionFee } from "@delegolabs/payments/fee-estimator";

const mockRedis = {
  get: vi.fn(),
  setex: vi.fn(),
  del: vi.fn(),
  hset: vi.fn(),
  hgetall: vi.fn(),
};

describe("AdaptiveFeeEstimator", () => {
  let estimator: AdaptiveFeeEstimator;

  beforeEach(() => {
    vi.clearAllMocks();
    estimator = new AdaptiveFeeEstimator(mockRedis as any);
  });

  const calmEstimate = { recommendedFeeStroops: "100", p50: 100, p95: 120, p99: 150, source: "horizon" };
  const surgingEstimate = { recommendedFeeStroops: "600", p50: 200, p95: 600, p99: 1500, source: "horizon" };
  const moderateEstimate = { recommendedFeeStroops: "200", p50: 100, p95: 180, p99: 250, source: "horizon" };

  describe("assessCongestion", () => {
    it("should return calm when fees are low and stable", () => {
      const result = estimator.assessCongestion(calmEstimate as any);
      expect(result).toBe("calm");
    });

    it("should return surging when p95 exceeds threshold", () => {
      const result = estimator.assessCongestion(surgingEstimate as any);
      expect(result).toBe("surging");
    });

    it("should return surging when fee variance is high", () => {
      const highVariance = { recommendedFeeStroops: "300", p50: 100, p95: 300, p99: 500, source: "horizon" };
      const result = estimator.assessCongestion(highVariance as any);
      expect(result).toBe("surging");
    });

    it("should return moderate when p95/p50 ratio is between 1.5 and variance threshold", () => {
      const result = estimator.assessCongestion(moderateEstimate as any);
      expect(result).toBe("moderate");
    });
  });

  describe("computeAdaptiveTtl", () => {
    it("should return minTtl for surging", () => {
      expect(estimator.computeAdaptiveTtl("surging")).toBe(DEFAULT_ADAPTIVE_CONFIG.minTtlSeconds);
    });

    it("should return maxTtl for calm", () => {
      expect(estimator.computeAdaptiveTtl("calm")).toBe(DEFAULT_ADAPTIVE_CONFIG.maxTtlSeconds);
    });

    it("should return intermediate TTL for moderate", () => {
      const ttl = estimator.computeAdaptiveTtl("moderate");
      expect(ttl).toBeGreaterThan(DEFAULT_ADAPTIVE_CONFIG.minTtlSeconds);
      expect(ttl).toBeLessThan(DEFAULT_ADAPTIVE_CONFIG.maxTtlSeconds);
    });
  });

  describe("getFee", () => {
    it("should return cached estimate when available", async () => {
      const cached = {
        feeStroops: "100",
        estimate: calmEstimate,
        cachedAt: new Date().toISOString(),
        ttlSeconds: 60,
        congestionLevel: "calm",
      };
      mockRedis.get.mockResolvedValue(JSON.stringify(cached));

      const result = await estimator.getFee("https://horizon-testnet.stellar.org");

      expect(result.fromCache).toBe(true);
      expect(result.feeStroops).toBe("100");
      expect(estimateTransactionFee).not.toHaveBeenCalled();
    });

    it("should fetch fresh estimate on cache miss", async () => {
      mockRedis.get.mockResolvedValue(null);
      vi.mocked(estimateTransactionFee).mockResolvedValue(calmEstimate as any);

      const result = await estimator.getFee("https://horizon-testnet.stellar.org");

      expect(result.fromCache).toBe(false);
      expect(result.feeStroops).toBe("100");
      expect(result.congestionLevel).toBe("calm");
      expect(mockRedis.setex).toHaveBeenCalledWith(
        "fee:adaptive:estimate",
        60,
        expect.any(String),
      );
    });

    it("should use minTtl (5s) when network is surging", async () => {
      mockRedis.get.mockResolvedValue(null);
      vi.mocked(estimateTransactionFee).mockResolvedValue(surgingEstimate as any);

      const result = await estimator.getFee("https://horizon-testnet.stellar.org");

      expect(result.congestionLevel).toBe("surging");
      expect(result.ttlSeconds).toBe(5);
      expect(mockRedis.setex).toHaveBeenCalledWith(
        "fee:adaptive:estimate",
        5,
        expect.any(String),
      );
    });

    it("should invalidate cache when requested", async () => {
      await estimator.invalidateCache();
      expect(mockRedis.del).toHaveBeenCalledWith("fee:adaptive:estimate");
    });
  });

  describe("inspectFeeDelta", () => {
    it("should return fee percentile diagnostics", async () => {
      vi.mocked(estimateTransactionFee).mockResolvedValue(calmEstimate as any);

      const delta = await estimator.inspectFeeDelta("https://horizon-testnet.stellar.org");

      expect(delta.p50).toBe(100);
      expect(delta.p99).toBe(150);
      expect(delta.delta).toBe(50);
      expect(delta.congestion).toBe("calm");
    });
  });
});
