import type { Route } from "@delegolabs/utils";
import { route } from "@delegolabs/utils";
import { registerHealthRoutes } from "./health.js";
import { versionDiscoveryRoute } from "../src/versionedRouter.js";
import { apiV1Handler } from "./api-v1.js";
import {
  registerHandler,
  loginHandler,
  refreshHandler,
  logoutHandler,
  oauthCallbackHandler,
  oauthAuthorizeHandler,
  introspectHandler,
  revokeHandler,
  jwksHandler,
} from "./auth.js";
import {
  beginRegistrationHandler,
  completeRegistrationHandler,
  beginAuthenticationHandler,
  completeAuthenticationHandler,
  listPasskeysHandler,
  renamePasskeyHandler,
  deletePasskeyHandler,
} from "./passkeys.js";
import {
  createDelegationHandler,
  listDelegationsHandler,
  getDelegationHandler,
  updateDelegationHandler,
  revokeDelegationHandler,
} from "./delegations.js";
import { getWalletHandler } from "./wallets.js";
import {
  rateLimitMetricsHandler,
  circuitBreakerStatusHandler,
  tieredRateLimitMetricsHandler,
  emergencyBroadcastHandler,
  emergencyStatusHandler,
} from "./admin.js";
import { auditLogQueryHandler, auditLogVerifyHandler } from "./audit.js";
import { swaggerHandler } from "../src/swagger.js";
import {
  logSearchHandler,
  logStatsHandler,
  logClearHandler,
} from "../src/logging/routes.js";
import {
  raspMetricsHandler,
  raspEventsHandler,
  raspSimulationHandler,
  raspFalsePositiveHandler,
} from "./rasp.js";
import {
  createApiKeyHandler,
  listApiKeysHandler,
  getApiKeyHandler,
  revokeApiKeyHandler,
  suspendApiKeyHandler,
  activateApiKeyHandler,
  updateApiKeyScopesHandler,
} from "../src/apiKeyScoping/routes.js";
import {
  registerScriptHandler,
  listScriptsHandler,
  getScriptHandler,
  testScriptHandler,
  deployScriptHandler,
  rollbackScriptHandler,
  getScriptMetricsHandler,
  deleteScriptHandler,
} from "../../lua-scripts/src/routes.js";
import {
  createScheduleHandler,
  listSchedulesHandler,
  getScheduleHandler,
  updateScheduleHandler,
  deleteScheduleHandler,
  getCurrentOnCallHandler,
  createPolicyHandler,
  listPoliciesHandler,
  getPolicyHandler,
  createRouteHandler,
  listRoutesHandler,
  createAlertHandler,
  listAlertsHandler,
  acknowledgeAlertHandler,
  resolveAlertHandler,
  createChannelHandler,
  listChannelsHandler,
  sendNotificationHandler,
  monitoringDashboardHandler,
} from "../../monitoring/src/routes.js";
import {
  createTemplateHandler,
  listTemplatesHandler,
  getTemplateHandler,
  listTemplateVersionsHandler,
  deleteTemplateHandler,
  deprecateTemplateVersionHandler,
  catalogHandler,
  categoriesHandler,
  rateTemplateHandler,
  instantiateTemplateHandler,
  testTemplateHandler,
  templateDocumentationHandler,
} from "../../orchestrator/src/templates/routes.js";
import { oracleHealthHandler } from "../../monitoring/src/oracleHealth.js";
import { registerPaymentRoutes } from "./payment.js";
import { registerRecoveryRoutes } from "./recovery.js";
import { registerMultiCurrencyRoutes } from "./multi-currency.js";
import { registerStorefrontRoutes } from "./storefront.js";
import { updateMerchantProfileHandler } from "./merchantProfile.js";
import { registerStorageRoutes } from "./storage.js";
import { registerDisputeRoutes } from "./disputes.js";
import { searchProductsHandler, embeddingCacheMetricsHandler } from "../src/search/routes.js";
import { registerMerchantRoutes } from "../src/merchant/routes.js";
import { registerCatalogRoutes } from "../src/catalog/routes.js";
import { registerVariantRoutes } from "../src/catalog/variants.js";
import { registerReviewRoutes } from "../src/catalog/reviews.js";
import { registerDeliveryEvidenceRoutes } from "../src/catalog/deliveryEvidence.js";
import { registerWaitlistRoutes } from "../src/waitlist/routes.js";
import { registerBulkCatalogImportRoutes } from "../src/catalog/bulkImport/routes.js";
import { registerAgentChatRoutes } from "./agentChat.js";
import { registerWebhookRoutes } from "./webhooks.js";
import { registerMetricsRoutes } from "../src/metrics.js";
import {
  dbSlaStatusHandler,
  dbSlowQueriesHandler,
  dbMetricsConfigHandler,
  dbPrometheusMetricsHandler,
} from "../src/metrics/dbRoutes.js";
/** Register all gateway routes */
export function registerRoutes(): Route[] {
  return [
    ...registerHealthRoutes(),
    ...registerMetricsRoutes(),
    // API version discovery — GET /api/versions (issue #54)
    versionDiscoveryRoute,
    route("GET", "/api/v1/status", apiV1Handler),
    route("POST", "/api/v1/auth/register", registerHandler),
    route("POST", "/api/v1/auth/login", loginHandler),
    route("POST", "/api/v1/auth/refresh", refreshHandler),
    route("POST", "/api/v1/auth/logout", logoutHandler),
    // JWT management (Issue #77)
    route("POST", "/api/v1/auth/introspect", introspectHandler),
    route("POST", "/api/v1/auth/revoke", revokeHandler),
    route("GET", "/api/v1/auth/.well-known/jwks.json", jwksHandler),
    route("GET", "/.well-known/jwks.json", jwksHandler),
    route("GET", "/api/v1/auth/oauth/authorize", oauthAuthorizeHandler),
    route("POST", "/api/v1/auth/oauth/callback", oauthCallbackHandler),
    // Passkey / WebAuthn (#367)
    route("POST", "/api/v1/auth/passkeys/register/begin", beginRegistrationHandler),
    route("POST", "/api/v1/auth/passkeys/register/complete", completeRegistrationHandler),
    route("POST", "/api/v1/auth/passkeys/authenticate/begin", beginAuthenticationHandler),
    route("POST", "/api/v1/auth/passkeys/authenticate/complete", completeAuthenticationHandler),
    route("GET", "/api/v1/auth/passkeys", listPasskeysHandler),
    route("PATCH", "/api/v1/auth/passkeys/:credentialId", renamePasskeyHandler),
    route("DELETE", "/api/v1/auth/passkeys/:credentialId", deletePasskeyHandler),
    route("POST", "/api/v1/delegations", createDelegationHandler),
    route("GET", "/api/v1/delegations", listDelegationsHandler),
    route("GET", "/api/v1/delegations/:id", getDelegationHandler),
    route("PATCH", "/api/v1/delegations/:id", updateDelegationHandler),
    route("DELETE", "/api/v1/delegations/:id", revokeDelegationHandler),
    route("GET", "/api/v1/wallets/:walletId", getWalletHandler),
    // Payment method vault routes
    ...registerPaymentRoutes(),
    // Account recovery routes
    ...registerRecoveryRoutes(),
    // Multi-currency routes
    ...registerMultiCurrencyRoutes(),
    // Admin â€" rate-limit dashboard (#340)
    route("GET", "/api/v1/admin/rate-limit/metrics", rateLimitMetricsHandler),
    // Admin — tiered token-bucket rate-limit metrics (#51)
    route(
      "GET",
      "/api/v1/admin/rate-limit/tiered-metrics",
      tieredRateLimitMetricsHandler,
    ),
    // Admin — circuit breaker status (#364)
    route("GET", "/api/v1/admin/circuit-breakers", circuitBreakerStatusHandler),
    // Database query latency SLA metrics (#387)
    route("GET", "/api/v1/metrics/db/sla", dbSlaStatusHandler),
    route("GET", "/api/v1/metrics/db/slow-queries", dbSlowQueriesHandler),
    route("GET", "/api/v1/metrics/db/config", dbMetricsConfigHandler),
    route("GET", "/api/v1/metrics/db/prometheus", dbPrometheusMetricsHandler),
    // Request/response logging (#151)
    route("GET", "/api/v1/admin/logs", logSearchHandler),
    route("GET", "/api/v1/admin/logs/stats", logStatsHandler),
    route("DELETE", "/api/v1/admin/logs", logClearHandler),
    // Runtime application self-protection telemetry and simulation (#160)
    route("GET", "/api/v1/admin/rasp/metrics", raspMetricsHandler),
    route("GET", "/api/v1/admin/rasp/events", raspEventsHandler),
    route("POST", "/api/v1/admin/rasp/simulate", raspSimulationHandler),
    route(
      "POST",
      "/api/v1/admin/rasp/false-positive",
      raspFalsePositiveHandler,
    ),
    // API key scoping (#152)
    route("POST", "/api/v1/api-keys", createApiKeyHandler),
    route("GET", "/api/v1/api-keys", listApiKeysHandler),
    route("GET", "/api/v1/api-keys/:id", getApiKeyHandler),
    route("PATCH", "/api/v1/api-keys/:id/scopes", updateApiKeyScopesHandler),
    route("POST", "/api/v1/api-keys/:id/revoke", revokeApiKeyHandler),
    route("POST", "/api/v1/api-keys/:id/suspend", suspendApiKeyHandler),
    route("POST", "/api/v1/api-keys/:id/activate", activateApiKeyHandler),
    // Lua script management (#156)
    route("POST", "/api/v1/lua-scripts", registerScriptHandler),
    route("GET", "/api/v1/lua-scripts", listScriptsHandler),
    route("GET", "/api/v1/lua-scripts/:name", getScriptHandler),
    route("POST", "/api/v1/lua-scripts/:name/test", testScriptHandler),
    route("POST", "/api/v1/lua-scripts/:name/deploy", deployScriptHandler),
    route("POST", "/api/v1/lua-scripts/:name/rollback", rollbackScriptHandler),
    route("GET", "/api/v1/lua-scripts/:name/metrics", getScriptMetricsHandler),
    route("DELETE", "/api/v1/lua-scripts/:name", deleteScriptHandler),
    // Monitoring - Alert routing & on-call (#157)
    route("POST", "/api/v1/monitoring/schedules", createScheduleHandler),
    route("GET", "/api/v1/monitoring/schedules", listSchedulesHandler),
    route("GET", "/api/v1/monitoring/schedules/:id", getScheduleHandler),
    route("PATCH", "/api/v1/monitoring/schedules/:id", updateScheduleHandler),
    route("DELETE", "/api/v1/monitoring/schedules/:id", deleteScheduleHandler),
    route(
      "GET",
      "/api/v1/monitoring/schedules/:id/oncall",
      getCurrentOnCallHandler,
    ),
    route("POST", "/api/v1/monitoring/policies", createPolicyHandler),
    route("GET", "/api/v1/monitoring/policies", listPoliciesHandler),
    route("GET", "/api/v1/monitoring/policies/:id", getPolicyHandler),
    route("POST", "/api/v1/monitoring/routes", createRouteHandler),
    route("GET", "/api/v1/monitoring/routes", listRoutesHandler),
    route("POST", "/api/v1/monitoring/alerts", createAlertHandler),
    route("GET", "/api/v1/monitoring/alerts", listAlertsHandler),
    route(
      "POST",
      "/api/v1/monitoring/alerts/:id/acknowledge",
      acknowledgeAlertHandler,
    ),
    route("POST", "/api/v1/monitoring/alerts/:id/resolve", resolveAlertHandler),
    route("POST", "/api/v1/monitoring/channels", createChannelHandler),
    route("GET", "/api/v1/monitoring/channels", listChannelsHandler),
    route(
      "POST",
      "/api/v1/monitoring/notifications/send",
      sendNotificationHandler,
    ),
    route("GET", "/api/v1/monitoring/dashboard", monitoringDashboardHandler),
    // Admin — audit log query API (#66)
    route("GET", "/api/v1/admin/audit-log", auditLogQueryHandler),
    route("GET", "/api/v1/admin/audit-log/verify", auditLogVerifyHandler),
    // Emergency Kill-Switch Broadcast API (#375)
    route("POST", "/api/v1/admin/emergency/broadcast", emergencyBroadcastHandler),
    route("GET", "/api/v1/admin/emergency/status", emergencyStatusHandler),
    // Swagger UI (#352)
    route("GET", "/api/docs", swaggerHandler),
    route("GET", "/api/docs/openapi.json", swaggerHandler),
    // Semantic product search (#263)
    route("POST", "/api/v1/search/products", searchProductsHandler),
    // Embedding cache metrics (#389)
    route("GET", "/api/v1/search/embedding-cache/metrics", embeddingCacheMetricsHandler),
    // Issue #299 — Delivery Oracle Health Check & Heartbeat Monitor
    route("GET", "/health/oracle", oracleHealthHandler),
    // Workflow template system
    route("GET", "/api/v1/templates/catalog", catalogHandler),
    route("GET", "/api/v1/templates/categories", categoriesHandler),
    route("GET", "/api/v1/templates", listTemplatesHandler),
    route("POST", "/api/v1/templates", createTemplateHandler),
    route("GET", "/api/v1/templates/:id", getTemplateHandler),
    route("GET", "/api/v1/templates/:id/versions", listTemplateVersionsHandler),
    route("DELETE", "/api/v1/templates/:id", deleteTemplateHandler),
    route(
      "POST",
      "/api/v1/templates/:id/deprecate",
      deprecateTemplateVersionHandler,
    ),
    route(
      "POST",
      "/api/v1/templates/:id/instantiate",
      instantiateTemplateHandler,
    ),
    route("POST", "/api/v1/templates/:id/rate", rateTemplateHandler),
    route("POST", "/api/v1/templates/:id/test", testTemplateHandler),
    route("GET", "/api/v1/templates/:id/docs", templateDocumentationHandler),
    // Storefront - merchant product catalog (Issue #112)
    ...registerStorefrontRoutes(),
    // Merchant profile updates (#360)
    route(
      "PATCH",
      "/api/v1/merchants/:merchantId",
      updateMerchantProfileHandler,
    ),
    // Storage - pre-signed URLs for uploads (Issue #112)
    ...registerStorageRoutes(),
    // Disputes - merchant response endpoint (Issue #112)
    ...registerDisputeRoutes(),
    // Merchants - registration & store management
    ...registerMerchantRoutes(),
    // Catalog - product CRUD with cursor pagination
    ...registerCatalogRoutes(),
    // Product variants - variable products (sizes, colors, materials)
    ...registerVariantRoutes(),
    // Reviews with buyer verification
    ...registerReviewRoutes(),
    // Delivery evidence with IPFS/Arweave upload
    ...registerDeliveryEvidenceRoutes(),
    // Restock waitlist subscriptions
    ...registerWaitlistRoutes(),
    // Bulk CSV catalog import jobs
    ...registerBulkCatalogImportRoutes(),
    // Agent Chat - SSE streaming for agent conversations
    ...registerAgentChatRoutes(),
    // Courier webhooks - FedEx/DHL/UPS normalizer (Issue #577)
    ...registerWebhookRoutes(),
  ];
}
