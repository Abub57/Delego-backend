/**
 * Merchant revenue reports — settled escrow volume, platform fees and
 * refunds grouped by day / week / month, with period-over-period growth.
 *
 * Data model (migration 047): a payment_records row contributes to the
 * period containing its `settled_at`, in its own `currency` only.
 *
 *   gross    = SUM(amount_stroops)
 *   fees     = SUM(platform_fee_stroops) for escrows that were not fully refunded
 *   refunded = SUM(refunded_amount_stroops)
 *   net      = gross - fees - refunded
 *
 * Caching: a bucket whose period has fully elapsed is cached in Redis for one
 * hour under its own key, so overlapping or sliding report ranges share
 * entries. The open (current) period is always read live. On a partial hit,
 * one query fetches everything from the first missing bucket onward.
 *
 * All stroop amounts stay as integer strings / BigInt end-to-end; they never
 * pass through `Number`, which loses precision above 2^53.
 */

import { QueryTypes, type Sequelize } from "sequelize";
import { createLogger, type Logger } from "@delegolabs/utils";
import type {
  RevenueAggregateBucket,
  RevenueAggregateQuery,
  RevenueAggregateResponse,
  RevenueAggregateTotals,
  RevenueGroupBy,
} from "@delegolabs/types";

const log = createLogger("analytics:merchant-revenue", process.env.LOG_LEVEL ?? "info");

export const REVENUE_CACHE_TTL_SECONDS = 60 * 60;
const CACHE_KEY_VERSION = "v1";

/** Hard cap on buckets per request, per granularity. */
export const MAX_BUCKETS: Record<RevenueGroupBy, number> = { day: 366, week: 260, month: 120 };

// ---------------------------------------------------------------------------
// UTC period arithmetic — must agree with Postgres date_trunc in UTC
// ---------------------------------------------------------------------------

export function truncateToPeriod(date: Date, groupBy: RevenueGroupBy): Date {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth();
  const d = date.getUTCDate();
  switch (groupBy) {
    case "day":
      return new Date(Date.UTC(y, m, d));
    case "week": {
      // ISO weeks start on Monday, like date_trunc('week', …).
      const daysSinceMonday = (date.getUTCDay() + 6) % 7;
      return new Date(Date.UTC(y, m, d - daysSinceMonday));
    }
    case "month":
      return new Date(Date.UTC(y, m, 1));
  }
}

export function addPeriods(periodStart: Date, groupBy: RevenueGroupBy, count: number): Date {
  const y = periodStart.getUTCFullYear();
  const m = periodStart.getUTCMonth();
  const d = periodStart.getUTCDate();
  switch (groupBy) {
    case "day":
      return new Date(Date.UTC(y, m, d + count));
    case "week":
      return new Date(Date.UTC(y, m, d + 7 * count));
    case "month":
      return new Date(Date.UTC(y, m + count, 1));
  }
}

/** Period starts covering [startDate, endDate], both ends expanded to whole periods. */
export function enumeratePeriods(startDate: Date, endDate: Date, groupBy: RevenueGroupBy): Date[] {
  const last = truncateToPeriod(endDate, groupBy).getTime();
  const periods: Date[] = [];
  for (let p = truncateToPeriod(startDate, groupBy); p.getTime() <= last; p = addPeriods(p, groupBy, 1)) {
    periods.push(p);
  }
  return periods;
}

const PG_INTERVAL: Record<RevenueGroupBy, string> = { day: "1 day", week: "1 week", month: "1 month" };

