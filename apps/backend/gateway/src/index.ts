/**
 * @delegolabs/gateway — API entry point
 * Routes external requests to internal services.
 */
// Must stay the first import: initialises Sentry before other modules load (Issue #10).
import { sentryConfig } from "./instrument.js";
import { createLogger, initTelemetry, startHttpServer, corsMiddleware, securityHeadersMiddleware, ServiceMetricsRegistry } from "@delegolabs/utils";
import { registerRoutes } from "../routes/index.js";
import { bodyLimitMiddleware } from "../routes/api-v1.js";
import { rateLimitMiddleware } from "../middleware/rateLimit.js";
import { idempotencyMiddleware } from "../middleware/idempotency.js";
import { requestIdMiddleware } from "../middleware/requestId.js";
import { compressionMiddleware } from "../middleware/compression.js";
import { openApiValidationMiddleware } from "../middleware/openApiValidation.js";
import { requestResponseLoggingMiddleware } from "./logging/middleware.js";
import { raspMiddleware } from "../middleware/rasp.js";
import { versionNegotiationMiddleware } from "./middleware/versioning.js";
import { metricsMiddleware } from "./metrics.js";
import { killSwitchMiddleware } from "../middleware/killSwitch.js";
import { getEmergencyKillSwitchService } from "./emergency/killSwitch.js";
import { registerGracefulShutdown } from "./shutdown.js";
import { startMetricsSampling, adaptiveRateLimitingMiddleware } from "./rateLimit/adaptive.js";
import { sequelize, initializeDbMetrics } from "./db.js";
import { withSentryMiddleware, withSentryRoutes } from "./observability/sentryRequest.js";

const SERVICE_NAME = "gateway";
const DEFAULT_PORT = 3000;

const nodeEnv = process.env.NODE_ENV ?? "development";
const logLevel = process.env.LOG_LEVEL ?? "info";
const log = createLogger(SERVICE_NAME, logLevel);

// Distributed tracing (Issue #307): enabled when OTEL_EXPORTER_OTLP_ENDPOINT is set.
void initTelemetry(SERVICE_NAME).catch((err: unknown) =>
  log.warn("Telemetry init failed", { error: err instanceof Error ? err.message : String(err) })
);
if (sentryConfig) {
  log.info("Sentry enabled", {
    environment: sentryConfig.environment,
    tracesSampleRate: sentryConfig.tracesSampleRate,
  });
} else {
  log.info("Sentry disabled (SENTRY_DSN not set)");
}

const port = Number(process.env.GATEWAY_PORT ?? DEFAULT_PORT);

logger.info("Starting gateway", { port, nodeEnv, logLevel });

// Start emergency kill-switch subscriber
getEmergencyKillSwitchService().start().catch((err) => {
  log.warn("Failed to initialize emergency kill-switch service", { error: err.message });
});

// Initialize database query latency metrics (Issue #387)
const metricsRegistry = new ServiceMetricsRegistry();
initializeDbMetrics(metricsRegistry);

startMetricsSampling();

const server = startHttpServer({
  port,
  serviceName: SERVICE_NAME,
  // Sentry wrappers report errors, then hand them back to the router's existing
  // error responses. They are no-ops when SENTRY_DSN is unset.
  middleware: withSentryMiddleware([
    metricsMiddleware(),
    requestIdMiddleware(),
    corsMiddleware(),
    securityHeadersMiddleware(),
    killSwitchMiddleware(),
    raspMiddleware(),
    // Version negotiation must run before auth and rate-limiting so that
    // sunset versions get 410 Gone before any further processing.
    versionNegotiationMiddleware(),
    bodyLimitMiddleware(),
    // OpenAPI request validation - validates path, query, and body parameters
    validateRequest(),
    openApiValidationMiddleware({
      validateResponses: process.env.GATEWAY_VALIDATE_RESPONSES === "true",
    }),
    adaptiveRateLimitingMiddleware(),
    rateLimitMiddleware(),
    // Deduplicates retried mutations (Issue #380): must wrap route handlers,
    // so it runs after auth/rate-limiting and before response capture points.
    idempotencyMiddleware(),
    compressionMiddleware(),
    requestResponseLoggingMiddleware(),
  ]),
  routes: withSentryRoutes(registerRoutes()),
});

registerGracefulShutdown(server);
