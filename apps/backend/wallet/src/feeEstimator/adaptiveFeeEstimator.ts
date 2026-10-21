/**
 * Adaptive Fee Estimator with Dynamic TTL Caching
 *
 * Adjusts Redis cache TTL dynamically based on Stellar network congestion.
 * When fee variance between p50 and p99 is high (network surging), TTL
 * shortens to 5s to prevent stale fees. When calm, TTL extends to 60s
 * to reduce Horizon RPC calls.
 *
 * Closes #287
 */

import { Redis } from "ioredis";
import { createLogger, type Logger } from "@delegolabs/utils";
import { estimateTransactionFee, type FeeEstimate } from "@delegolabs/payments/fee-estimator";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AdaptiveFeeConfig {
  /** Minimum cache TTL in seconds (used during congestion) */
  minTtlSeconds: number;
  /** Maximum cache TTL in seconds (used during calm periods) */
  maxTtlSeconds: number;
  /** Congestion threshold: if p95 fee exceeds this (in stroops), network is "surging" */
  congestionThresholdPercentile: number;
  /** Fee variance ratio threshold: if (p99-p50)/p50 > this, consider congested */
  feeVarianceThreshold: number;
}

export interface CachedFeeEstimate {
  feeStroops: string;
  estimate: FeeEstimate;
  cachedAt: string;
  ttlSeconds: number;
  congestionLevel: "calm" | "moderate" | "surging";
}

export interface AdaptiveFeeResult extends CachedFeeEstimate {
  fromCache: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_ADAPTIVE_CONFIG: AdaptiveFeeConfig = {
  minTtlSeconds: 5,
  maxTtlSeconds: 60,
  congestionThresholdPercentile: 500,
  feeVarianceThreshold: 2.0,
};

const CACHE_KEY = "fee:adaptive:estimate";
const METRICS_KEY = "fee:adaptive:metrics";

// ---------------------------------------------------------------------------
// Adaptive Fee Estimator
// ---------------------------------------------------------------------------

export class AdaptiveFeeEstimator {
  private config: AdaptiveFeeConfig;
  private redis: Redis;
  private log: Logger;

  constructor(
    redis: Redis,
    config: Partial<AdaptiveFeeConfig> = {},
    logger?: Logger,
  ) {
    this.redis = redis;
    this.config = { ...DEFAULT_ADAPTIVE_CONFIG, ...config };
    this.log = logger ?? createLogger("wallet:adaptiveFeeEstimator", process.env.LOG_LEVEL ?? "info");
  }

  /**
   * Get a fee estimate with adaptive caching.
   * Cache TTL adjusts dynamically based on network congestion.
   */
  async getFee(horizonUrl: string): Promise<AdaptiveFeeResult> {
    // Try cache first
    const cached = await this.getCachedEstimate();
    if (cached) {
      this.log.debug("Fee estimate served from cache", {
        feeStroops: cached.feeStroops,
        congestionLevel: cached.congestionLevel,
        ttlSeconds: cached.ttlSeconds,
      });
      return { ...cached, fromCache: true };
    }

    // Cache miss — fetch fresh estimate from Horizon
    const estimate = await estimateTransactionFee(horizonUrl, "p95");
    const congestion = this.assessCongestion(estimate);
    const ttl = this.computeAdaptiveTtl(congestion);
    const feeStroops = String(estimate.recommendedFeeStroops);

    const result: CachedFeeEstimate = {
      feeStroops,
      estimate,
      cachedAt: new Date().toISOString(),
      ttlSeconds: ttl,
      congestionLevel: congestion,
    };

    // Store in Redis with computed TTL
    await this.redis.setex(
      CACHE_KEY,
      ttl,
      JSON.stringify(result),
    );

    // Track congestion level for metrics
    await this.redis.hset(METRICS_KEY, {
      lastCongestionLevel: congestion,
      lastFeeStroops: feeStroops,
      lastTtlSeconds: String(ttl),
      lastUpdated: new Date().toISOString(),
    });

    const estAny = estimate as any;
    this.log.info("Fee estimate fetched and cached", {
      feeStroops,
      congestionLevel: congestion,
      ttlSeconds: ttl,
      p50: estAny.p50,
      p95: estAny.p95,
      p99: estAny.p99,
    });

    return { ...result, fromCache: false };
  }

