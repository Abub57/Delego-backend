/**
 * GET /api/v1/merchant/analytics/revenue
 *
 * Query params (all validated before any database work):
 *   merchantId  UUID of a merchant the caller owns (admins may read any)
 *   startDate   ISO 8601 date or datetime
 *   endDate     ISO 8601 date or datetime (its whole period is included)
 *   groupBy     day | week | month            (default: day)
 *   currency    settlement currency code, e.g. USDC, EURC, XLM
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { json } from "@delegolabs/utils";
import type { RevenueAggregateQuery, RevenueGroupBy } from "@delegolabs/types";
import { extractAuth, getAuthenticatedUserContext } from "../../../gateway/middleware/auth.js";
import { badRequest, forbidden, sendApiError, unauthorized } from "../../../gateway/src/errors.js";
import { sequelize } from "../db.js";
import { getRedisClient } from "../redisClient.js";
import {
  MAX_BUCKETS,
  MerchantRevenueService,
  enumeratePeriods,
  isMerchantOwner,
  sequelizeRevenueExecutor,
  type RevenueCacheClient,
} from "../services/merchantRevenueService.js";

const GROUP_BY_VALUES: readonly RevenueGroupBy[] = ["day", "week", "month"];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CURRENCY_PATTERN = /^[A-Z0-9]{1,12}$/;
const ISO_DATE_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;

export type ParseResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

/** Rejects impossible calendar dates such as 2026-02-30 that `Date` would roll over. */
function parseIsoDate(raw: string | null, field: string, errors: string[]): Date | null {
  if (!raw) {
    errors.push(`${field} is required`);
    return null;
  }
  const match = ISO_DATE_PATTERN.exec(raw);
  const date = new Date(raw.length === 10 ? `${raw}T00:00:00Z` : raw);
  if (!match || Number.isNaN(date.getTime())) {
    errors.push(`${field} must be an ISO 8601 date or datetime`);
    return null;
  }
  const [, y, m, d] = match.map(Number);
  const calendar = new Date(Date.UTC(y, m - 1, d));
  if (calendar.getUTCFullYear() !== y || calendar.getUTCMonth() !== m - 1 || calendar.getUTCDate() !== d) {
    errors.push(`${field} is not a valid calendar date`);
    return null;
  }
  return date;
}

export function parseRevenueAggregateQuery(params: URLSearchParams): ParseResult<RevenueAggregateQuery> {
  const errors: string[] = [];

  const merchantId = params.get("merchantId")?.trim() ?? "";
  if (!UUID_PATTERN.test(merchantId)) errors.push("merchantId must be a UUID");

  const currency = (params.get("currency") ?? "").trim().toUpperCase();
  if (!CURRENCY_PATTERN.test(currency)) errors.push("currency must be 1-12 alphanumeric characters");

  const groupByRaw = params.get("groupBy") ?? "day";
  const groupBy = GROUP_BY_VALUES.find((g) => g === groupByRaw);
  if (!groupBy) errors.push(`groupBy must be one of ${GROUP_BY_VALUES.join(", ")}`);

  const start = parseIsoDate(params.get("startDate"), "startDate", errors);
  const end = parseIsoDate(params.get("endDate"), "endDate", errors);
  if (start && end && start.getTime() > end.getTime()) errors.push("startDate must not be after endDate");

  if (start && end && groupBy && start.getTime() <= end.getTime()) {
    const buckets = enumeratePeriods(start, end, groupBy).length;
    if (buckets > MAX_BUCKETS[groupBy]) {
      errors.push(`range spans ${buckets} ${groupBy} buckets; maximum is ${MAX_BUCKETS[groupBy]}`);
    }
  }

  if (errors.length > 0 || !start || !end || !groupBy) return { ok: false, errors };
  return {
    ok: true,
    value: { merchantId, currency, groupBy, startDate: start.toISOString(), endDate: end.toISOString() },
  };
}

export interface MerchantRevenueHandlerDeps {
  service: Pick<MerchantRevenueService, "getRevenueAggregates">;
  isOwner: (merchantId: string, userId: string) => Promise<boolean>;
}

export function createMerchantRevenueHandler(deps: MerchantRevenueHandlerDeps) {
  return async function getMerchantRevenueHandler(
    req: IncomingMessage,
    res: ServerResponse,
    _params: Record<string, string>
  ): Promise<void> {
    const auth = extractAuth(req);
    if (!auth.userId) {
      unauthorized(res, "Authentication required", req);
      return;
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const parsed = parseRevenueAggregateQuery(url.searchParams);
    if (!parsed.ok) {
      badRequest(res, "Invalid revenue report query", req, parsed.errors);
      return;
    }

    try {
      const isAdmin = getAuthenticatedUserContext(req)?.roles.includes("admin") ?? false;
      if (!isAdmin && !(await deps.isOwner(parsed.value.merchantId, auth.userId))) {
        forbidden(res, "You do not have access to this merchant's revenue", req);
        return;
      }

      const report = await deps.service.getRevenueAggregates(parsed.value);
      json(res, 200, { data: report, error: null });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to build revenue report";
      sendApiError(res, 500, "INTERNAL_ERROR", message, req);
    }
  };
}

let defaultHandler: ReturnType<typeof createMerchantRevenueHandler> | null = null;

/** Lazily wired so importing the route table does not open Redis connections. */
export function getMerchantRevenueHandler(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>
): Promise<void> {
  defaultHandler ??= createMerchantRevenueHandler({
    service: new MerchantRevenueService({
      execute: sequelizeRevenueExecutor(sequelize),
      cache: getRedisClient() as unknown as RevenueCacheClient,
    }),
    isOwner: (merchantId, userId) => isMerchantOwner(sequelize, merchantId, userId),
  });
  return defaultHandler(req, res, params);
}
