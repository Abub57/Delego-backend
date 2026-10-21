import { Sequelize } from "sequelize";
import { createLogger } from "@delegolabs/utils";
import { ServiceMetricsRegistry } from "@delegolabs/utils";
import {
  configureDbMetrics,
  instrumentSequelize,
  getSlaStatus,
  recordQueryDuration,
  type DbMetricsConfig,
} from "./metrics/dbMetrics.js";

const log = createLogger("gateway:db", process.env.LOG_LEVEL ?? "info");

const databaseUrl = process.env.DATABASE_URL ?? "postgresql://delego:delego@localhost:5432/delego";

export const sequelize = new Sequelize(databaseUrl, {
  dialect: "postgres",
  logging: (msg) => log.debug(msg),
  pool: {
    min: Number(process.env.DATABASE_POOL_MIN ?? 2),
    max: Number(process.env.DATABASE_POOL_MAX ?? 10),
    acquire: 30000,
    idle: 10000,
  },
  define: {
    underscored: true,
    timestamps: true,
  },
});

let metricsRegistry: ServiceMetricsRegistry | null = null;

export function initializeDbMetrics(registry?: ServiceMetricsRegistry): void {
  const config: Partial<DbMetricsConfig> = {
    slowQueryThresholdMs: Number(process.env["DB_SLOW_QUERY_THRESHOLD_MS"] ?? 100),
    enableSlowQueryLogging: process.env["DB_SLOW_QUERY_LOGGING"] !== "false",
  };

  if (process.env["DB_HISTOGRAM_BUCKETS"]) {
    config.histogramBuckets = process.env["DB_HISTOGRAM_BUCKETS"]
      .split(",")
      .map((b) => Number(b.trim()));
  }

  metricsRegistry = registry ?? null;
  configureDbMetrics(config, metricsRegistry ?? undefined);
  instrumentSequelize(sequelize);

  log.info("Database metrics initialized", config);
}

export async function connectDb(): Promise<void> {
  try {
    await sequelize.authenticate();
    log.info("Database connection established successfully.");
  } catch (err) {
    log.error("Unable to connect to the database", err instanceof Error ? { error: err.message } : { error: String(err) });
    throw err;
  }
}

/**
 * Check PostgreSQL connectivity with a lightweight query.
 * Returns the query latency in milliseconds or throws on failure.
 * @param timeoutMs - Query timeout in milliseconds (default: 5000)
 */
export async function checkDatabaseHealth(timeoutMs: number = 5000): Promise<number> {
  const startTime = performance.now();
  let timeoutId: NodeJS.Timeout | null = null;
  
  try {
    const queryPromise = sequelize.query("SELECT 1", { raw: true });
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error("Database health check timeout")), timeoutMs);
    });
    
    await Promise.race([queryPromise, timeoutPromise]);
    const endTime = performance.now();
    const durationMs = endTime - startTime;
    recordQueryDuration("health_check", durationMs, { type: "health" });
    return durationMs;
  } catch (err) {
    log.warn("Database health check failed", err instanceof Error ? { error: err.message } : { error: String(err) });
    throw err;
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

export { getSlaStatus, recordQueryDuration, configureDbMetrics };
export type { DbMetricsConfig, QuerySlaMetric, SlaStatus } from "./metrics/dbMetrics.js";

