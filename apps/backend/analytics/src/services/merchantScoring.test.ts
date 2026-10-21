import { describe, it, expect } from "vitest";
import {
  smoothedRateBps,
  computeCompositeScore,
  calculateMerchantQualityMetrics,
  DEFAULT_PRIORS,
  MIN_SAMPLE_SIZE_FOR_CONFIDENCE,
  BPS_SCALE,
  type MerchantOrderCounts,
} from "./merchantScoring.js";

describe("smoothedRateBps", () => {
  it("returns exactly 0 when there are zero events and zero prior weight is not used (still shrinks toward prior)", () => {
    const rate = smoothedRateBps(0, 0, 0.02, 5);
    // With totalCount 0, the formula collapses to the prior rate itself.
    expect(rate).toBe(Math.round(0.02 * BPS_SCALE));
  });

  it("shrinks a small sample's raw rate toward the prior instead of reporting the raw rate", () => {
    // 1 dispute out of 2 orders is a raw 50% rate, but with a small sample
    // it should land far below 5000 bps thanks to the prior.
    const rate = smoothedRateBps(1, 2, DEFAULT_PRIORS.disputeRate, DEFAULT_PRIORS.weight);
    expect(rate).toBeLessThan(5000);
    expect(rate).toBeGreaterThan(0);
  });

  it("converges to the raw rate as sample size grows large relative to the prior weight", () => {
    const rate = smoothedRateBps(500, 1000, DEFAULT_PRIORS.disputeRate, DEFAULT_PRIORS.weight);
    // Raw rate is 50% == 5000 bps; with 1000 orders vs a weight-5 prior,
    // the result should be very close to 5000.
    expect(rate).toBeGreaterThan(4950);
    expect(rate).toBeLessThanOrEqual(5000);
  });

  it("never returns a value outside [0, 10000]", () => {
    expect(smoothedRateBps(0, 100, 0, 5)).toBe(0);
    expect(smoothedRateBps(100, 100, 1, 5)).toBe(BPS_SCALE);
  });

  it("throws on negative counts", () => {
    expect(() => smoothedRateBps(-1, 10, 0.02, 5)).toThrow();
    expect(() => smoothedRateBps(1, -10, 0.02, 5)).toThrow();
  });
});

describe("computeCompositeScore", () => {
  it("gives a flawless merchant a perfect 100", () => {
    const score = computeCompositeScore({
      disputeRateBps: 0,
      cancellationRateBps: 0,
      onTimeDeliveryRateBps: BPS_SCALE,
    });
    expect(score).toBe(100);
  });

  it("gives the worst possible merchant a 0", () => {
    const score = computeCompositeScore({
      disputeRateBps: BPS_SCALE,
      cancellationRateBps: BPS_SCALE,
      onTimeDeliveryRateBps: 0,
    });
    expect(score).toBe(0);
  });

  it("is monotonically decreasing as dispute rate rises, all else equal", () => {
    const base = { cancellationRateBps: 500, onTimeDeliveryRateBps: 9000 };
    const low = computeCompositeScore({ ...base, disputeRateBps: 100 });
    const high = computeCompositeScore({ ...base, disputeRateBps: 2000 });
    expect(high).toBeLessThan(low);
  });

  it("is monotonically decreasing as cancellation rate rises, all else equal", () => {
    const base = { disputeRateBps: 200, onTimeDeliveryRateBps: 9000 };
    const low = computeCompositeScore({ ...base, cancellationRateBps: 100 });
    const high = computeCompositeScore({ ...base, cancellationRateBps: 3000 });
    expect(high).toBeLessThan(low);
  });

  it("is monotonically increasing as on-time delivery rate rises, all else equal", () => {
    const base = { disputeRateBps: 200, cancellationRateBps: 200 };
    const low = computeCompositeScore({ ...base, onTimeDeliveryRateBps: 3000 });
    const high = computeCompositeScore({ ...base, onTimeDeliveryRateBps: 9500 });
    expect(high).toBeGreaterThan(low);
  });

  it("weights dispute rate more heavily than cancellation rate", () => {
    const shared = { onTimeDeliveryRateBps: 9000 };
    const highDispute = computeCompositeScore({ ...shared, disputeRateBps: 2000, cancellationRateBps: 0 });
    const highCancellation = computeCompositeScore({ ...shared, disputeRateBps: 0, cancellationRateBps: 2000 });
    expect(highDispute).toBeLessThan(highCancellation);
  });

  it("never returns a value outside [0, 100]", () => {
    const score = computeCompositeScore({
      disputeRateBps: BPS_SCALE,
      cancellationRateBps: BPS_SCALE,
      onTimeDeliveryRateBps: 0,
    });
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
  });
});

describe("calculateMerchantQualityMetrics", () => {
  it("scores a merchant with a clean order history near 100", () => {
    const counts: MerchantOrderCounts = {
      totalOrders: 200,
      fulfilledOrders: 195,
      cancelledOrders: 5,
      disputedOrders: 0,
    };
    const metrics = calculateMerchantQualityMetrics(counts);
    expect(metrics.compositeScore).toBeGreaterThan(90);
    expect(metrics.disputeRateBps).toBeLessThan(200);
  });

  it("scores a merchant with heavy disputes and cancellations low", () => {
    const counts: MerchantOrderCounts = {
      totalOrders: 200,
      fulfilledOrders: 100,
      cancelledOrders: 60,
      disputedOrders: 40,
    };
    const metrics = calculateMerchantQualityMetrics(counts);
    expect(metrics.compositeScore).toBeLessThan(75);
  });

  it("does not let a brand-new merchant with zero orders score as flawless", () => {
    const counts: MerchantOrderCounts = {
      totalOrders: 0,
      fulfilledOrders: 0,
      cancelledOrders: 0,
      disputedOrders: 0,
    };
    const metrics = calculateMerchantQualityMetrics(counts);
    // Should reflect the priors, not a vacuous 100.
    expect(metrics.compositeScore).toBeLessThan(100);
    expect(metrics.compositeScore).toBeGreaterThan(0);
  });

  it("MIN_SAMPLE_SIZE_FOR_CONFIDENCE is a usable threshold for callers", () => {
    expect(MIN_SAMPLE_SIZE_FOR_CONFIDENCE).toBeGreaterThan(0);
  });
});
