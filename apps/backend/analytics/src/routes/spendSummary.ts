import type { IncomingMessage, ServerResponse } from "node:http";
import { createLogger, json } from "@delegolabs/utils";
import { extractAuth } from "../../../gateway/middleware/auth.js";
import { sendApiError, unauthorized } from "../../../gateway/src/errors.js";
import { getSpendSummary } from "../metrics/spendSummary.js";

const log = createLogger("analytics:spend-summary", process.env.LOG_LEVEL ?? "info");
const DAY_MS = 86_400_000;

function isDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString().slice(0, 10) === value;
}

export async function getSpendSummaryHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { userId } = extractAuth(req);
  if (!userId) {
    unauthorized(res, "Authentication required", req);
    return;
  }
  const params = new URL(req.url ?? "/", "http://localhost").searchParams;
  const granularity = params.get("granularity") ?? "daily";
  const category = params.get("category") ?? undefined;
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = `${today.slice(0, 7)}-01`;
  const nextMonth = new Date(monthStart);
  nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
  const periodStart = params.get("periodStart")
    ?? (granularity === "monthly" ? monthStart : new Date(Date.parse(today) - 29 * DAY_MS).toISOString().slice(0, 10));
  const periodEnd = params.get("periodEnd")
    ?? (granularity === "monthly" ? nextMonth.toISOString().slice(0, 10) : new Date(Date.parse(today) + DAY_MS).toISOString().slice(0, 10));

  if ((granularity !== "daily" && granularity !== "monthly")
    || !isDate(periodStart) || !isDate(periodEnd) || periodStart >= periodEnd
    || Date.parse(periodEnd) - Date.parse(periodStart) > 366 * DAY_MS
    || (category !== undefined && (category.length === 0 || [...category].length > 64))
    || (granularity === "monthly" && (!periodStart.endsWith("-01") || !periodEnd.endsWith("-01")))) {
    sendApiError(res, 400, "VALIDATION_ERROR",
      "Use daily or monthly granularity, valid YYYY-MM-DD dates with start < end (maximum 366 days), and a category of 1-64 characters. Monthly ranges must use first-of-month dates.", req);
    return;
  }
  try {
    const rows = await getSpendSummary({ userId, periodStart, periodEnd, granularity, category });
    json(res, 200, { data: { granularity, periodStart, periodEnd, rows }, error: null });
  } catch (error) {
    log.error("Spend summary query failed", { error: error instanceof Error ? error.message : String(error) });
    sendApiError(res, 500, "INTERNAL_ERROR", "Failed to fetch spend summary", req);
  }
}