/** `timestamp without time zone` literal in UTC (avoids session-TimeZone surprises). */
function toPgTimestamp(date: Date): string {
  return date.toISOString().replace("T", " ").replace("Z", "");
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

/**
 * One pass over settled payment records, gap-filled with generate_series so
 * LAG compares truly adjacent periods (an empty week is a zero, not skipped).
 * The series starts one period before `firstPeriod` so the first returned
 * bucket's growth is computed against real data.
 */
export const REVENUE_BUCKETS_SQL = `
WITH periods AS (
  SELECT gs AS period_start
  FROM generate_series(:seriesStart::timestamp, :lastPeriod::timestamp, :step::interval) AS gs
),
settled AS (
  SELECT
    date_trunc(:unit, pr.settled_at AT TIME ZONE 'UTC')                    AS period_start,
    SUM(pr.amount_stroops)                                                 AS gross,
    COALESCE(SUM(pr.platform_fee_stroops) FILTER (WHERE pr.status <> 'refunded'), 0) AS fees,
    SUM(pr.refunded_amount_stroops)                                        AS refunded,
    COUNT(*)                                                               AS order_count
  FROM payment_records pr
  JOIN orders o ON o.id = pr.order_id
  WHERE o.merchant_id = :merchantId
    AND pr.currency = :currency
    AND pr.settled_at >= (:seriesStart::timestamp AT TIME ZONE 'UTC')
    AND pr.settled_at <  (:rangeEnd::timestamp AT TIME ZONE 'UTC')
  GROUP BY 1
),
filled AS (
  SELECT
    p.period_start,
    COALESCE(s.gross, 0)                                                   AS gross,
    COALESCE(s.fees, 0)                                                    AS fees,
    COALESCE(s.refunded, 0)                                                AS refunded,
    COALESCE(s.gross, 0) - COALESCE(s.fees, 0) - COALESCE(s.refunded, 0)   AS net,
    COALESCE(s.order_count, 0)                                             AS order_count
  FROM periods p
  LEFT JOIN settled s ON s.period_start = p.period_start
),
with_growth AS (
  SELECT f.*, LAG(f.net) OVER (ORDER BY f.period_start) AS prev_net
  FROM filled f
)
SELECT
  to_char(period_start, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "periodStart",
  gross::text                                            AS "grossVolumeStroops",
  net::text                                              AS "netRevenueStroops",
  fees::text                                             AS "platformFeesStroops",
  refunded::text                                         AS "refundedStroops",
  order_count::int                                       AS "orderCount",
  CASE
    WHEN prev_net IS NULL OR prev_net = 0 THEN NULL
    ELSE ROUND((net - prev_net) * 100.0 / ABS(prev_net), 2)::float8
  END                                                    AS "netRevenueGrowthPct"
FROM with_growth
WHERE period_start >= :firstPeriod::timestamp
ORDER BY period_start
`;

// ---------------------------------------------------------------------------
// Dependencies (narrow, so tests can supply fakes)
// ---------------------------------------------------------------------------

export type RevenueQueryExecutor = (
  sql: string,
  replacements: Record<string, unknown>
) => Promise<RevenueAggregateBucket[]>;

/** The subset of ioredis this service needs. */
export interface RevenueCacheClient {
  mget(...keys: string[]): Promise<Array<string | null>>;
  multi(): {
    set(key: string, value: string, mode: "EX", seconds: number): unknown;
    exec(): Promise<unknown>;
  };
}

export function sequelizeRevenueExecutor(sequelize: Sequelize): RevenueQueryExecutor {
  return (sql, replacements) =>
    sequelize.query<RevenueAggregateBucket>(sql, { type: QueryTypes.SELECT, replacements });
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

const STROOPS_PATTERN = /^-?\d+$/;

function toStroops(value: unknown, field: string): bigint {
  const text = String(value ?? "0");
  if (!STROOPS_PATTERN.test(text)) {
    throw new Error(`Revenue aggregate returned a non-integer ${field}: ${text}`);
  }
  return BigInt(text);
}

/** Validates DB/cache output into the public bucket shape (exact integers only). */
function normalizeBucket(row: RevenueAggregateBucket): RevenueAggregateBucket {
  return {
    periodStart: new Date(row.periodStart).toISOString(),
    grossVolumeStroops: toStroops(row.grossVolumeStroops, "grossVolumeStroops").toString(),
    netRevenueStroops: toStroops(row.netRevenueStroops, "netRevenueStroops").toString(),
    platformFeesStroops: toStroops(row.platformFeesStroops, "platformFeesStroops").toString(),
    refundedStroops: toStroops(row.refundedStroops, "refundedStroops").toString(),
    orderCount: Number(row.orderCount ?? 0),
    netRevenueGrowthPct:
      row.netRevenueGrowthPct === null || row.netRevenueGrowthPct === undefined
        ? null
        : Number(row.netRevenueGrowthPct),
  };
}

export function sumRevenueBuckets(buckets: RevenueAggregateBucket[]): RevenueAggregateTotals {
  let gross = 0n;
  let net = 0n;
  let fees = 0n;
  let refunded = 0n;
  let orderCount = 0;
  for (const b of buckets) {
    gross += toStroops(b.grossVolumeStroops, "grossVolumeStroops");
    net += toStroops(b.netRevenueStroops, "netRevenueStroops");
    fees += toStroops(b.platformFeesStroops, "platformFeesStroops");
    refunded += toStroops(b.refundedStroops, "refundedStroops");
    orderCount += b.orderCount;
  }
  return {
    grossVolumeStroops: gross.toString(),
    netRevenueStroops: net.toString(),
    platformFeesStroops: fees.toString(),
    refundedStroops: refunded.toString(),
    orderCount,
  };
}

export function revenueCacheKey(query: RevenueAggregateQuery, periodStart: Date): string {
  return [
    "merchant-revenue",
    CACHE_KEY_VERSION,
    query.merchantId,
    query.currency,
    query.groupBy,
    periodStart.toISOString(),
  ].join(":");
}

export interface MerchantRevenueServiceDeps {
  execute: RevenueQueryExecutor;
  cache?: RevenueCacheClient;
  now?: () => Date;
  logger?: Logger;
}

export class MerchantRevenueService {
  private readonly execute: RevenueQueryExecutor;
  private readonly cache?: RevenueCacheClient;
  private readonly now: () => Date;
  private readonly log: Logger;

  constructor(deps: MerchantRevenueServiceDeps) {
    this.execute = deps.execute;
    this.cache = deps.cache;
    this.now = deps.now ?? (() => new Date());
    this.log = deps.logger ?? log;
  }

  async getRevenueAggregates(query: RevenueAggregateQuery): Promise<RevenueAggregateResponse> {
    const { groupBy } = query;
    const periods = enumeratePeriods(new Date(query.startDate), new Date(query.endDate), groupBy);
    if (periods.length === 0) throw new Error("startDate must not be after endDate");
    if (periods.length > MAX_BUCKETS[groupBy]) {
      throw new Error(`Range spans ${periods.length} ${groupBy} buckets; maximum is ${MAX_BUCKETS[groupBy]}`);
    }

    const now = this.now().getTime();
    // A period is cacheable once it has fully elapsed.
    const closedCount = periods.filter((p) => addPeriods(p, groupBy, 1).getTime() <= now).length;
    const cached = await this.readCache(query, periods.slice(0, closedCount));

    const firstMiss = cached.findIndex((b) => b === null);
    const fetchFrom = firstMiss === -1 ? closedCount : firstMiss;

    let fetched: RevenueAggregateBucket[] = [];
    if (fetchFrom < periods.length) {
      fetched = await this.queryBuckets(query, periods[fetchFrom], periods[periods.length - 1]);
      const expected = periods.slice(fetchFrom).map((p) => p.toISOString());
      if (fetched.length !== expected.length || fetched.some((b, i) => b.periodStart !== expected[i])) {
        // Never cache buckets under keys they don't belong to.
        throw new Error("Revenue buckets returned by the database do not align with the requested periods");
      }
      await this.writeCache(query, fetched.slice(0, closedCount - fetchFrom));
    }

    const buckets = [...(cached.slice(0, fetchFrom) as RevenueAggregateBucket[]), ...fetched];
    return {
      merchantId: query.merchantId,
      currency: query.currency,
      groupBy,
      rangeStart: periods[0].toISOString(),
      rangeEnd: addPeriods(periods[periods.length - 1], groupBy, 1).toISOString(),
      buckets,
      totals: sumRevenueBuckets(buckets),
    };
  }

  private async queryBuckets(
    query: RevenueAggregateQuery,
    firstPeriod: Date,
    lastPeriod: Date
  ): Promise<RevenueAggregateBucket[]> {
    const rows = await this.execute(REVENUE_BUCKETS_SQL, {
      merchantId: query.merchantId,
      currency: query.currency,
      unit: query.groupBy,
      step: PG_INTERVAL[query.groupBy],
      seriesStart: toPgTimestamp(addPeriods(firstPeriod, query.groupBy, -1)),
      firstPeriod: toPgTimestamp(firstPeriod),
      lastPeriod: toPgTimestamp(lastPeriod),
      rangeEnd: toPgTimestamp(addPeriods(lastPeriod, query.groupBy, 1)),
    });
    return rows.map(normalizeBucket);
  }

  /** Cache read that degrades to "all misses" when Redis is unavailable. */
  private async readCache(
    query: RevenueAggregateQuery,
    periods: Date[]
  ): Promise<Array<RevenueAggregateBucket | null>> {
    if (!this.cache || periods.length === 0) return periods.map(() => null);
    try {
      const raw = await this.cache.mget(...periods.map((p) => revenueCacheKey(query, p)));
      return raw.map((value) => {
        if (!value) return null;
        try {
          return normalizeBucket(JSON.parse(value) as RevenueAggregateBucket);
        } catch {
          return null;
        }
      });
    } catch (err) {
      this.log.warn("Revenue cache read failed; querying database", {
        error: err instanceof Error ? err.message : String(err),
      });
      return periods.map(() => null);
    }
  }

  private async writeCache(query: RevenueAggregateQuery, buckets: RevenueAggregateBucket[]): Promise<void> {
    if (!this.cache || buckets.length === 0) return;
    try {
      const tx = this.cache.multi();
      for (const bucket of buckets) {
        tx.set(
          revenueCacheKey(query, new Date(bucket.periodStart)),
          JSON.stringify(bucket),
          "EX",
          REVENUE_CACHE_TTL_SECONDS
        );
      }
      await tx.exec();
    } catch (err) {
      this.log.warn("Revenue cache write failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Ownership
// ---------------------------------------------------------------------------

/** True when `userId` owns `merchantId`. */
export async function isMerchantOwner(
  sequelize: Sequelize,
  merchantId: string,
  userId: string
): Promise<boolean> {
  const rows = await sequelize.query<{ id: string }>(
    `SELECT id FROM merchants WHERE id = :merchantId AND owner_user_id = :userId LIMIT 1`,
    { type: QueryTypes.SELECT, replacements: { merchantId, userId } }
  );
  return rows.length > 0;
}
