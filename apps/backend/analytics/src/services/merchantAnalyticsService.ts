/**
 * Merchant Analytics Service (Issue #377)
 *
 * Queries TimescaleDB continuous aggregate views (or fallbacks) for 1-minute,
 * 1-hour, and 1-day merchant sales volume and order metrics.
 */

import { sequelize } from "../db.js";
import { QueryTypes } from "sequelize";
import { createLogger, sumDecimalStrings, type Logger } from "@delegolabs/utils";
import type {
  MerchantAnalyticsQuery,
  MerchantAnalyticsResponse,
  MerchantSalesAggregate,
  AnalyticsTimeBucket,
} from "@delegolabs/types";

const log = createLogger("analytics:merchantService", process.env.LOG_LEVEL ?? "info");

/** Formats an exact decimal string to 2 fraction digits without floating point. */
function formatFixed2(value: string): string {
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [whole, fraction = ""] = unsigned.split(".");
  const fixed = fraction.padEnd(2, "0").slice(0, 2);
  const result = `${whole}.${fixed}`;
  return negative && !/^0(\.0+)?$/.test(result) ? `-${result}` : result;
}

export class MerchantAnalyticsService {
  private readonly logger: Logger;

  constructor(options?: { logger?: Logger }) {
    this.logger = options?.logger ?? log;
  }

  private getViewName(interval: AnalyticsTimeBucket): string {
    switch (interval) {
      case "1m":
        return "merchant_minute_sales";
      case "1d":
        return "merchant_daily_sales";
      case "1h":
      default:
        return "merchant_hourly_sales";
    }
  }

  /**
   * Fetch aggregated sales data for a merchant from TimescaleDB continuous aggregates.
   */
  async getMerchantSales(query: MerchantAnalyticsQuery): Promise<MerchantAnalyticsResponse> {
    const {
      merchantId,
      bucketInterval = "1h",
      startTime = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      endTime = new Date().toISOString(),
      limit = 100,
    } = query;

    const viewName = this.getViewName(bucketInterval);

    this.logger.info("Querying merchant continuous aggregate", {
      merchantId,
      viewName,
      startTime,
      endTime,
    });

    try {
      const rows = (await sequelize.query(
        `
        SELECT
          bucket,
          merchant_id AS "merchantId",
          volume::text AS volume,
          order_count::int AS "orderCount",
          avg_order_value::text AS "avgOrderValue"
        FROM ${viewName}
        WHERE merchant_id = :merchantId
          AND bucket >= :startTime
          AND bucket <= :endTime
        ORDER BY bucket ASC
        LIMIT :limit
      `,
        {
          replacements: { merchantId, startTime, endTime, limit },
          type: QueryTypes.SELECT,
        }
      )) as Array<{
        bucket: Date | string;
        merchantId: string;
        volume: string;
        orderCount: number;
        avgOrderValue: string;
      }>;

      const aggregates: MerchantSalesAggregate[] = rows.map((r) => ({
        bucket: r.bucket instanceof Date ? r.bucket.toISOString() : String(r.bucket),
        merchantId: r.merchantId,
        volume: r.volume || "0",
        orderCount: Number(r.orderCount || 0),
        avgOrderValue: r.avgOrderValue || "0",
      }));

      const totalOrders = aggregates.reduce((acc, curr) => acc + curr.orderCount, 0);
      // Sum via exact BigInt-backed decimal arithmetic — `Number(volume)`
      // silently loses precision once stroop volumes exceed 2^53 - 1 (#338).
      const totalVolumeExact = sumDecimalStrings(aggregates.map((a) => a.volume || "0"));

      return {
        merchantId,
        interval: bucketInterval,
        startTime,
        endTime,
        aggregates,
        totalVolume: formatFixed2(totalVolumeExact),
        totalOrders,
      };
    } catch (err: any) {
      this.logger.error("Failed to query merchant continuous aggregate", {
        error: err.message,
        merchantId,
      });

      // Fallback in-memory or empty calculation
      return {
        merchantId,
        interval: bucketInterval,
        startTime,
        endTime,
        aggregates: [],
        totalVolume: "0.00",
        totalOrders: 0,
      };
    }
  }
}

export const merchantAnalyticsService = new MerchantAnalyticsService();
