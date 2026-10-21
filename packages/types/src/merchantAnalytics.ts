/**
 * Merchant Continuous Aggregates Analytics Types (Issue #377)
 */

export type AnalyticsTimeBucket = "1m" | "1h" | "1d";

export interface MerchantSalesAggregate {
  bucket: string; // ISO 8601 timestamp
  merchantId: string;
  volume: string; // aggregated amount/volume
  orderCount: number;
  avgOrderValue?: string;
}

export interface MerchantAnalyticsQuery {
  merchantId: string;
  bucketInterval?: AnalyticsTimeBucket;
  startTime?: string;
  endTime?: string;
  limit?: number;
}

export interface MerchantAnalyticsResponse {
  merchantId: string;
  interval: AnalyticsTimeBucket;
  startTime: string;
  endTime: string;
  aggregates: MerchantSalesAggregate[];
  totalVolume: string;
  totalOrders: number;
}

// ---------------------------------------------------------------------------
// Merchant revenue reports — GET /api/v1/merchant/analytics/revenue
// ---------------------------------------------------------------------------

export type RevenueGroupBy = "day" | "week" | "month";

export interface RevenueAggregateQuery {
  merchantId: string;
  /** ISO 8601 date or datetime; expanded to the start of its period (UTC). */
  startDate: string;
  /** ISO 8601 date or datetime; the period containing it is included. */
  endDate: string;
  groupBy: RevenueGroupBy;
  currency: string;
}

/** All `*Stroops` values are integer strings — never parse with Number(). */
export interface RevenueAggregateBucket {
  /** UTC start of the period (weeks start on Monday). */
  periodStart: string;
  grossVolumeStroops: string;
  netRevenueStroops: string;
  platformFeesStroops: string;
  refundedStroops: string;
  orderCount: number;
  /** Net revenue change vs. the previous period, in percent; null when the previous period had none. */
  netRevenueGrowthPct: number | null;
}

export interface RevenueAggregateTotals {
  grossVolumeStroops: string;
  netRevenueStroops: string;
  platformFeesStroops: string;
  refundedStroops: string;
  orderCount: number;
}

export interface RevenueAggregateResponse {
  merchantId: string;
  currency: string;
  groupBy: RevenueGroupBy;
  /** Inclusive UTC start of the first period. */
  rangeStart: string;
  /** Exclusive UTC end of the last period. */
  rangeEnd: string;
  buckets: RevenueAggregateBucket[];
  totals: RevenueAggregateTotals;
}
