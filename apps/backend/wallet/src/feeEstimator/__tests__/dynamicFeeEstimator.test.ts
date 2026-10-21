import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  DynamicFeeEstimator,
  DEFAULT_DYNAMIC_FEE_CONFIG,
} from "../dynamicFeeEstimator.js";
import type { HorizonFeeStatsResponse } from "@delegolabs/types";

describe("DynamicFeeEstimator", () => {
  let mockRedis: {
    get: any;
    setex: any;
    del: any;
    hset: any;
    hgetall: any;
  };
  let estimator: DynamicFeeEstimator;

  const sampleLowCongestionStats: HorizonFeeStatsResponse = {
    last_ledger: 100000,
    last_ledger_base_fee: 100,
    ledger_capacity_usage: 0.15,
    fee_charged: {
      min: 100,
      mode: 100,
      max: 150,
      p10: 100,
      p20: 100,
      p30: 100,
      p40: 100,
      p50: 100,
      p60: 100,
      p70: 100,
      p80: 100,
      p90: 120,
      p95: 130,
      p99: 150,
    },
    max_fee: {
      min: 100,
      mode: 100,
      max: 200,
      p10: 100,
      p20: 100,
      p30: 100,
      p40: 100,
      p50: 100,
      p60: 100,
      p70: 100,
      p80: 100,
      p90: 150,
      p95: 180,
      p99: 200,
    },
  };

  const sampleMediumCongestionStats: HorizonFeeStatsResponse = {
    last_ledger: 100001,
    last_ledger_base_fee: 100,
    ledger_capacity_usage: 0.65,
    fee_charged: {
      min: 100,
      mode: 150,
      max: 600,
      p10: 100,
      p20: 120,
      p30: 150,
      p40: 180,
      p50: 200,
      p60: 250,
      p70: 300,
      p80: 350,
      p90: 450,
      p95: 500,
      p99: 600,
    },
    max_fee: {
      min: 100,
      mode: 200,
      max: 800,
      p10: 120,
      p20: 150,
      p30: 180,
      p40: 220,
      p50: 250,
      p60: 300,
      p70: 400,
      p80: 500,
      p90: 650,
      p95: 750,
      p99: 800,
    },
  };

  const sampleHighCongestionSurgeStats: HorizonFeeStatsResponse = {
    last_ledger: 100002,
    last_ledger_base_fee: 100,
    ledger_capacity_usage: 0.92,
    fee_charged: {
      min: 100,
      mode: 500,
      max: 10000,
      p10: 200,
      p20: 300,
      p30: 400,
      p40: 600,
      p50: 1000,
      p60: 1500,
      p70: 2000,
      p80: 3000,
      p90: 5000,
      p95: 8000,
      p99: 10000,
    },
    max_fee: {
      min: 200,
      mode: 1000,
      max: 20000,
      p10: 300,
      p20: 500,
      p30: 800,
      p40: 1200,
      p50: 2000,
      p60: 3500,
      p70: 5000,
      p80: 8000,
      p90: 12000,
      p95: 15000,
      p99: 20000,
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockRedis = {
      get: vi.fn(),
      setex: vi.fn(),
      del: vi.fn(),
      hset: vi.fn(),
      hgetall: vi.fn(),
    };
    estimator = new DynamicFeeEstimator(
      mockRedis as any,
      "https://horizon-testnet.stellar.org",
      {
        maxFeeCapStroops: 50_000,
        minFallbackFeeStroops: 100,
        cacheTtlSeconds: 15,
        pollingIntervalMs: 15000,
      },
    );
  });

  afterEach(() => {
    estimator.stop();
  });

  describe("calculateRecommendation & determineCongestionLevel", () => {
    it("should classify low congestion when capacity usage and variance are low", () => {
      const rec = estimator.calculateRecommendation(sampleLowCongestionStats);
      expect(rec.currentCongestionLevel).toBe("low");
      expect(rec.baseFee).toBe(100);
      expect(rec.lowStroops).toBe(100);
      expect(rec.standardStroops).toBe(100);
      expect(rec.priorityStroops).toBeGreaterThanOrEqual(rec.standardStroops);
    });

    it("should classify medium congestion when capacity is moderate", () => {
      const rec = estimator.calculateRecommendation(sampleMediumCongestionStats);
      expect(rec.currentCongestionLevel).toBe("medium");
      expect(rec.standardStroops).toBeGreaterThan(100);
      expect(rec.priorityStroops).toBeGreaterThanOrEqual(rec.standardStroops);
    });

    it("should classify high congestion when capacity is above threshold and fees surge", () => {
      const rec = estimator.calculateRecommendation(sampleHighCongestionSurgeStats);
      expect(rec.currentCongestionLevel).toBe("high");
      expect(rec.standardStroops).toBeGreaterThan(1000);
      expect(rec.priorityStroops).toBeGreaterThanOrEqual(rec.standardStroops);
    });

    it("should cap maximum fee when surge exceeds maxFeeCapStroops", () => {
      const extremeSurgeStats: HorizonFeeStatsResponse = {
        last_ledger: 100003,
        last_ledger_base_fee: 100,
        ledger_capacity_usage: 0.99,
        max_fee: {
          min: 1000,
          mode: 50000,
          max: 500000,
          p10: 10000,
          p20: 20000,
          p30: 30000,
          p40: 40000,
          p50: 60000,
          p60: 70000,
          p70: 80000,
          p80: 90000,
          p90: 120000,
          p95: 200000,
          p99: 500000,
        },
      };

      const rec = estimator.calculateRecommendation(extremeSurgeStats);
      expect(rec.currentCongestionLevel).toBe("high");
      expect(rec.priorityStroops).toBeLessThanOrEqual(50_000); // Clamped at 50,000 cap
      expect(rec.standardStroops).toBeLessThanOrEqual(50_000);
      expect(rec.lowStroops).toBeLessThanOrEqual(50_000);
    });
  });

  describe("clampFee", () => {
    it("should enforce minimum fallback fee", () => {
      expect(estimator.clampFee(0)).toBe(100);
      expect(estimator.clampFee(-50)).toBe(100);
    });

    it("should enforce maximum fee cap", () => {
      expect(estimator.clampFee(1_000_000)).toBe(50_000);
    });
  });

  describe("getFeeRecommendation with Redis cache", () => {
    it("should return cached recommendation when cache hit and not expired", async () => {
      const cachedRecommendation = {
        lowStroops: 100,
        standardStroops: 120,
        priorityStroops: 200,
        currentCongestionLevel: "low",
        baseFee: 100,
      };

      mockRedis.get.mockResolvedValue(
        JSON.stringify({
          recommendation: cachedRecommendation,
          expiresAt: Date.now() + 10000,
        }),
      );

      const rec = await estimator.getFeeRecommendation("https://horizon-testnet.stellar.org");
      expect(rec).toEqual(cachedRecommendation);
      expect(mockRedis.get).toHaveBeenCalled();
    });

    it("should refresh from Horizon and cache when Redis has a cache miss", async () => {
      mockRedis.get.mockResolvedValue(null);
      vi.spyOn(estimator, "fetchHorizonFeeStats").mockResolvedValue(sampleLowCongestionStats);

      const rec = await estimator.getFeeRecommendation("https://horizon-testnet.stellar.org");
      expect(rec.currentCongestionLevel).toBe("low");
      expect(mockRedis.setex).toHaveBeenCalledWith(
        expect.stringContaining("stellar:fee_stats"),
        15,
        expect.any(String),
      );
      expect(mockRedis.hset).toHaveBeenCalledWith(
        "stellar:fee_stats:metrics",
        expect.objectContaining({
          lastCongestionLevel: "low",
        }),
      );
    });
  });

  describe("getFeeForUrgency", () => {
    beforeEach(() => {
      vi.spyOn(estimator, "getFeeRecommendation").mockResolvedValue({
        lowStroops: 100,
        standardStroops: 250,
        priorityStroops: 800,
        currentCongestionLevel: "medium",
        baseFee: 100,
      });
    });

    it("should return low fee for 'low' urgency", async () => {
      const fee = await estimator.getFeeForUrgency("low");
      expect(fee).toBe("100");
    });

    it("should return standard fee for 'standard' urgency", async () => {
      const fee = await estimator.getFeeForUrgency("standard");
      expect(fee).toBe("250");
    });

    it("should return priority fee for 'priority' urgency", async () => {
      const fee = await estimator.getFeeForUrgency("priority");
      expect(fee).toBe("800");
    });
  });

  describe("fallback behavior on Horizon errors", () => {
    it("should return safe fallback recommendation when Horizon fails", async () => {
      mockRedis.get.mockResolvedValue(null);
      vi.spyOn(estimator, "fetchHorizonFeeStats").mockRejectedValue(new Error("Horizon 500 error"));

      const rec = await estimator.refreshFeeStats();
      expect(rec.baseFee).toBe(100);
      expect(rec.standardStroops).toBe(100);
      expect(rec.lowStroops).toBe(100);
      expect(rec.priorityStroops).toBe(200);
      expect(rec.currentCongestionLevel).toBe("low");
    });
  });

  describe("lifecycle start and stop", () => {
    it("should start and stop timer properly", () => {
      estimator.start();
      estimator.stop();
    });
  });
});
