import { createLogger } from "@delegolabs/utils";
import { sequelize } from "../db.js";

const log = createLogger("analytics:merchantDailyGmv");

export interface MerchantDailyGmvRow {
  bucketDay: string;
  merchantId: string;
  currency: string;
  totalOrders: number;
  grossVolumeStroops: string;
  totalPlatformFeesStroops: string;
  disputedOrdersCount: number;
}

export interface MerchantDailyGmvQueryOptions {
  /** Inclusive lower bound (day bucket). */
  from?: Date | string;
  /** Exclusive upper bound (day bucket). */
  to?: Date | string;
  /** Optional currency filter. */
  currency?: string;
  /** Maximum number of day buckets to return (default 30). */
  limit?: number;
}

export interface MerchantDailyGmvTotals {
  totalOrders: number;
  grossVolumeStroops: string;
  totalPlatformFeesStroops: string;
  disputedOrdersCount: number;
}

export interface MerchantDailyGmvResult {
  merchantId: string;
  currency: string | null;
  days: MerchantDailyGmvRow[];
  totals: MerchantDailyGmvTotals;
  queryTimeMs: number;
}

/**
 * Queries the `merchant_daily_gmu_summary` TimescaleDB continuous
 * aggregate for a single merchant. The continuous aggregate is
 * materialized by the hourly refresh policy, so this query hits a small
 * pre-aggregated hypertable instead of scanning `orders`.
 */
export class MerchantDailyGmvService {
  constructor(private readonly db = sequelize) {}

  async getMerchantDailyGmvImpl(
    merchantId: string,
    options: MerchantDailyGmvQueryOptions = {},
  ): Promise<MerchantDailyGmvResult> {
    if (!merchantId) throw new Error("merchantId is required");

    const limit = Math.min(Math.max(options.limit ?? 30, 1), 365);
    const currency = options.currency ?? null;
    const from = options.from ? new Date(options.from) : null;
    const to = options.to ? new Date(options.to) : null;

    const sql = `
      SELECT
        bucket_day,
        merchant_id,
        currency,
        total_orders,
        gross_volume_stroops,
        total_platform_fees_stroops,
        disputed_orders_count
      FROM merchant_daily_gmu_summary
      WHERE merchant_id = :merchantId
        AND (:currency::text IS NULL OR currency = :currency)
        AND (:from::timestamptz IS NULL OR bucket_day >= :from::timestamptz)
        AND (:to::timestamptz IS NULL OR bucket_day < :to::timestamptz)
      ORDER BY bucket_day DESC
      LIMIT :limit
    `;

    const startedAt = performance.now();
    const [rows] = (await this.db.query(sql, {
      replacements: {
        merchantId,
        currency,
        from,
        to,
        limit,
      },
      type: "SELECT",
    })) as [Array<Record<string, unknown>>, unknown];
    const queryTimeMs = performance.now() - started;

    const days: MerchantDailyGmvRow = rows.map((r) => ({
      bucketDay: new Date(r.bucket_day as string).toISOString(),
      merchantId: String(r.merchant_id),
      currency: String(r.currency),
      totalOrders: Number(r.total_orders),
      grossVolumeStroops: String(r.gross_volume_stroops),
      totalPlatformFeesStroops: String(r.total_platform_fees_stroops),
      disputedOrdersCount: Number(r.disputed_orders_count),
    }));

    const totals = days.reduce<MerchantDailyGmvTotals>(
      (acc, row) => ({
        totalOrders: acc.totalOrders + row.totalOrders,
        grossVolumeStroops: (
          BigInt(acc.grossVolumeStroops) + BigInt(row.grossVolumeStroops)
        ).toString(),
        totalPlatformFeesStroops: (
          BigInt(acc.totalPlatformFeesStroops) + BigInt(row.totalPlatformFeesStroops)
        ).toString(),
        disputedOrdersCount: acc.disputedOrdersCount + row.disputedOrdersCount,
      }),
      {
        totalOrders: 0,
        grossVolumeStroops: "0",
        totalPlatformFeesStroops: "0",
        disputedOrdersCount: 0,
      },
    );

    log.debug("merchant daily gmv query", {
      merchantId,
      currency,
      rows: days.length,
      queryTimeMs,
    });

    return { merchantId, currency, days, totals, queryTimeMs };
  }
}

export const merchantDailyGmvService = new MerchantDailyGmvService();

export async function getMerchantDailyGmvHandler(ctx: any): Promise<unknown> {
  const merchantId = ctx.params.merchantId as string | undefined;
  if (!merchantId) {
    return { status: 400, body: { error: "merchantId is required" } };
  }

  const query = (ctx.query ?? {}) as Record<string, string | undefined>;
  const limitRaw = query.limit ? Number(query.limit) : undefined;

  try {
    const result = await merchantDailyGmvService.getMerchantDailyGmvImpl(merchantId, {
      from: query.from,
      to: query.to,
      currency: query.currency,
      limit: Number.isFinite(limitRaw) ? (limitRaw as number) : undefined,
    });
    return { status: 200, body: result };
  } catch (err) {
    log.error("failed to query merchant daily gmv", {
      merchantId,
      error: (err as Error).message,
    });
    return { status: 500, body: { error: "internal error" } };
  }
}
