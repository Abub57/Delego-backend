/**
 * Gateway health endpoints (Issue #76; probe contract extended by Issue #376)
 *
 * Serves the standard health surface backed by the gateway HealthRegistry:
 *   GET /health/live       — liveness probe (200 while the process is running)
 *   GET /health/ready      — readiness probe (503 when a critical dependency is down)
 *   GET /health            — full aggregate (backward compatible with the SDK)
 *   GET /health/config     — dependency graph definition
 *   GET /health/dashboard  — real-time HTML dashboard
 *   GET /health/metrics    — Prometheus-format metrics
 *
 * `/health/live` and `/health/ready` are gateway-owned and emit the
 * HealthCheckReport contract from Issue #376 ({ status, checks }), where each
 * probed dependency reports a boolean reachability and its measured latency.
 */

import {
  createHealthRoutes,
  json,
  route,
  type HealthRegistry,
  type Route,
  type RouteHandler,
} from "@delegolabs/utils";
import {
  buildGatewayHealthReport,
  createGatewayHealthRegistry,
  type HealthCheckReport,
} from "../src/health.js";

const SERVICE_NAME = "gateway";
const VERSION = "0.0.1";

export const gatewayHealthRegistry = createGatewayHealthRegistry();

/** Liveness report — cheap, the process answered, no dependency I/O. */
export function livenessReport(): HealthCheckReport {
  return { status: "healthy", checks: { process: { status: true, latencyMs: 0 } } };
}

export const healthLiveHandler: RouteHandler = (_req, res) => {
  json(res, 200, { data: livenessReport(), error: null });
};

/** Readiness probe: 503 only when a critical dependency is unhealthy. */
export function createHealthReadyHandler(registry: HealthRegistry): RouteHandler {
  return async (_req, res) => {
    const report = await buildGatewayHealthReport(registry, VERSION);
    json(res, report.status === "unhealthy" ? 503 : 200, { data: report, error: null });
  };
}

/**
 * Builds the gateway health routes. `/health/live` and `/health/ready` are
 * gateway-owned so they can emit the HealthCheckReport contract; the remaining
 * shared routes (/health, /health/config, /health/dashboard, /health/metrics)
 * come from @delegolabs/utils.
 */
export function createGatewayHealthRoutes(
  registry: HealthRegistry = gatewayHealthRegistry,
): Route[] {
  const shared = createHealthRoutes({
    registry,
    serviceName: SERVICE_NAME,
    version: VERSION,
  });
  const remaining = shared.filter(
    (r) => !r.pattern.test("/health/live") && !r.pattern.test("/health/ready"),
  );

  return [
    route("GET", "/health/live", healthLiveHandler),
    route("GET", "/health/ready", createHealthReadyHandler(registry)),
    ...remaining,
  ];
}

export function registerHealthRoutes(): Route[] {
  return createGatewayHealthRoutes(gatewayHealthRegistry);
}

/**
 * Backward-compatible health handler matching the original /health contract
 * (always 200, legacy `dependencies` array with postgresql + redis). Kept so
 * existing consumers and the legacy unit suite continue to work; new consumers
 * should use the `/health`, `/health/live`, `/health/ready`, `/health/dashboard`
 * and `/health/metrics` routes.
 */
export const healthHandler: RouteHandler = async (_req, res) => {
  const health = await gatewayHealthRegistry.getServiceHealth("gateway", VERSION);

  const dependencies = health.checks
    .filter((c) => c.name === "postgresql" || c.name === "redis")
    .map((c) => ({
      name: c.name,
      status: c.status === "healthy" ? "ok" : "degraded",
      latencyMs: Math.floor(c.latencyMs),
    }));

  json(res, 200, {
    data: {
      status: health.status === "healthy" ? "ok" : "degraded",
      service: "gateway",
      version: VERSION,
      timestamp: new Date().toISOString(),
      dependencies,
    },
    error: null,
  });
};
