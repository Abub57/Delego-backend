import { QueryTypes, type Sequelize } from "sequelize";
import { createLogger } from "@delegolabs/utils";
import { sequelize } from "../db.js";

export const SPEND_AGGREGATION_INTERVAL_MS = 60 * 60 * 1000;
const log = createLogger("analytics:spend", process.env.LOG_LEVEL ?? "info");

/** Rebuild both granularities from one snapshot, including late settlements.
 * DELETE (rather than TRUNCATE) lets dashboard readers keep the previous
 * committed summaries until the entire refresh commits. A failed refresh
 * rolls back, and the transaction lock prevents concurrent replica refreshes.
 */
export async function aggregateSpendMetrics(db: Sequelize = sequelize): Promise<boolean> {
  return db.transaction(async (transaction) => {
    const [lock] = await db.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_xact_lock(306, 1) AS acquired",
      { transaction, type: QueryTypes.SELECT },
    );
    if (!lock.acquired) return false;

    await db.query(`
      CREATE TEMP TABLE spend_daily_snapshot ON COMMIT DROP AS
      SELECT (p.updated_at AT TIME ZONE 'UTC')::date AS date,
             o.user_id,
             COALESCE(NULLIF(m.category, ''), 'uncategorized') AS category,
             SUM(p.amount_stroops - p.refunded_amount_stroops)::bigint AS total_spent_stroops,
             COUNT(*)::int AS orders_count
      FROM payment_records p
      JOIN orders o ON o.id = p.order_id
      LEFT JOIN merchants m ON m.id::text = o.merchant_id
      WHERE p.status = 'released' AND p.updated_at IS NOT NULL
      GROUP BY 1, 2, 3
    `, { transaction });

    await db.query("DELETE FROM daily_spend_metrics", { transaction });
    await db.query(`
      INSERT INTO daily_spend_metrics (date, user_id, category, total_spent_stroops, orders_count)
      SELECT date, user_id, category, total_spent_stroops, orders_count
      FROM spend_daily_snapshot
    `, { transaction });
    await db.query("DELETE FROM monthly_spend_metrics", { transaction });
    await db.query(`
      INSERT INTO monthly_spend_metrics (month, user_id, category, total_spent_stroops, orders_count)
      SELECT date_trunc('month', date::timestamp)::date, user_id, category,
             SUM(total_spent_stroops)::bigint, SUM(orders_count)::int
      FROM spend_daily_snapshot
      GROUP BY 1, 2, 3
    `, { transaction });
    return true;
  });
}

/** Run at startup and hourly; stop waits for any active transaction to finish. */
export function startSpendMetricsAggregator(
  refresh: () => Promise<boolean> = aggregateSpendMetrics,
): { stop: () => Promise<void> } {
  let active: Promise<void> | undefined;
  const run = () => {
    if (active) return;
    active = Promise.resolve().then(refresh).then((updated) => {
      if (updated) log.info("Spend summaries refreshed");
    }).catch((error: unknown) => {
      log.error("Spend summary refresh failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }).finally(() => { active = undefined; });
  };
  run();
  const timer = setInterval(run, SPEND_AGGREGATION_INTERVAL_MS);
  timer.unref();
  return {
    async stop() {
      clearInterval(timer);
      await active;
    },
  };
}
