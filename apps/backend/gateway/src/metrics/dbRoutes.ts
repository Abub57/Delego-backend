/**
 * Database Query Metrics Routes
 * Issue #387: Expose database query latency SLA metrics
 */

import type { RouteHandler } from "@delegolabs/utils";
import { success, internalError } from "../errors.js";
import { getSlaStatus, getSlowQueries, toPrometheusText, getDbMetricsConfig } from "./metrics/dbMetrics.js";

/**
 * GET /api/v1/metrics/db/sla
 * Returns database SLA status including slow query rate and threshold
 */
export const dbSlaStatusHandler: RouteHandler = async (_req, res) => {
  try {
    const status = getSlaStatus();
    return success(res, status);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    return internalError(res, error.message);
  }
};

/**
 * GET /api/v1/metrics/db/slow-queries
 * Returns recent slow queries for debugging
 */
export const dbSlowQueriesHandler: RouteHandler = async (req, res) => {
  try {
    const url = new URL(req.url || "", `http://${req.headers.host}`);
    const limit = parseInt(url.searchParams.get("limit") || "100", 10);
    const slowQueries = getSlowQueries(Math.min(limit, 1000));
    return success(res, { slowQueries, count: slowQueries.length });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    return internalError(res, error.message);
  }
};

/**
 * GET /api/v1/metrics/db/config
 * Returns current database metrics configuration
 */
export const dbMetricsConfigHandler: RouteHandler = async (_req, res) => {
  try {
    const config = getDbMetricsConfig();
    return success(res, config);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    return internalError(res, error.message);
  }
};

/**
 * GET /api/v1/metrics/db/prometheus
 * Returns Prometheus-formatted metrics for database queries
 */
export const dbPrometheusMetricsHandler: RouteHandler = async (_req, res) => {
  try {
    const metricsText = toPrometheusText();
    res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    res.writeHead(200);
    res.end(metricsText);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    return internalError(res, error.message);
  }
};