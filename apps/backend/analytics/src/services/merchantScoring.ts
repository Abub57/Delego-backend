/**
 * #392 — Merchant Reputation Weight Calculator: scoring model.
 *
 * Pure, side-effect-free statistics so the scoring logic can be unit
 * tested without a database or Redis. Everything that talks to Postgres
 * or the cache lives in merchantReputationService.ts.
 */

import type { BasisPoints, MerchantQualityMetrics } from "../schemas.js";

export const BPS_SCALE = 10_000;

/** Raw counts pulled from `orders`/`disputes` for one merchant. */
export interface MerchantOrderCounts {
  totalOrders: number;
  disputedOrders: number;
  /** Orders that reached a terminal, non-cancelled, non-disputed state. */
  fulfilledOrders: number;
  cancelledOrders: number;
}

/**
 * Below this many orders, a merchant's raw rates are dominated by noise
 * (e.g. 1 dispute out of 2 orders => 50% dispute rate). Below this
 * threshold the response is flagged `lowConfidence` so callers can
 * decide how much weight to give the score.
 */
export const MIN_SAMPLE_SIZE_FOR_CONFIDENCE = 10;

/**
 * Bayesian smoothing (additive/Laplace-style shrinkage toward a prior)
 * so a merchant with very few orders isn't scored purely on that noise.
 * `priorRate` is the population-average rate a brand-new merchant is
 * assumed to have; `priorWeight` is how many "virtual" orders that
 * prior is worth.
 */
export function smoothedRateBps(
  eventCount: number,
  totalCount: number,
  priorRate: number,
  priorWeight: number
): BasisPoints {
  if (totalCount < 0 || eventCount < 0) {
    throw new Error("counts must be non-negative");
  }
  const smoothed = (eventCount + priorRate * priorWeight) / (totalCount + priorWeight);
  return Math.round(clamp01(smoothed) * BPS_SCALE);
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

function clampScore(n: number): number {
  return Math.min(100, Math.max(0, n));
}

/** Priors: assume a mid-pack new merchant — a small but nonzero dispute
 * and cancellation rate, and a solid (not perfect) on-time rate. */
export const DEFAULT_PRIORS = {
  disputeRate: 0.02,
  onTimeDeliveryRate: 0.9,
  cancellationRate: 0.05,
  /** Weight of the prior, in "virtual orders". */
  weight: 5,
};

/** Composite-score weighting: dispute rate matters most, then
 * cancellations, then fulfillment/on-time rate. Must sum to 1. */
export const SCORE_WEIGHTS = {
  disputeRate: 0.5,
  cancellationRate: 0.3,
  onTimeDeliveryRate: 0.2,
};

/**
 * Turns smoothed component rates into a single 0–100 composite score,
 * where 100 is a flawless merchant. Each component contributes its own
 * "goodness" (100 - badRate, or the good rate directly), pre-weighted so
 * the weights (which sum to 1) map straight onto the 0–100 output range.
 * This keeps the score monotonic in each input: raising a bad rate can
 * only lower the score, raising the on-time rate can only raise it.
 */
export function computeCompositeScore(rates: {
  disputeRateBps: BasisPoints;
  cancellationRateBps: BasisPoints;
  onTimeDeliveryRateBps: BasisPoints;
}): number {
  const disputeGoodnessPct = 100 - rates.disputeRateBps / 100;
  const cancellationGoodnessPct = 100 - rates.cancellationRateBps / 100;
  const onTimeGoodnessPct = rates.onTimeDeliveryRateBps / 100;

  const score =
    disputeGoodnessPct * SCORE_WEIGHTS.disputeRate +
    cancellationGoodnessPct * SCORE_WEIGHTS.cancellationRate +
    onTimeGoodnessPct * SCORE_WEIGHTS.onTimeDeliveryRate;

  return Math.round(clampScore(score) * 100) / 100;
}

/**
 * End-to-end pure computation: raw counts in, full metrics out. No I/O.
 */
export function calculateMerchantQualityMetrics(
  counts: MerchantOrderCounts,
  priors = DEFAULT_PRIORS
): MerchantQualityMetrics {
  const { totalOrders, disputedOrders, fulfilledOrders, cancelledOrders } = counts;

  const disputeRateBps = smoothedRateBps(disputedOrders, totalOrders, priors.disputeRate, priors.weight);
  const cancellationRateBps = smoothedRateBps(cancelledOrders, totalOrders, priors.cancellationRate, priors.weight);
  const onTimeDeliveryRateBps = smoothedRateBps(fulfilledOrders, totalOrders, priors.onTimeDeliveryRate, priors.weight);

  const compositeScore = computeCompositeScore({ disputeRateBps, cancellationRateBps, onTimeDeliveryRateBps });

  return { disputeRateBps, cancellationRateBps, onTimeDeliveryRateBps, compositeScore };
}
