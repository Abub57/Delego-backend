import { Sequelize, Transaction } from "sequelize";
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

export interface DatabaseClusterConfig {
  primaryUrl: string;
  readReplicaUrls: string[];
  maxConnectionsPerReplica: number;
}

export type QueryRoutingTarget = "primary" | "replica";

export interface QueryRoutingContext {
  /** Force the query to run on the primary (e.g. read-your-own-writes). */
  primary?: boolean;
  /** The currently active transaction, if any. */
  transaction?: Transaction | null;
}

function parseReplicaUrls(): string[] {
  const raw = process.env.DATABASE_READ_REPLICA_URLS;
  if (!raw) return [];
  return raw
    .split(",")
    .map((u) => u.trim())
    .filter((u) => u.length > 0);
}

export const databaseClusterConfig: DatabaseClusterConfig = {
  primaryUrl: databaseUrl,
  readReplicaUrls: parseReplicaUrls(),
  maxConnectionsPerReplica: Number(process.env.DATABASE_REPLICA_POOL_MAX ?? process.env.DATABASE_POOL_MAX ?? 10),
};

function buildPoolOverrides(max?: number) {
  return {
    min: Number(process.env.DATABASE_POOL_MIN ?? 2),
    max: max ?? Number(process.env.DATABASE_POOL_MAX ?? 10),
    acquire: 30000,
    idle: 10000,
  };
}

const baseSequelizeOptions = {
  dialect: "postgres" as const,
  logging: (msg: string) => log.debug(msg),
  define: {
    underscored: true,
    timestamps: true,
  },
};

export const sequelize = new Sequelize(databaseClusterConfig.primaryUrl, {
  ...baseSequelizeOptions,
  pool: buildPoolOverrides(),
});

/**
 * Read-replica connection pools. One Sequelize instance per replica so that
 * connection limits and health are isolated per node.
 */
export const readingReplicas: Sequelize[] = databaseClusterConfig.readReplicaUrls.map(
  (url) =>
    new Sequelize(url, {
      ...baseSequelizeOptions,
      pool: buildPoolOverrides(databaseClusterConfig.maxConnectionsPerReplica),
    }),
);

const replicaUnavailableUntil: number[] = readingReplicas.map(() => 0);
const REPLICA_RETRY_COOLDOWN_MS = Number(process.env.DATABASE_REPLICA_RETRY_COOLDOWN_MS ?? 30000);

function now(): number {
  return Date.now();
}

function availableReplicaIndices(): number[] {
  const time = now();
  const indices: number[] = [];
  for (let i = 0; i < readingReplicas.length; i++) {
    if (replicaUnavailableUntil[i] <= time) indices.push(i);
  }
  return indices;
}

const roundRobinCounter = { value: 0 };

/**
 * Pick a healthy read replica using round-robin distribution.
 * Returns null when no replica is configured or available.
 */
export function pickReadReplica(): Sequelize | null {
  const available = availableReplicaIndices();
  if (available.length === 0) return null;
  const idx = available[roundRobinCounter.value % available.length];
  roundRobinCounter.value = (roundRobinCounter.value + 1) >>> 0;
  return readingReplicas[idx];
}

export function markReplicaUnavailable(replica: Sequelize): void {
  const idx = readingReplicas.indexOf(replica);
  if (idx >= 0) {
    replicaUnavailableUntil[idx] = now() + REPLICA_RETRY_COOLDOWN_MS;
    log.warn("Marked read replica unavailable", { replicaIndex: idx });
  }
}

export function markReplicaAvailable(replica: Sequelize): void {
  const idx = readingReplicas.indexOf(replica);
  if (idx >= 0) replicaUnavailableUntil[idx] = 0;
}

/**
 * Resolve the Sequelize instance to use for a query.
 * - Transactions and explicit primary requests always pin to primary.
 * - Plain reads go to a healthy replica when available.
 * - Falls back to primary when no replica is available.
 */
export function resolveQueryTarget(context?: QueryRoutingContext): {
  sequelize: Sequelize;
  target: QueryRoutingTarget;
} {
  if (context?.primary || context?.transaction) {
    return { sequelize, target: "primary" };
  }
  const replica = pickReadReplica();
  if (replica) return { sequelize: replica, target: "replica" };
  return { sequelize, target: "primary" };
}

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
  for (const replica of readingReplicas) {
    instrumentSequelize(replica);
  }

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

  await Promise.all(
    readingReplicas.map(async (replica, idx) => {
      try {
        await replica.authenticate();
        markReplicaAvailable(replica);
        log.info("Read replica connection established", { replicaIndex: idx });
      } catch (err) {
        markReplicaUnavailable(replica);
        log.warn("Read replica unavailable at startup; falling back to primary", {
          replicaIndex: idx,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }),
  );
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
