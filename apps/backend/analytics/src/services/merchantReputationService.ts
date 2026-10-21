/**
 * #392 — Merchant Reputation Weight Calculator.
 *
 * Computes a normalized merchant quality score from order history
 * (dispute frequency, fulfillment/on-time rate, cancellation rate),
 * caching the result in Redis so repeated lookups (e.g. shown on every
 * storefront page load) don't re-aggregate `orders`/`disputes` each time.
 */

import type { Sequelize } from "sequelize";
import { QueryTypes } from "sequelize";
import { createLogger } from "@delegolabs/utils";
import { TaggedCache, type TaggedCacheRedisClient } from "@delegolabs/utils/cache/taggedCache.js";
import { sequelize as defaultSequelize } from "../db.js";
import { getRedisClient } from "../redisClient.js";
import {
  calculateMerchantQualityMetrics,
  MIN_SAMPLE_SIZE_FOR_CONFIDENCE,
  type MerchantOrderCounts,
} from "./merchantScoring.js";
import type { MerchantQualityMetricsQuery, MerchantQualityMetricsResponse } from "../schemas.js";

const log = createLogger("analytics:merchant-reputation", process.env.LOG_LEVEL ?? "info");

/** Order statuses that count as a completed, non-cancelled fulfillment. */
const FULFILLED_STATUSES = ["fulfilled", "settled", "completed"];
/** Order statuses that count as cancelled before fulfillment. */
const CANCELLED_STATUSES = ["canceled", "cancelled"];

const CACHE_TTL_SECONDS = Number(process.env.MERCHANT_QUALITY_CACHE_TTL_SECONDS ?? 15 * 60); // 15 min
const CACHE_NAMESPACE = "merchant-quality";

function cacheKey(merchantId: string, periodStart?: string, periodEnd?: string): string {
  return `merchant-quality:${merchantId}:${periodStart ?? "-"}:${periodEnd ?? "-"}`;
}

interface CountsRow {
  total_orders: string;
  fulfilled_orders: string;
  cancelled_orders: string;
  disputed_orders: string;
}

export class MerchantReputationService {
  private readonly sequelize: Sequelize;
  private readonly cache: TaggedCache;

  constructor(sequelize: Sequelize = defaultSequelize, redisClient?: TaggedCacheRedisClient) {
    this.sequelize = sequelize;
    this.cache = new TaggedCache(redisClient ?? (getRedisClient() as unknown as TaggedCacheRedisClient));
  }

  /**
   * Aggregates raw order/dispute counts for a merchant directly from
   * Postgres. Exposed separately from the cached entry point so tests
   * can exercise the SQL and the scoring model independently.
   */
  async getOrderCounts(query: MerchantQualityMetricsQuery): Promise<MerchantOrderCounts> {
    const { merchantId, periodStart, periodEnd } = query;

    const rows = await this.sequelize.query<CountsRow>(
      `
      SELECT
        COUNT(*) FILTER (WHERE o.deleted_at IS NULL) AS total_orders,
        COUNT(*) FILTER (WHERE o.deleted_at IS NULL AND o.status = ANY(:fulfilledStatuses)) AS fulfilled_orders,
        COUNT(*) FILTER (WHERE o.deleted_at IS NULL AND o.status = ANY(:cancelledStatuses)) AS cancelled_orders,
        COUNT(DISTINCT d.order_id) FILTER (WHERE o.deleted_at IS NULL) AS disputed_orders
      FROM orders o
      LEFT JOIN disputes d ON d.order_id = o.id
      WHERE o.merchant_id = :merchantId
        AND (:periodStart::timestamptz IS NULL OR o.created_at >= :periodStart::timestamptz)
        AND (:periodEnd::timestamptz IS NULL OR o.created_at <= :periodEnd::timestamptz)
      `,
      {
        type: QueryTypes.SELECT,
        replacements: {
          merchantId,
          fulfilledStatuses: FULFILLED_STATUSES,
          cancelledStatuses: CANCELLED_STATUSES,
          periodStart: periodStart ?? null,
          periodEnd: periodEnd ?? null,
        },
      }
    );

    const row = rows[0];
    return {
      totalOrders: Number(row?.total_orders ?? 0),
      fulfilledOrders: Number(row?.fulfilled_orders ?? 0),
      cancelledOrders: Number(row?.cancelled_orders ?? 0),
      disputedOrders: Number(row?.disputed_orders ?? 0),
    };
  }

  /**
   * Full pipeline: cache lookup -> DB aggregation on miss -> score -> cache write.
   */
  async getMerchantQualityMetrics(query: MerchantQualityMetricsQuery): Promise<MerchantQualityMetricsResponse> {
    const { merchantId, periodStart, periodEnd } = query;
    const key = cacheKey(merchantId, periodStart, periodEnd);

    const cached = await this.cache.get<Omit<MerchantQualityMetricsResponse, "cached">>(key);
    if (cached) {
      return { ...cached, cached: true };
    }

    const counts = await this.getOrderCounts(query);
    const metrics = calculateMerchantQualityMetrics(counts);

    const response: MerchantQualityMetricsResponse = {
      merchantId,
      ...metrics,
      sampleSize: counts.totalOrders,
      lowConfidence: counts.totalOrders < MIN_SAMPLE_SIZE_FOR_CONFIDENCE,
      cached: false,
      computedAt: new Date().toISOString(),
    };

    try {
      await this.cache.set(key, response, {
        ttlSeconds: CACHE_TTL_SECONDS,
        tags: [`merchant:${merchantId}`],
        namespace: CACHE_NAMESPACE,
      });
    } catch (err) {
      // Caching is best-effort — a Redis hiccup should never fail the request.
      log.warn("Failed to cache merchant quality metrics", {
        merchantId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return response;
  }

  /** Called after a new dispute/cancellation/fulfillment so stale scores don't linger for the full TTL. */
  async invalidateMerchant(merchantId: string): Promise<void> {
    await this.cache.invalidateByTag(`merchant:${merchantId}`);
  }
}

export const merchantReputationService = new MerchantReputationService();
