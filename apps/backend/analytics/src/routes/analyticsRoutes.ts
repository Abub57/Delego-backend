import type { IncomingMessage, ServerResponse } from "node:http";
import { createTransactionHistoryRowStream, TRANSACTION_HISTORY_CSV_HEADERS } from "../services/transactionHistoryStream.js";
import { streamCsvExport } from "../services/csvExportService.js";
import { json, readBodyWithLimit } from "@delegolabs/utils";
import { extractAuth } from "../../../gateway/middleware/auth.js";
import { sendApiError, unauthorized } from "../../../gateway/src/errors.js";
import { analyticsService } from "../services/analyticsService.js";
import { merchantReputationService } from "../services/merchantReputationService.js";
import { abTestService } from "../services/abTestService.js";
import { cohortService } from "../services/cohortService.js";
import { revenueService } from "../services/revenueService.js";
import { customEventService } from "../services/customEventService.js";
import { exportService } from "../services/exportService.js";
import { FunnelMetricsQuery, EngagementMetricsQuery } from "../schemas.js";
import { ABTestCreateRequest, ABTestUpdateRequest, CustomEventRequest, ExportRequest } from "../schemas.js";

/** Read and parse the JSON request body. */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readBodyWithLimit(req);
  try {
    return body ? (JSON.parse(body) as Record<string, unknown>) : {};
  } catch {
    throw new Error("Invalid JSON body");
  }
}

/**
 * GET /api/v1/analytics/funnel
 *
 * Get delivery funnel metrics for notifications
 *
 * Query params:
 *   templateId - Filter by template ID
 *   channel    - Filter by channel (email, push, sms, in-app)
 *   periodStart - Start of period (ISO 8601)
 *   periodEnd   - End of period (ISO 8601)
 *   userId      - Filter by user ID
 */
export async function getFunnelMetricsHandler(req: IncomingMessage, res: ServerResponse, _params: Record<string, string>): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) {
    unauthorized(res, "Authentication required", req);
    return;
  }

  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const query: FunnelMetricsQuery = {
      templateId: url.searchParams.get("templateId") || undefined,
      channel: url.searchParams.get("channel") || undefined,
      periodStart: url.searchParams.get("periodStart") || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      periodEnd: url.searchParams.get("periodEnd") || new Date().toISOString(),
      userId: url.searchParams.get("userId") || undefined,
    };

    if (!query.periodStart || !query.periodEnd) {
      sendApiError(res, 400, "VALIDATION_ERROR", "periodStart and periodEnd are required", req);
      return;
    }

    const metrics = await analyticsService.getFunnelMetrics(query);

    json(res, 200, { data: metrics, error: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch funnel metrics";
    sendApiError(res, 500, "INTERNAL_ERROR", message, req);
  }
}

/**
 * GET /api/v1/analytics/engagement
 *
 * Get engagement metrics per template/channel
 */
export async function getEngagementMetricsHandler(req: IncomingMessage, res: ServerResponse, _params: Record<string, string>): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) {
    unauthorized(res, "Authentication required", req);
    return;
  }

  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const query: EngagementMetricsQuery = {
      templateId: url.searchParams.get("templateId") || undefined,
      channel: url.searchParams.get("channel") || undefined,
      periodStart: url.searchParams.get("periodStart") || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      periodEnd: url.searchParams.get("periodEnd") || new Date().toISOString(),
      userId: url.searchParams.get("userId") || undefined,
    };

    if (!query.periodStart || !query.periodEnd) {
      sendApiError(res, 400, "VALIDATION_ERROR", "periodStart and periodEnd are required", req);
      return;
    }

    const metrics = await analyticsService.getEngagementMetrics(query);

    json(res, 200, { data: metrics, error: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch engagement metrics";
    sendApiError(res, 500, "INTERNAL_ERROR", message, req);
  }
}

/**
 * GET /api/v1/analytics/ab-tests
 *
 * List all A/B tests
 */
