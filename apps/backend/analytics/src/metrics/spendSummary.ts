import { QueryTypes, type Sequelize } from "sequelize";
import { sequelize } from "../db.js";

export interface SpendSummaryQuery {
  userId: string;
  periodStart: string;
  periodEnd: string;
  granularity: "daily" | "monthly";
  category?: string;
}

export interface SpendSummaryRow {
  date: string;
  category: string;
  totalSpentStroops: string;
  ordersCount: number;
}

export function getSpendSummary(query: SpendSummaryQuery, db: Sequelize = sequelize): Promise<SpendSummaryRow[]> {
  // Only these fixed identifiers may enter the query; values are bound.
  const monthly = query.granularity === "monthly";
  const table = monthly ? "monthly_spend_metrics" : "daily_spend_metrics";
  const date = monthly ? "month" : "date";
  return db.query<SpendSummaryRow>(`
    SELECT ${date}::text AS date, category,
           total_spent_stroops::text AS "totalSpentStroops", orders_count AS "ordersCount"
    FROM ${table}
    WHERE user_id = $userId::uuid
      AND ${date} >= $periodStart::date AND ${date} < $periodEnd::date
      ${query.category !== undefined ? "AND category = $category" : ""}
    ORDER BY ${date}, category
  `, { bind: { ...query }, type: QueryTypes.SELECT });
}
