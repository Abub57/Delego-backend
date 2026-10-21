import { Redis } from "ioredis";
import { Horizon } from "@stellar/stellar-sdk";
import { createLogger, type Logger } from "@delegolabs/utils";
import type {
  DynamicFeeRecommendation,
  DynamicFeeEstimatorConfig,
  CongestionLevel,
  DynamicFeeUrgency,
  HorizonFeeStatsResponse,
  CachedFeeStatsEntry,
} from "@delegolabs/types";

export const DEFAULT_DYNAMIC_FEE_CONFIG: DynamicFeeEstimatorConfig = {
  maxFeeCapStroops: 100_000, // 0.01 XLM safety cap
  minFallbackFeeStroops: 100, // 0.00001 XLM min base fee
  cacheTtlSeconds: 15, // Cache percentiles for 15s in Redis
  pollingIntervalMs: 15_000, // Background periodic refresh interval
  highCongestionCapacityThreshold: 0.85, // >=85% capacity usage
  mediumCongestionCapacityThreshold: 0.50, // >=50% capacity usage
  highCongestionMultiplier: 3.0,
  mediumCongestionMultiplier: 1.5,
};

const REDIS_FEE_STATS_KEY_PREFIX = "stellar:fee_stats";
const REDIS_METRICS_KEY = "stellar:fee_stats:metrics";

/**
 * Dynamic Stellar Transaction Fee Estimator Adapting to Congestion
 *
 * Implements #364:
 * - Periodically queries Horizon /fee_stats and caches current fee percentiles in Redis.
 * - Provides dynamic fee recommendations (low, standard, priority) and congestion assessment (low, medium, high).
 * - Implements a strict fee cap to protect against unreasonable surges.
 */
export class DynamicFeeEstimator {
  private redis: Redis;
  private config: DynamicFeeEstimatorConfig;
  private log: Logger;
  private timer: NodeJS.Timeout | null = null;
  private horizonUrl: string;
  private isRunning: boolean = false;

  constructor(
    redis: Redis,
    horizonUrl: string = process.env.STELLAR_HORIZON_URL ?? "https://horizon-testnet.stellar.org",
    config: Partial<DynamicFeeEstimatorConfig> = {},
    logger?: Logger,
  ) {
    this.redis = redis;
    this.horizonUrl = horizonUrl;
    this.config = { ...DEFAULT_DYNAMIC_FEE_CONFIG, ...config };
    this.log = logger ?? createLogger("wallet:dynamicFeeEstimator", process.env.LOG_LEVEL ?? "info");
  }

  /**
   * Start periodic background polling of /fee_stats.
   */
  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.log.info("Starting DynamicFeeEstimator periodic polling", {
      horizonUrl: this.horizonUrl,
      pollingIntervalMs: this.config.pollingIntervalMs,
    });

    // Run first refresh immediately in background
    void this.refreshFeeStats().catch((err) => {
      this.log.warn("Initial fee stats refresh failed", { error: (err as Error).message });
    });

