/**
 * #392 — Merchant Reputation Weight Calculator.
 *
 * Types for the composite merchant quality score, computed from a
 * merchant's dispute frequency, fulfillment speed, and cancellation rate.
 * Kept in a dedicated file (re-exported from schemas.ts) since the issue
 * spec names this shape explicitly and it has its own request/response
 * siblings that don't belong in the notification-analytics schemas above.
 */

/** Basis points — 1/100th of a percent. 10_000 bps == 100%. */
export type BasisPoints = number;

export interface MerchantQualityMetrics {
  /** Share of orders that resulted in an opened dispute, in bps. */
  disputeRateBps: BasisPoints;
  /** Share of orders fulfilled/completed without cancellation, in bps. */
  onTimeDeliveryRateBps: BasisPoints;
  /** Share of orders cancelled before fulfillment, in bps. */
  cancellationRateBps: BasisPoints;
  /** Normalized composite score, 0–100 (higher is better). */
  compositeScore: number;
}

export interface MerchantQualityMetricsQuery {
  merchantId: string;
  /** Only consider orders created on/after this ISO-8601 timestamp. */
  periodStart?: string;
  /** Only consider orders created on/before this ISO-8601 timestamp. */
  periodEnd?: string;
}

export interface MerchantQualityMetricsResponse extends MerchantQualityMetrics {
  merchantId: string;
  /** Total orders the metrics were computed over. */
  sampleSize: number;
  /** True when sampleSize is below the confidence threshold (see service). */
  lowConfidence: boolean;
  /** Whether this response was served from the Redis cache. */
  cached: boolean;
  computedAt: string;
}
