/**
 * @delegolabs/wallet — Entry point
 * TODO: Implement service logic
 */
import { createLogger, initTelemetry } from "@delegolabs/utils";
import { startHttpServer, corsMiddleware, securityHeadersMiddleware, requireAuth } from "@delegolabs/utils";
import {
  SorobanTransactionSimulator,
  readSorobanRpcConfig,
} from "./sorobanSimulator.js";

const SERVICE_NAME = "wallet";
const DEFAULT_PORT = 3012;

const nodeEnv = process.env.NODE_ENV ?? "development";
const logLevel = process.env.LOG_LEVEL ?? "info";
const log = createLogger(SERVICE_NAME, logLevel);

// Distributed tracing (Issue #307): enabled when OTEL_EXPORTER_OTLP_ENDPOINT is set.
void initTelemetry(SERVICE_NAME).catch((err: unknown) =>
  log.warn("Telemetry init failed", { error: err instanceof Error ? err.message : String(err) })
);
const port = Number(process.env.WALLET_PORT ?? DEFAULT_PORT);

import { ServiceMetricsRegistry } from "@delegolabs/utils";

export const metricsRegistry = new ServiceMetricsRegistry();
const sorobanConfig = readSorobanRpcConfig();
sorobanConfig.metricsRegistry = metricsRegistry;

log.info("Starting service", {
  port,
  nodeEnv,
  sorobanRpcTimeoutMs: sorobanConfig.timeoutMs,
  sorobanRpcMaxRetries: sorobanConfig.maxRetries,
});

export const sorobanSimulator = new SorobanTransactionSimulator(sorobanConfig);

import { registerRoutes } from "./routes.js";
import { startWebSocketServer, stopWebSocketServer } from "./websocket/server.js";
import { startBatchFlushTimers, stopBatchFlushTimers } from "./batching/batchQueue.js";
import { closeQueue } from "./queue/txQueue.js";
import { initSimulationCache } from "./simulationCache.js";
import { initDLQ } from "./queue/transactionDLQ.js";
import { getRedisConnection } from "./queue/txQueue.js";
import { balanceTracker } from "./assets/balances.js";
import { closePathQuoteService } from "./pathPayments/quoteProxy/routes.js";

const server = startHttpServer({
  port,
  serviceName: SERVICE_NAME,
  middleware: [
    corsMiddleware(),
    securityHeadersMiddleware(),
    requireAuth({ publicPaths: ["/health", "/vapid-public-key", "/transactions/submit"] }),
  ],
  routes: registerRoutes(),
});

// Issue #41: Start WebSocket server on port 3013
startWebSocketServer();

// Issue #42: Start background batch flush timers
startBatchFlushTimers();

// Issue #141: Initialize simulation cache
try {
  const redis = getRedisConnection();
  initSimulationCache(
    {
      maxEntries: parseInt(process.env.SIM_CACHE_MAX_ENTRIES ?? "1000"),
      ttlSeconds: parseInt(process.env.SIM_CACHE_TTL_SECONDS ?? "300"),
      sharedCacheEnabled: process.env.SIM_CACHE_SHARED !== "false",
    },
    redis
  );
  log.info("Simulation cache initialized");
} catch (err) {
  log.error("Failed to initialize simulation cache", { error: (err as Error).message });
}

// Issue #143 & #363: Initialize transaction DLQ and automated triage worker
let dlqTriageWorker: import("./queue/dlqTriageWorker.js").DlqTriageWorker | null = null;
try {
  const redis = getRedisConnection();
  initDLQ(redis);
  log.info("Transaction DLQ initialized");

  const { DlqTriageWorker } = await import("./queue/dlqTriageWorker.js");
  dlqTriageWorker = new DlqTriageWorker(redis);
  dlqTriageWorker.start();
  log.info("Automated DLQ triage worker started");
} catch (err) {
  log.error("Failed to initialize transaction DLQ or triage worker", { error: (err as Error).message });
}