export async function listABTestsHandler(req: IncomingMessage, res: ServerResponse, _params: Record<string, string>): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) {
    unauthorized(res, "Authentication required", req);
    return;
  }

  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const status = url.searchParams.get("status") || undefined;

    const tests = await abTestService.listABTests(status || undefined);

    json(res, 200, { data: tests, error: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch A/B tests";
    sendApiError(res, 500, "INTERNAL_ERROR", message, req);
  }
}

/**
 * POST /api/v1/analytics/ab-tests
 *
 * Create a new A/B test
 */
export async function createABTestHandler(req: IncomingMessage, res: ServerResponse, _params: Record<string, string>): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) {
    unauthorized(res, "Authentication required", req);
    return;
  }

  try {
    let body: ABTestCreateRequest;
    try {
      body = (await readJsonBody(req)) as unknown as ABTestCreateRequest;
    } catch {
      sendApiError(res, 400, "VALIDATION_ERROR", "Invalid JSON body", req);
      return;
    }

    // Validate required fields
    if (!body.name || !body.hypothesis || !body.variants || body.variants.length < 2) {
      sendApiError(res, 400, "VALIDATION_ERROR", "name, hypothesis, and at least 2 variants are required", req);
      return;
    }

    const test = await abTestService.createABTest(body);

    json(res, 201, { data: test, error: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create A/B test";
    sendApiError(res, 500, "INTERNAL_ERROR", message, req);
  }
}

/**
 * GET /api/v1/analytics/ab-tests/:id
 *
 * Get a specific A/B test
 */
export async function getABTestHandler(req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) {
    unauthorized(res, "Authentication required", req);
    return;
  }

  try {
    const id = params.id;

    if (!id) {
      sendApiError(res, 400, "VALIDATION_ERROR", "AB test ID required", req);
      return;
    }

    const test = await abTestService.getABTest(id);

    if (!test) {
      sendApiError(res, 404, "NOT_FOUND", "A/B test not found", req);
      return;
    }

    json(res, 200, { data: test, error: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch A/B test";
    sendApiError(res, 500, "INTERNAL_ERROR", message, req);
  }
}

/**
 * PATCH /api/v1/analytics/ab-tests/:id
 *
 * Update an A/B test
 */
export async function updateABTestHandler(req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) {
    unauthorized(res, "Authentication required", req);
    return;
  }

  try {
    const id = params.id;

    if (!id) {
      sendApiError(res, 400, "VALIDATION_ERROR", "AB test ID required", req);
      return;
    }

    let body: ABTestUpdateRequest;
    try {
      body = (await readJsonBody(req)) as unknown as ABTestUpdateRequest;
    } catch {
      sendApiError(res, 400, "VALIDATION_ERROR", "Invalid JSON body", req);
      return;
    }

    const test = await abTestService.updateABTest(id, body);

    if (!test) {
      sendApiError(res, 404, "NOT_FOUND", "A/B test not found", req);
      return;
    }

    json(res, 200, { data: test, error: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to update A/B test";
    sendApiError(res, 500, "INTERNAL_ERROR", message, req);
  }
}

/**
 * POST /api/v1/analytics/ab-tests/:id/start
 *
 * Start an A/B test
 */
export async function startABTestHandler(req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) {
    unauthorized(res, "Authentication required", req);
    return;
  }

  try {
    const id = params.id;

    if (!id) {
      sendApiError(res, 400, "VALIDATION_ERROR", "AB test ID required", req);
      return;
    }

    const test = await abTestService.startABTest(id);

    if (!test) {
      sendApiError(res, 404, "NOT_FOUND", "A/B test not found", req);
      return;
    }

    json(res, 200, { data: test, error: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to start A/B test";
    sendApiError(res, 500, "INTERNAL_ERROR", message, req);
  }
}

/**
 * POST /api/v1/analytics/ab-tests/:id/end
 *
 * End an A/B test
 */
export async function endABTestHandler(req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) {
    unauthorized(res, "Authentication required", req);
    return;
  }

  try {
    const id = params.id;

    if (!id) {
      sendApiError(res, 400, "VALIDATION_ERROR", "AB test ID required", req);
      return;
    }

    const test = await abTestService.endABTest(id);

    if (!test) {
      sendApiError(res, 404, "NOT_FOUND", "A/B test not found", req);
      return;
    }

    json(res, 200, { data: test, error: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to end A/B test";
    sendApiError(res, 500, "INTERNAL_ERROR", message, req);
  }
}

/**
 * GET /api/v1/analytics/cohorts
 *
 * Get cohort analysis
 */
export async function getCohortAnalysisHandler(req: IncomingMessage, res: ServerResponse, _params: Record<string, string>): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) {
    unauthorized(res, "Authentication required", req);
    return;
  }

  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const cohort = url.searchParams.get("cohort") || undefined;

    const analysis = await cohortService.getCohortAnalysis(cohort);

    json(res, 200, { data: analysis, error: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch cohort analysis";
    sendApiError(res, 500, "INTERNAL_ERROR", message, req);
  }
}

/**
 * POST /api/v1/analytics/events
 *
 * Track custom events
 */
export async function trackCustomEventHandler(req: IncomingMessage, res: ServerResponse, _params: Record<string, string>): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) {
    unauthorized(res, "Authentication required", req);
    return;
  }

  try {
    let body: CustomEventRequest;
    try {
      body = (await readJsonBody(req)) as unknown as CustomEventRequest;
    } catch {
      sendApiError(res, 400, "VALIDATION_ERROR", "Invalid JSON body", req);
      return;
    }

    if (!body.eventName) {
      sendApiError(res, 400, "VALIDATION_ERROR", "eventName is required", req);
      return;
    }

    const event = await customEventService.trackEvent(body);

    json(res, 201, { data: event, error: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to track event";
    sendApiError(res, 500, "INTERNAL_ERROR", message, req);
  }
}

/**
 * GET /api/v1/analytics/export/transactions.csv
 *
 * Stream the transaction history as CSV directly to the HTTP response in
 * chunks — Issue #395. The database is read one page at a time (keyset
 * pagination) and rows are serialized on the fly, so memory stays flat even
 * for 100k+ row exports.
 *
 * Query params (all optional):
 *   userId      - Filter by user ID
 *   templateId  - Filter by template ID
 *   channel     - Filter by channel (email, push, sms, in-app)
 *   eventType   - Filter by event type (sent, delivered, opened, ...)
 *   periodStart - ISO-8601 lower bound on timestamp (inclusive)
 *   periodEnd   - ISO-8601 upper bound on timestamp (inclusive)
 *   pageSize    - DB page size (default 1000, max 5000)
 *   maxRows     - Hard cap on exported rows
 */
export async function exportTransactionsCsvHandler(req: IncomingMessage, res: ServerResponse, _params: Record<string, string>): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) {
    unauthorized(res, "Authentication required", req);
    return;
  }

  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  const pageSize = Math.min(Math.max(Number(url.searchParams.get("pageSize")) || 1000, 1), 5000);
  const maxRowsParam = url.searchParams.get("maxRows");
  const maxRows = maxRowsParam ? Math.max(Number(maxRowsParam) || 0, 0) || undefined : undefined;

  const queryStream = createTransactionHistoryRowStream({
    pageSize,
    ...(maxRows !== undefined ? { maxRows } : {}),
    filters: {
      userId: url.searchParams.get("userId") || undefined,
      templateId: url.searchParams.get("templateId") || undefined,
      channel: url.searchParams.get("channel") || undefined,
      eventType: url.searchParams.get("eventType") || undefined,
      periodStart: url.searchParams.get("periodStart") || undefined,
      periodEnd: url.searchParams.get("periodEnd") || undefined,
    },
  });

  // Fire-and-forget per the issue spec (`streamCsvExport(...): void`): the
  // pipeline runs in the background; errors are logged and the response is
  // torn down inside streamCsvExportAsync.
  streamCsvExport(queryStream, res, {
    headers: TRANSACTION_HISTORY_CSV_HEADERS,
    filename: "transaction-history.csv",
  });
}

/**
 * POST /api/v1/analytics/export
 *
 * Export data to data warehouse
 */
export async function exportDataHandler(req: IncomingMessage, res: ServerResponse, _params: Record<string, string>): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) {
    unauthorized(res, "Authentication required", req);
    return;
  }

  try {
    let body: ExportRequest;
    try {
      body = (await readJsonBody(req)) as unknown as ExportRequest;
    } catch {
      sendApiError(res, 400, "VALIDATION_ERROR", "Invalid JSON body", req);
      return;
    }

    if (!body.type || !body.destination) {
      sendApiError(res, 400, "VALIDATION_ERROR", "type and destination are required", req);
      return;
    }

    const exportResult = await exportService.exportData(body);

    json(res, 202, { data: exportResult, error: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to export data";
    sendApiError(res, 500, "INTERNAL_ERROR", message, req);
  }
}

/**
 * GET /api/v1/analytics/revenue
 *
 * Get revenue attribution metrics
 */
export async function getRevenueMetricsHandler(req: IncomingMessage, res: ServerResponse, _params: Record<string, string>): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) {
    unauthorized(res, "Authentication required", req);
    return;
  }

  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const templateId = url.searchParams.get("templateId") || undefined;
    const periodStart = url.searchParams.get("periodStart") || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const periodEnd = url.searchParams.get("periodEnd") || new Date().toISOString();

    const breakdown = await revenueService.getRevenueBreakdown(templateId, periodStart, periodEnd);

    // Calculate total revenue
    const totalRevenue = breakdown.reduce((sum, item) => sum + item.revenue, 0);

    json(res, 200, {
      data: {
        totalRevenue,
        breakdown,
      },
      error: null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch revenue metrics";
    sendApiError(res, 500, "INTERNAL_ERROR", message, req);
  }
}

/**
 * GET /api/v1/analytics/merchants/:merchantId/quality-score
 *
 * #392 — Merchant reputation weight: a normalized 0-100 composite score
 * factoring in dispute frequency, fulfillment/on-time rate, and
 * cancellation rate. Cached in Redis; see merchantReputationService.
 *
 * Query params:
 *   periodStart - Only consider orders created on/after this ISO-8601 timestamp
 *   periodEnd   - Only consider orders created on/before this ISO-8601 timestamp
 */
export async function getMerchantQualityScoreHandler(req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) {
    unauthorized(res, "Authentication required", req);
    return;
  }

  const merchantId = params["merchantId"];
  if (!merchantId) {
    sendApiError(res, 400, "VALIDATION_ERROR", "merchantId is required", req);
    return;
  }

  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const periodStart = url.searchParams.get("periodStart") || undefined;
    const periodEnd = url.searchParams.get("periodEnd") || undefined;

    const metrics = await merchantReputationService.getMerchantQualityMetrics({ merchantId, periodStart, periodEnd });

    json(res, 200, { data: metrics, error: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to compute merchant quality score";
    sendApiError(res, 500, "INTERNAL_ERROR", message, req);
  }
}

/**
 * GET /api/v1/analytics/merchants/:merchantId/sales (Issue #377)
 *
 * Query continuous aggregate sales metrics for a merchant.
 *
 * Query params:
 *   interval  - Time bucket ('1m', '1h', '1d', default '1h')
 *   startTime - ISO 8601 start timestamp
 *   endTime   - ISO 8601 end timestamp
 *   limit     - Max number of data points (default 100)
 */
export async function getMerchantSalesHandler(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>
): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) {
    unauthorized(res, "Authentication required", req);
    return;
  }

  const merchantId = params.merchantId;
  if (!merchantId) {
    sendApiError(res, 400, "VALIDATION_ERROR", "merchantId is required", req);
    return;
  }

  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const intervalParam = url.searchParams.get("interval") as any;
    const interval = ["1m", "1h", "1d"].includes(intervalParam) ? intervalParam : "1h";
    const startTime = url.searchParams.get("startTime") || undefined;
    const endTime = url.searchParams.get("endTime") || undefined;
    const limit = url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : undefined;

    const { merchantAnalyticsService } = await import("../services/merchantAnalyticsService.js");
    const result = await merchantAnalyticsService.getMerchantSales({
      merchantId,
      bucketInterval: interval,
      startTime,
      endTime,
      limit,
    });

    json(res, 200, { data: result, error: null });
  } catch (err: any) {
    sendApiError(res, 500, "INTERNAL_ERROR", err.message, req);
  }
}
