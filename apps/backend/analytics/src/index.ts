/**
 * @delegolabs/analytics — Entry point
 * Analytics service for notification delivery tracking, engagement metrics, and A/B testing.
 */
import { createLogger } from "@delegolabs/utils";
import { startHttpServer } from "@delegolabs/utils";
import { connectDb } from "./db.js";
import { registerAnalyticsRoutes } from "./routes/index.js";
import { sequelize } from "./db.js";
import { NotificationEvent } from "./models/NotificationEvent.js";
import { ABTest } from "./models/ABTest.js";
import { ABTestVariant } from "./models/ABTestVariant.js";
import { CohortAnalysis } from "./models/CohortAnalysis.js";
import { RevenueAttribution } from "./models/RevenueAttribution.js";
import { CustomEvent } from "./models/CustomEvent.js";
import { DataExportLog } from "./models/DataExportLog.js";
import { startSpendMetricsAggregator } from "./metrics/aggregator.js";

const SERVICE_NAME = "analytics";
const DEFAULT_PORT = 3012;

const nodeEnv = process.env.NODE_ENV ?? "development";
const logLevel = process.env.LOG_LEVEL ?? "info";
const log = createLogger(SERVICE_NAME, logLevel);
const port = Number(process.env.ANALYTICS_PORT ?? DEFAULT_PORT);

// Register models
NotificationEvent;
ABTest;
ABTestVariant;
CohortAnalysis;
RevenueAttribution;
CustomEvent;
DataExportLog;

log.info("Starting analytics service", { port, nodeEnv });

// Connect to database before starting server
let spendMetricsWorker: ReturnType<typeof startSpendMetricsAggregator> | undefined;
connectDb()
  .then(() => {
    log.info("Database connected, starting server");
    spendMetricsWorker = startSpendMetricsAggregator();
    startHttpServer({
      port,
      serviceName: SERVICE_NAME,
      routes: registerAnalyticsRoutes(),
    });
  })
  .catch((err) => {
    log.error("Failed to connect to database", err instanceof Error ? { error: err.message } : { error: String(err) });
    process.exit(1);
  });

// Graceful shutdown
async function shutdown(): Promise<void> {
  log.info("Shutting down gracefully");
  await spendMetricsWorker?.stop();
  await sequelize.close();
  process.exit(0);
}
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