// Issue #364: Initialize and start dynamic fee estimator periodic polling
let dynamicFeeEstimator: import("./feeEstimator/dynamicFeeEstimator.js").DynamicFeeEstimator | null = null;
try {
  const redis = getRedisConnection();
  const horizonUrl =
    process.env.STELLAR_NETWORK === "mainnet"
      ? (process.env.STELLAR_HORIZON_URL ?? "https://horizon.stellar.org")
      : (process.env.STELLAR_HORIZON_URL ?? "https://horizon-testnet.stellar.org");
  const { DynamicFeeEstimator } = await import("./feeEstimator/dynamicFeeEstimator.js");
  dynamicFeeEstimator = new DynamicFeeEstimator(redis, horizonUrl);
  dynamicFeeEstimator.start();
  log.info("Dynamic fee estimator started");
} catch (err) {
  log.error("Failed to start dynamic fee estimator", { error: (err as Error).message });
}

// SEP-1: daily re-verification of merchant domains (detects revoked listings)
let domainReverificationCron: import("./merchantDomain/index.js").CronHandle | null = null;
try {
  const { getDomainValidationService, redisDailyLock, startDomainReverificationCron } = await import(
    "./merchantDomain/index.js"
  );
  const domainService = getDomainValidationService();
  domainReverificationCron = startDomainReverificationCron({
    run: () => domainService.reverifyAll(),
    hourUtc: Number(process.env.MERCHANT_DOMAIN_REVERIFY_HOUR_UTC ?? 3),
    lock: redisDailyLock(getRedisConnection() as unknown as import("./merchantDomain/index.js").RedisSetNx),
  });
} catch (err) {
  log.error("Failed to start merchant domain re-verification cron", { error: (err as Error).message });
}

// ─── Graceful Shutdown ─────────────────────────────────────────────────────

async function gracefulShutdown(signal: NodeJS.Signals): Promise<void> {
  log.info("Received shutdown signal", { signal });

  // Stop accepting new connections
  server.close(() => {
    log.info("HTTP server closed");
  });

  // Stop DLQ triage worker
  try {
    dlqTriageWorker?.stop();
    log.info("DLQ triage worker stopped");
  } catch (err) {
    log.error("Error stopping DLQ triage worker", { error: (err as Error).message });
  }

  // Stop dynamic fee estimator polling
  try {
    if (dynamicFeeEstimator) {
      dynamicFeeEstimator.stop();
      log.info("Dynamic fee estimator stopped");
    }
  } catch (err) {
    log.error("Error stopping dynamic fee estimator", { error: (err as Error).message });
  }

  domainReverificationCron?.stop();
  closePathQuoteService();

  // Drain batch flush timers
  try {
    stopBatchFlushTimers();
    log.info("Batch flush timers stopped");
  } catch (err) {
    log.error("Error stopping batch flush timers", { error: (err as Error).message });
  }

  // Stop real-time balance trackers
  try {
    balanceTracker.stopAll();
    log.info("Balance trackers stopped");
  } catch (err) {
    log.error("Error stopping balance trackers", { error: (err as Error).message });
  }

  // Close WebSocket server
  try {
    await stopWebSocketServer();
    log.info("WebSocket server closed");
  } catch (err) {
    log.error("Error stopping WebSocket server", { error: (err as Error).message });
  }

  // Drain BullMQ queue and close Redis
  try {
    await closeQueue();
    log.info("Transaction queue closed");
  } catch (err) {
    log.error("Error closing transaction queue", { error: (err as Error).message });
  }

  process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void gracefulShutdown(signal);
  });
}

// Issue #527 — Stellar Horizon/Soroban RPC failover switcher
export {
  RpcNodePool,
  chooseBestHealthyNode,
  latencyToWeight,
  readRpcPoolConfig,
} from "./rpcFailover.js";
export type {
  RpcNodeHealth,
  RpcNodePoolOptions,
  FailoverEvent,
} from "./rpcFailover.js";

// Export DLQ triage worker components for external use
export { DlqTriageWorker } from "./queue/dlqTriageWorker.js";
export { DlqSlackAlerter } from "./queue/dlqSlackAlerter.js";
export { classifyErrorAndDecide, calculateExponentialBackoff } from "./queue/dlqClassificationEngine.js";

// Export Stellar trustline pre-flight utilities (Issue #594)
export * from "./stellar/trustlines.js";

