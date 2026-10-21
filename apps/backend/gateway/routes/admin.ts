/**
 * #340 — Admin routes for the rate-limit dashboard.
 *
 * All routes require the caller to carry a valid JWT that includes the
 * "admin" role.  Unauthenticated or insufficiently-privileged requests
 * receive 401 / 403 respectively.
 *
 * Routes
 * ------
 *   GET /api/v1/admin/rate-limit/metrics
 *     Returns aggregated rate-limit analytics (request counts, throttle counts,
 *     top users).  Optional query param `topN` (integer, 1–100, default 10).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { json } from "@delegolabs/utils";
import { extractAuth, getAuthenticatedUserContext } from "../middleware/auth.js";
import { sendApiError, forbidden, unauthorized } from "../src/errors.js";
import { aggregateRateLimitAnalytics } from "../src/rateLimit/analytics.js";
import { getRateLimitMetrics } from "../src/rateLimit/tokenBucket/metrics.js";
import { getAllCircuitBreakerStats } from "../src/circuitBreaker.js";

/** Returns true when the authenticated user has the "admin" role. */
function isAdmin(req: IncomingMessage): boolean {
  const ctx = getAuthenticatedUserContext(req);
  return ctx?.roles?.includes("admin") ?? false;
}

/**
 * GET /api/v1/admin/rate-limit/metrics
 *
 * Query params:
 *   topN  — number of top users to include (1–100, default 10)
 */
export async function rateLimitMetricsHandler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  // Authentication check
  const auth = extractAuth(req);
  if (!auth.userId) {
    unauthorized(res, "Authentication required", req);
    return;
  }

  // Authorization check
  if (!isAdmin(req)) {
    forbidden(res, "Admin role required", req);
    return;
  }

  // Parse optional topN query param
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const topNParam = url.searchParams.get("topN");
  let topN = 10;
  if (topNParam !== null) {
    const parsed = parseInt(topNParam, 10);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 100) {
      sendApiError(res, 400, "VALIDATION_ERROR", "topN must be an integer between 1 and 100", req);
      return;
    }
    topN = parsed;
  }

  try {
    const summary = await aggregateRateLimitAnalytics(topN);
    json(res, 200, { data: summary, error: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch rate limit analytics";
    sendApiError(res, 500, "INTERNAL_ERROR", message, req);
  }
}

/**
 * GET /api/v1/admin/rate-limit/tiered-metrics
 *
 * Issue #51 — Returns aggregate counters for the tiered token-bucket
 * limiter (total/allowed/denied requests, utilization, top denied callers).
 * Distinct from the legacy `/rate-limit/metrics` endpoint above, which
 * reports the older fixed-window limiter's per-endpoint/per-user analytics.
 *
 * Query params:
 *   topN  — number of top denied keys to include (1–100, default 10)
 */
export async function tieredRateLimitMetricsHandler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) {
    unauthorized(res, "Authentication required", req);
    return;
  }

  if (!isAdmin(req)) {
    forbidden(res, "Admin role required", req);
    return;
  }

  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const topNParam = url.searchParams.get("topN");
  let topN = 10;
  if (topNParam !== null) {
    const parsed = parseInt(topNParam, 10);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 100) {
      sendApiError(res, 400, "VALIDATION_ERROR", "topN must be an integer between 1 and 100", req);
      return;
    }
    topN = parsed;
  }

  json(res, 200, { data: getRateLimitMetrics(topN), error: null });
}

/**
 * GET /api/v1/admin/circuit-breakers
 *
 * Issue #364 — Returns the current state and stats for each downstream
 * service's circuit breaker (orchestrator, wallet, payments).
 */
export async function circuitBreakerStatusHandler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) {
    unauthorized(res, "Authentication required", req);
    return;
  }

  if (!isAdmin(req)) {
    forbidden(res, "Admin role required", req);
    return;
  }

  json(res, 200, { data: getAllCircuitBreakerStats(), error: null });
}

/**
 * POST /api/v1/admin/emergency/broadcast (Issue #375)
 * Broadcasts an emergency signal (kill_session, pause_all_traffic, resume) across all gateway instances.
 */
export async function emergencyBroadcastHandler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) {
    unauthorized(res, "Authentication required", req);
    return;
  }

  if (!isAdmin(req)) {
    forbidden(res, "Admin role required", req);
    return;
  }

  try {
    const body = await new Promise<any>((resolve, reject) => {
      let data = "";
      req.on("data", (chunk) => (data += chunk));
      req.on("end", () => {
        try {
          resolve(data ? JSON.parse(data) : {});
        } catch (e) {
          reject(new Error("Invalid JSON body"));
        }
      });
      req.on("error", reject);
    });

    const { action, targetId } = body;
    if (!action || !["kill_session", "pause_all_traffic", "resume"].includes(action)) {
      sendApiError(res, 400, "VALIDATION_ERROR", "action must be one of: kill_session, pause_all_traffic, resume", req);
      return;
    }

    if (action === "kill_session" && !targetId) {
      sendApiError(res, 400, "VALIDATION_ERROR", "targetId (session/token ID) is required for kill_session", req);
      return;
    }

    const { getEmergencyKillSwitchService } = await import("../src/emergency/killSwitch.js");
    const killSwitch = getEmergencyKillSwitchService();
    const signal = {
      action,
      targetId,
      signedByAdmin: auth.userId,
      timestamp: Date.now(),
    };

    await killSwitch.broadcast(signal);

    json(res, 200, {
      data: {
        success: true,
        signal,
        state: killSwitch.getState(),
      },
      error: null,
    });
  } catch (err: any) {
    sendApiError(res, 500, "INTERNAL_ERROR", err.message, req);
  }
}

/**
 * GET /api/v1/admin/emergency/status (Issue #375)
 * Returns current status of emergency kill-switch.
 */
export async function emergencyStatusHandler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) {
    unauthorized(res, "Authentication required", req);
    return;
  }

  if (!isAdmin(req)) {
    forbidden(res, "Admin role required", req);
    return;
  }

  const { getEmergencyKillSwitchService } = await import("../src/emergency/killSwitch.js");
  const killSwitch = getEmergencyKillSwitchService();
  const state = killSwitch.getState();

  json(res, 200, {
    data: {
      trafficPaused: state.trafficPaused,
      pausedAt: state.pausedAt,
      pausedBy: state.pausedBy,
      killedSessionsCount: state.killedSessions.size,
    },
    error: null,
  });
}