  /**
   * Assess network congestion based on fee estimate percentiles.
   */
  assessCongestion(estimate: FeeEstimate): "calm" | "moderate" | "surging" {
    const est = estimate as any;
    const p50 = Number(est.p50 ?? 100);
    const p95 = Number(est.p95 ?? 100);
    const p99 = Number(est.p99 ?? 100);

    // Check absolute fee level (p95 > threshold = surging)
    if (p95 > this.config.congestionThresholdPercentile) {
      return "surging";
    }

    // Check fee variance: (p99 - p50) / p50
    const variance = p50 > 0 ? (p99 - p50) / p50 : 0;
    if (variance > this.config.feeVarianceThreshold) {
      return "surging";
    }

    // Moderate: p95 is above 1.5x p50 but not surging
    if (p50 > 0 && p95 / p50 > 1.5) {
      return "moderate";
    }

    return "calm";
  }

  /**
   * Compute adaptive TTL based on congestion level.
   * Surging → minTtl, Calm → maxTtl, Moderate → interpolated.
   */
  computeAdaptiveTtl(congestion: "calm" | "moderate" | "surging"): number {
    switch (congestion) {
      case "surging":
        return this.config.minTtlSeconds;
      case "calm":
        return this.config.maxTtlSeconds;
      case "moderate": {
        // Interpolate between min and max
        const range = this.config.maxTtlSeconds - this.config.minTtlSeconds;
        return this.config.minTtlSeconds + Math.round(range * 0.4);
      }
      default:
        return this.config.maxTtlSeconds;
    }
  }

  /**
   * Get cached estimate from Redis if still valid.
   */
  private async getCachedEstimate(): Promise<CachedFeeEstimate | null> {
    const raw = await this.redis.get(CACHE_KEY);
    if (!raw) return null;

    try {
      const cached = JSON.parse(raw) as CachedFeeEstimate;
      // Check if the cache entry is still within its TTL window
      const ageSeconds = (Date.now() - new Date(cached.cachedAt).getTime()) / 1000;
      if (ageSeconds > cached.ttlSeconds) {
        return null;
      }
      return cached;
    } catch {
      this.log.warn("Failed to parse cached fee estimate, clearing");
      await this.redis.del(CACHE_KEY);
      return null;
    }
  }

  /**
   * Force invalidate the cache (e.g., before a critical transaction).
   */
  async invalidateCache(): Promise<void> {
    await this.redis.del(CACHE_KEY);
    this.log.info("Fee estimate cache invalidated");
  }

  /**
   * Get current congestion metrics.
   */
  async getMetrics(): Promise<Record<string, string>> {
    return await this.redis.hgetall(METRICS_KEY);
  }

  /**
   * Inspect the fee delta between p50 and p99 for diagnostics.
   */
  async inspectFeeDelta(horizonUrl: string): Promise<{
    p50: number;
    p95: number;
    p99: number;
    delta: number;
    deltaRatio: number;
    congestion: "calm" | "moderate" | "surging";
  }> {
    const estimate = await estimateTransactionFee(horizonUrl, "p99");
    const est = estimate as any;
    const p50 = Number(est.p50 ?? 100);
    const p95 = Number(est.p95 ?? 100);
    const p99 = Number(est.p99 ?? 100);
    const delta = p99 - p50;
    const deltaRatio = p50 > 0 ? delta / p50 : 0;

    return {
      p50,
      p95,
      p99,
      delta,
      deltaRatio,
      congestion: this.assessCongestion(estimate),
    };
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createAdaptiveFeeEstimator(
  redis: Redis,
  config?: Partial<AdaptiveFeeConfig>,
  logger?: Logger,
): AdaptiveFeeEstimator {
  return new AdaptiveFeeEstimator(redis, config, logger);
}