    this.timer = setInterval(() => {
      void this.refreshFeeStats().catch((err) => {
        this.log.warn("Periodic fee stats refresh failed", { error: (err as Error).message });
      });
    }, this.config.pollingIntervalMs);
  }

  /**
   * Stop periodic background polling.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.isRunning = false;
    this.log.info("DynamicFeeEstimator stopped");
  }

  /**
   * Fetch live fee stats from Horizon server.
   */
  async fetchHorizonFeeStats(horizonUrl: string = this.horizonUrl): Promise<HorizonFeeStatsResponse> {
    const server = new Horizon.Server(horizonUrl);
    const stats = (await server.feeStats()) as unknown;

    if (!this.isValidFeeStats(stats)) {
      throw new Error("Invalid or malformed fee_stats response from Horizon");
    }

    return stats;
  }

  /**
   * Validates structure of Horizon fee stats response.
   */
  private isValidFeeStats(stats: unknown): stats is HorizonFeeStatsResponse {
    if (typeof stats !== "object" || stats === null) {
      return false;
    }
    const s = stats as Record<string, unknown>;
    return (
      typeof s.last_ledger === "number" &&
      typeof s.last_ledger_base_fee === "number" &&
      typeof s.ledger_capacity_usage === "number"
    );
  }

  /**
   * Compute dynamic fee recommendations and congestion level from fee stats.
   */
  calculateRecommendation(stats: HorizonFeeStatsResponse): DynamicFeeRecommendation {
    const baseFee = stats.last_ledger_base_fee || this.config.minFallbackFeeStroops;
    const capacityUsage = stats.ledger_capacity_usage ?? 0;

    const maxFeeData = stats.max_fee;
    const feeChargedData = stats.fee_charged;

    // Determine percentile values with fallbacks
    const p10 = maxFeeData?.p10 ?? feeChargedData?.p10 ?? baseFee;
    const p50 = maxFeeData?.p50 ?? feeChargedData?.p50 ?? baseFee;
    const p90 = maxFeeData?.p90 ?? feeChargedData?.p90 ?? Math.max(p50 * 1.5, baseFee);
    const p95 = maxFeeData?.p95 ?? feeChargedData?.p95 ?? Math.max(p90 * 1.2, baseFee);
    const p99 = maxFeeData?.p99 ?? feeChargedData?.p99 ?? Math.max(p95 * 1.5, baseFee);

    // Assess congestion level
    const congestion = this.determineCongestionLevel(capacityUsage, p50, p95, p99, baseFee);

    // Dynamic fee tiers based on congestion and percentiles
    let rawLow = Math.max(p10, p50 * 0.8, baseFee);
    let rawStandard = Math.max(p50, baseFee);
    let rawPriority = Math.max(p95, p99 * 0.9, baseFee * 2);

    if (congestion === "high") {
      rawLow = Math.max(rawLow, p50, baseFee * this.config.mediumCongestionMultiplier);
      rawStandard = Math.max(rawStandard, p90, p95 * 0.9, baseFee * this.config.highCongestionMultiplier);
      rawPriority = Math.max(rawPriority, p99, baseFee * (this.config.highCongestionMultiplier * 1.5));
    } else if (congestion === "medium") {
      rawLow = Math.max(rawLow, baseFee);
      rawStandard = Math.max(rawStandard, p50 * 1.2, baseFee * this.config.mediumCongestionMultiplier);
      rawPriority = Math.max(rawPriority, p95, baseFee * (this.config.mediumCongestionMultiplier * 1.5));
    }

    // Apply strict safety cap & minimum guarantees
    const lowStroops = Math.round(this.clampFee(rawLow));
    const standardStroops = Math.round(this.clampFee(rawStandard));
    const priorityStroops = Math.round(this.clampFee(Math.max(rawPriority, standardStroops)));

    return {
      lowStroops,
      standardStroops,
      priorityStroops,
      currentCongestionLevel: congestion,
      baseFee,
    };
  }

  /**
   * Determine network congestion level based on capacity usage and fee variance.
   */
  determineCongestionLevel(
    capacityUsage: number,
    p50: number,
    p95: number,
    p99: number,
    baseFee: number,
  ): CongestionLevel {
    // 1. High capacity usage
    if (capacityUsage >= this.config.highCongestionCapacityThreshold) {
      return "high";
    }

    // 2. High fee surge (extreme multiplier over base fee or huge p99 surge)
    if (p95 >= baseFee * 8) {
      return "high";
    }
    if (p50 >= baseFee * 3 && (p99 - p50) / p50 >= 3.0 && p99 >= baseFee * 5) {
      return "high";
    }

    // 3. Medium capacity usage
    if (capacityUsage >= this.config.mediumCongestionCapacityThreshold) {
      return "medium";
    }

    // 4. Moderate fee surge (p95 elevated over p50 AND base fee)
    if (p50 > 0 && (p95 - p50) / p50 >= 1.5 && p95 >= baseFee * 3) {
      return "medium";
    }
    if (p95 >= baseFee * 3) {
      return "medium";
    }

    return "low";
  }

  /**
   * Clamp fee between minimum fallback fee and max fee cap.
   */
  clampFee(feeStroops: number): number {
    const min = this.config.minFallbackFeeStroops;
    const max = this.config.maxFeeCapStroops;
    return Math.min(Math.max(feeStroops, min), max);
  }

  /**
   * Refresh fee stats from Horizon and store in Redis.
   */
  async refreshFeeStats(horizonUrl: string = this.horizonUrl): Promise<DynamicFeeRecommendation> {
    try {
      const stats = await this.fetchHorizonFeeStats(horizonUrl);
      const recommendation = this.calculateRecommendation(stats);

      const cacheKey = this.getCacheKey(horizonUrl);
      const entry: CachedFeeStatsEntry = {
        stats,
        recommendation,
        cachedAt: new Date().toISOString(),
        expiresAt: Date.now() + this.config.cacheTtlSeconds * 1000,
        horizonUrl,
      };

      await this.redis.setex(cacheKey, this.config.cacheTtlSeconds, JSON.stringify(entry));

      // Record metrics
      await this.redis.hset(REDIS_METRICS_KEY, {
        lastCongestionLevel: recommendation.currentCongestionLevel,
        lastBaseFee: String(recommendation.baseFee),
        lastLowStroops: String(recommendation.lowStroops),
        lastStandardStroops: String(recommendation.standardStroops),
        lastPriorityStroops: String(recommendation.priorityStroops),
        lastUpdated: new Date().toISOString(),
      });

      this.log.debug("Refreshed and cached fee stats", {
        horizonUrl,
        recommendation,
      });

      return recommendation;
    } catch (err) {
      this.log.warn("Failed to refresh fee stats from Horizon, fallback will be used", {
        error: (err as Error).message,
        horizonUrl,
      });
      return this.getFallbackRecommendation();
    }
  }

  /**
   * Get dynamic fee recommendation, trying Redis cache first before fetching.
   */
  async getFeeRecommendation(horizonUrl: string = this.horizonUrl): Promise<DynamicFeeRecommendation> {
    const cacheKey = this.getCacheKey(horizonUrl);
    try {
      const raw = await this.redis.get(cacheKey);
      if (raw) {
        const entry = JSON.parse(raw) as CachedFeeStatsEntry;
        if (entry?.recommendation && entry.expiresAt > Date.now()) {
          return entry.recommendation;
        }
      }
    } catch (err) {
      this.log.warn("Redis read error while getting fee recommendation", {
        error: (err as Error).message,
      });
    }

    // Cache miss or expired — refresh now
    return await this.refreshFeeStats(horizonUrl);
  }

  /**
   * Get fee for a specific transaction urgency.
   *
   * @param urgency - "low" | "standard" | "priority"
   * @param horizonUrl - Optional Horizon URL
   * @returns Fee in stroops as a string
   */
  async getFeeForUrgency(
    urgency: DynamicFeeUrgency = "standard",
    horizonUrl: string = this.horizonUrl,
  ): Promise<string> {
    const recommendation = await this.getFeeRecommendation(horizonUrl);
    let fee: number;

    switch (urgency) {
      case "low":
        fee = recommendation.lowStroops;
        break;
      case "priority":
        fee = recommendation.priorityStroops;
        break;
      case "standard":
      default:
        fee = recommendation.standardStroops;
        break;
    }

    return String(this.clampFee(fee));
  }

  /**
   * Get fallback recommendation when Horizon is unreachable.
   */
  getFallbackRecommendation(): DynamicFeeRecommendation {
    const base = this.config.minFallbackFeeStroops;
    return {
      lowStroops: base,
      standardStroops: base,
      priorityStroops: Math.min(base * 2, this.config.maxFeeCapStroops),
      currentCongestionLevel: "low",
      baseFee: base,
    };
  }

  /**
   * Invalidate Redis cache for fee stats.
   */
  async invalidateCache(horizonUrl: string = this.horizonUrl): Promise<void> {
    await this.redis.del(this.getCacheKey(horizonUrl));
    this.log.info("Dynamic fee stats cache invalidated", { horizonUrl });
  }

  /**
   * Read metrics from Redis.
   */
  async getMetrics(): Promise<Record<string, string>> {
    return await this.redis.hgetall(REDIS_METRICS_KEY);
  }

  private getCacheKey(horizonUrl: string): string {
    return `${REDIS_FEE_STATS_KEY_PREFIX}:${encodeURIComponent(horizonUrl)}`;
  }
}

let defaultEstimatorInstance: DynamicFeeEstimator | null = null;

export function getDynamicFeeEstimator(
  redis: Redis,
  horizonUrl?: string,
  config?: Partial<DynamicFeeEstimatorConfig>,
): DynamicFeeEstimator {
  if (!defaultEstimatorInstance) {
    defaultEstimatorInstance = new DynamicFeeEstimator(redis, horizonUrl, config);
  }
  return defaultEstimatorInstance;
}
