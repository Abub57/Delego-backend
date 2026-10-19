/**
 * Anti-Sybil Score Calculator — Unit Tests
 *
 * Covers:
 *  - trustWeight < 0.2 for accounts younger than 7 days
 *  - trustWeight < 0.2 for transactions below 1 USDC
 *  - trustWeight = 1.0 for clean accounts
 *  - Weighted average rating computation
 *  - Reciprocal wash-trade flagging
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  evaluateSybilRisk,
  computeWeightedAverageRating,
  resetReciprocalStore,
  type StellarAccountInfo,
} from "./sybilScorer.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isoHoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

function isoNDaysAgo(days: number): string {
  return isoHoursAgo(days * 24);
}

/** Build a StellarAccountInfo with the given age and volume. */
function makeAccountInfo(ageDays: number, stroops: string): StellarAccountInfo {
  return {
    createdAt: isoNDaysAgo(ageDays),
    totalTransactionStroops: stroops,
  };
}

// 1 USDC = 10 XLM = 100_000_000 stroops (at the 0.1 USDC/XLM rate in sybilScorer)
const ONE_USDC_IN_STROOPS = "100000000"; // 100_000_000
const HALF_USDC_IN_STROOPS = "50000000"; // 50_000_000

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("evaluateSybilRisk", () => {
  beforeEach(() => {
    resetReciprocalStore();
  });

  it("flags accounts younger than 7 days with trustWeight < 0.2", async () => {
    const info = makeAccountInfo(3, ONE_USDC_IN_STROOPS); // 3 days old — below threshold
    const result = await evaluateSybilRisk("GBUYER", "GMERCHANT", ONE_USDC_IN_STROOPS, info);

    expect(result.isSuspicious).toBe(true);
    expect(result.trustWeight).toBeLessThan(0.2);
    expect(result.reasons.some((r) => r.includes("days old"))).toBe(true);
  });

  it("flags transactions below 1 USDC with trustWeight < 0.2", async () => {
    const info = makeAccountInfo(30, HALF_USDC_IN_STROOPS); // 30 days old but tiny volume
    const result = await evaluateSybilRisk("GBUYER", "GMERCHANT", HALF_USDC_IN_STROOPS, info);

    expect(result.isSuspicious).toBe(true);
    expect(result.trustWeight).toBeLessThan(0.2);
    expect(result.reasons.some((r) => r.includes("below the minimum"))).toBe(true);
  });

  it("assigns trustWeight = 1.0 for clean, established accounts", async () => {
    const info = makeAccountInfo(30, ONE_USDC_IN_STROOPS); // 30 days old, ≥ 1 USDC
    const result = await evaluateSybilRisk("GBUYER", "GMERCHANT", ONE_USDC_IN_STROOPS, info);

    expect(result.isSuspicious).toBe(false);
    expect(result.trustWeight).toBe(1.0);
    expect(result.reasons).toHaveLength(0);
  });

  it("flags repeat reciprocal transactions between the same buyer/merchant pair", async () => {
    const info = makeAccountInfo(30, ONE_USDC_IN_STROOPS);

    // First transaction — clean
    const first = await evaluateSybilRisk("GBUYER", "GMERCHANT", ONE_USDC_IN_STROOPS, info);
    expect(first.isSuspicious).toBe(false);

    // Second transaction — same pair → should flag
    const second = await evaluateSybilRisk("GBUYER", "GMERCHANT", ONE_USDC_IN_STROOPS, info);
    expect(second.isSuspicious).toBe(true);
    expect(second.reasons.some((r) => r.includes("reciprocal"))).toBe(true);
  });

  it("does not cross-contaminate different buyer/merchant pairs", async () => {
    const info = makeAccountInfo(30, ONE_USDC_IN_STROOPS);

    await evaluateSybilRisk("GBUYER1", "GMERCHANT1", ONE_USDC_IN_STROOPS, info);

    // Different pair — should not be flagged as reciprocal
    const result = await evaluateSybilRisk("GBUYER2", "GMERCHANT2", ONE_USDC_IN_STROOPS, info);
    expect(result.reasons.some((r) => r.includes("reciprocal"))).toBe(false);
  });

  it("returns correct accountAgeDays and escrowVolumeUsdc in result", async () => {
    const info = makeAccountInfo(10, ONE_USDC_IN_STROOPS);
    const result = await evaluateSybilRisk("GBUYER", "GMERCHANT", ONE_USDC_IN_STROOPS, info);

    // accountAgeDays should be approximately 10 (slight tolerance for execution time)
    expect(result.accountAgeDays).toBeGreaterThan(9.9);
    expect(result.accountAgeDays).toBeLessThan(10.1);
    // escrowVolumeUsdc = 100_000_000 stroops / 10_000_000 * 0.1 = 1.0 USDC
    expect(result.escrowVolumeUsdc).toBeCloseTo(1.0, 5);
  });

  it("flags both age AND volume when both conditions are violated", async () => {
    const info = makeAccountInfo(1, HALF_USDC_IN_STROOPS);
    const result = await evaluateSybilRisk("GBUYER", "GMERCHANT", HALF_USDC_IN_STROOPS, info);

    expect(result.isSuspicious).toBe(true);
    expect(result.trustWeight).toBeLessThan(0.2);
    expect(result.reasons.length).toBeGreaterThanOrEqual(2);
  });
});

describe("computeWeightedAverageRating", () => {
  it("returns null for an empty reviews array", () => {
    expect(computeWeightedAverageRating([])).toBeNull();
  });

  it("returns null when all trust weights are zero", () => {
    const result = computeWeightedAverageRating([
      { rating: 5, trustWeight: 0 },
      { rating: 1, trustWeight: 0 },
    ]);
    expect(result).toBeNull();
  });

  it("returns the simple average when all weights are 1.0", () => {
    const result = computeWeightedAverageRating([
      { rating: 4, trustWeight: 1.0 },
      { rating: 2, trustWeight: 1.0 },
    ]);
    expect(result).toBeCloseTo(3.0, 5);
  });

  it("discounts low-trust reviews towards the weighted mean", () => {
    // Three 5-star reviews from trusted accounts, one 1-star from sybil (weight 0.1)
    const result = computeWeightedAverageRating([
      { rating: 5, trustWeight: 1.0 },
      { rating: 5, trustWeight: 1.0 },
      { rating: 5, trustWeight: 1.0 },
      { rating: 1, trustWeight: 0.1 }, // sybil — barely counts
    ]);
    // Weighted: (5+5+5+0.1) / (1+1+1+0.1) = 15.1 / 3.1 ≈ 4.87
    expect(result).toBeGreaterThan(4.5);
    expect(result).toBeLessThan(5.0);
  });

  it("correctly weighs a single review", () => {
    const result = computeWeightedAverageRating([{ rating: 3, trustWeight: 0.5 }]);
    expect(result).toBeCloseTo(3.0, 5);
  });
});
