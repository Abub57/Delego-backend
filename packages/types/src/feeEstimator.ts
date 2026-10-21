import { z } from "zod";

/**
 * Dynamic fee recommendation based on network congestion and transaction urgency.
 * Closes #364
 */
export type CongestionLevel = "low" | "medium" | "high";

export interface DynamicFeeRecommendation {
  lowStroops: number;
  standardStroops: number;
  priorityStroops: number;
  currentCongestionLevel: CongestionLevel;
  baseFee: number;
}

export const DynamicFeeRecommendationSchema = z.object({
  lowStroops: z.number().nonnegative(),
  standardStroops: z.number().nonnegative(),
  priorityStroops: z.number().nonnegative(),
  currentCongestionLevel: z.enum(["low", "medium", "high"]),
  baseFee: z.number().nonnegative(),
});

export type DynamicFeeUrgency = "low" | "standard" | "priority";

export interface HorizonFeeStatsResponse {
  last_ledger: number;
  last_ledger_base_fee: number;
  ledger_capacity_usage: number;
  fee_charged?: {
    max: number;
    min: number;
    mode: number;
    p10: number;
    p20: number;
    p30: number;
    p40: number;
    p50: number;
    p60: number;
    p70: number;
    p80: number;
    p90: number;
    p95: number;
    p99: number;
  };
  max_fee?: {
    max: number;
    min: number;
    mode: number;
    p10: number;
    p20: number;
    p30: number;
    p40: number;
    p50: number;
    p60: number;
    p70: number;
    p80: number;
    p90: number;
    p95: number;
    p99: number;
  };
}

export interface CachedFeeStatsEntry {
  stats: HorizonFeeStatsResponse;
  recommendation: DynamicFeeRecommendation;
  cachedAt: string;
  expiresAt: number;
  horizonUrl: string;
}

export interface DynamicFeeEstimatorConfig {
  /** Maximum fee cap in stroops to protect against unreasonable surges (default: 100,000 stroops = 0.01 XLM) */
  maxFeeCapStroops: number;
  /** Minimum fallback fee in stroops (default: 100 stroops = 0.00001 XLM) */
  minFallbackFeeStroops: number;
  /** Redis cache TTL in seconds (default: 15s) */
  cacheTtlSeconds: number;
  /** Polling interval in ms for background periodic refresh (default: 15000ms) */
  pollingIntervalMs: number;
  /** High congestion capacity usage ratio threshold (e.g. 0.85 = 85%) */
  highCongestionCapacityThreshold: number;
  /** Medium congestion capacity usage ratio threshold (e.g. 0.50 = 50%) */
  mediumCongestionCapacityThreshold: number;
  /** High congestion fee multiplier ratio over base fee */
  highCongestionMultiplier: number;
  /** Medium congestion fee multiplier ratio over base fee */
  mediumCongestionMultiplier: number;
}
