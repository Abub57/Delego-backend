/**
 * @delegolabs/db-vacuum — Automated database vacuum and bloat monitoring.
 * Issue #382.
 *
 * Responsibilities:
 *   - Scan pg_stat_user_tables / pg_stat_user_indexes for bloat on high-churn tables
 *   - Classify each table against configurable dead-tuple thresholds
 *   - Raise deduplicated alerts when dead tuples exceed the threshold
 *   - Trigger a non-blocking VACUUM ANALYZE (never VACUUM FULL)
 *   - Expose monitoring metrics and a per-run audit trail
 *
 * Runs standalone against DATABASE_URL. When no database is configured the
 * service boots with the recording executor and a dry run, so the health and
 * metrics endpoints stay available.
 */
import { createLogger, createHealthRoutes, startHttpServer, HealthRegistry } from "@delegolabs/utils";
import { Pool } from "pg";
import { DEFAULT_THRESHOLDS } from "./bloat/assessment.js";
import { DeduplicatingAlertRouter, LoggingAlertSink } from "./alerts/alertSink.js";
import { PgBloatScanner, DatabaseVacuumService } from "./service.js";
import { PgVacuumExecutor, RecordingVacuumExecutor } from "./vacuum/executor.js";
import { InMemoryVacuumHistoryStore, PostgresVacuumHistoryStore } from "./store/vacuumHistoryStore.js";
import { VacuumScheduler } from "./worker/scheduler.js";
import { registerRoutes } from "./routes/index.js";

const SERVICE_NAME = "db-vacuum";
const VERSION = "0.0.1";
const DEFAULT_PORT = 3022;

const nodeEnv = process.env.NODE_ENV ?? "development";
const logLevel = process.env.LOG_LEVEL ?? "info";
const port = Number(process.env.DB_VACUUM_PORT ?? DEFAULT_PORT);
const log = createLogger(SERVICE_NAME, logLevel);

const connectionString = process.env.DATABASE_URL ?? "";
// A pg Pool satisfies both the read-side `Queryable` and the executor's
// `VacuumPool` (connect -> client with query/release) structurally.
const pool = connectionString ? new Pool({ connectionString }) : null;

// Without a database the worker cannot read bloat stats, so it starts in dry
// run with the in-memory executor. Health stays green; metrics stay empty.
const dryRun = pool === null || process.env.DB_VACUUM_DRY_RUN === "true";

const alertRouter = new DeduplicatingAlertRouter(new LoggingAlertSink(log), {
  service: SERVICE_NAME,
  cooldownMs: Number(process.env.DB_VACUUM_ALERT_COOLDOWN_MS ?? 60 * 60 * 1000),
});

const executor = pool
  ? new PgVacuumExecutor(pool, Number(process.env.DB_VACUUM_STATEMENT_TIMEOUT_MS ?? 60_000))
  : new RecordingVacuumExecutor();

const service = new DatabaseVacuumService({
  scanner: pool
    ? new PgBloatScanner(pool, {
        minTableSizeBytes: Number(
          process.env.DB_VACUUM_MIN_TABLE_SIZE_BYTES ?? DEFAULT_THRESHOLDS.minTableSizeBytes,
        ),
      })
    : { scan: async () => [] },
  executor,
  alertRouter,
  history: pool ? new PostgresVacuumHistoryStore(pool) : new InMemoryVacuumHistoryStore(),
  thresholds: {
    deadTupleRatio: Number(process.env.DB_VACUUM_DEAD_TUPLE_RATIO ?? DEFAULT_THRESHOLDS.deadTupleRatio),
    deadTupleCount: Number(process.env.DB_VACUUM_DEAD_TUPLE_COUNT ?? DEFAULT_THRESHOLDS.deadTupleCount),
    minTableSizeBytes: Number(process.env.DB_VACUUM_MIN_TABLE_SIZE_BYTES ?? DEFAULT_THRESHOLDS.minTableSizeBytes),
  },
  dryRun,
  maxTablesPerRun: Number(process.env.DB_VACUUM_MAX_TABLES_PER_RUN ?? 5),
  skipAutovacuumDisabled: process.env.DB_VACUUM_SKIP_AUTOVACUUM_DISABLED !== "false",
  skipIfVacuumRunning: process.env.DB_VACUUM_SKIP_IF_RUNNING !== "false",
  serviceName: SERVICE_NAME,
  log,
});

const scheduler = new VacuumScheduler(service, {
  intervalMs: Number(process.env.DB_VACUUM_INTERVAL_MS ?? 15 * 60 * 1000),
  onError: (err) => log.error("vacuum tick failed", { error: (err as Error).message }),
  onRun: (summary) =>
    log.info("vacuum run finished", {
      runId: summary.runId,
      scanned: summary.tablesScanned,
      overThreshold: summary.tablesOverThreshold,
      vacuumed: summary.vacuumed.length,
      failed: summary.failed.length,
      dryRun: summary.dryRun,
    }),
});

const healthRegistry = new HealthRegistry();
healthRegistry.register(
  "database",
  async () => {
    if (!pool) return { status: "degraded", details: { reason: "no DATABASE_URL configured" } };
    await pool.query("SELECT 1");
    return { status: "healthy" };
  },
  { type: "database", critical: true },
);
const health = createHealthRoutes({
  registry: healthRegistry,
  serviceName: SERVICE_NAME,
  version: VERSION,
});

log.info("Starting db-vacuum", { port, nodeEnv, dryRun, hasDatabase: pool !== null });

startHttpServer({
  port,
  serviceName: SERVICE_NAME,
  version: VERSION,
  routes: [...health, ...registerRoutes(service)],
});

if (process.env.DB_VACUUM_ENABLED !== "false") {
  scheduler.start();
}

async function shutdown(signal: string): Promise<void> {
  log.info("Shutting down", { signal });
  scheduler.stop();
  await pool?.end().catch(() => undefined);
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

export { service, scheduler, pool };
