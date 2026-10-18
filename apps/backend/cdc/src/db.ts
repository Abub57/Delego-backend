/**
 * CDC Postgres pool.
 *
 * The CDC service needs a dedicated `pg.Pool` to run slot/publication management
 * and the state/dedup queries. We use the raw `pg` driver (rather than Sequelize)
 * because the logical replication connector operates at the SQL/WAL layer.
 */

import { Pool } from "pg";
import { createLogger, type Logger } from "@delegolabs/utils";

let log: Logger | null = null;
function getLog(): Logger {
  if (!log) log = createLogger("cdc:db", process.env.LOG_LEVEL ?? "info");
  return log;
}

/**
 * Pool-sizing knobs for the CDC service's Postgres pool (Issue #335).
 * Mirrors the `pg.Pool` options we actually enforce, plus `maxWaitingClients`
 * — a soft cap `pg.Pool` has no native equivalent for, enforced ourselves via
 * {@link isPoolSaturated} so a bulk ledger-sync spike fails fast with a clear
 * backpressure error instead of queuing unboundedly against the DB's
 * connection limit.
 */
export interface TenantPoolConfig {
  maxConnections: number;
  idleTimeoutMillis: number;
  connectionTimeoutMillis: number;
  maxWaitingClients: number;
}

/** Live snapshot of pool saturation, same shape as `pg.Pool`'s own counters. */
export interface PoolHealthMetrics {
  totalCount: number;
  idleCount: number;
  waitingCount: number;
}

export const DEFAULT_CDC_POOL_CONFIG: TenantPoolConfig = {
  maxConnections: Number(process.env.CDC_DB_POOL_MAX ?? 5),
  idleTimeoutMillis: Number(process.env.CDC_DB_POOL_IDLE_TIMEOUT_MS ?? 10000),
  connectionTimeoutMillis: Number(process.env.CDC_DB_POOL_CONNECTION_TIMEOUT_MS ?? 10000),
  maxWaitingClients: Number(process.env.CDC_DB_POOL_MAX_WAITING ?? 20),
};

const poolConfigs = new WeakMap<Pool, TenantPoolConfig>();

/** Creates the Postgres pool used by the CDC connector + stores. */
export function createCdcPool(databaseUrl: string, overrides: Partial<TenantPoolConfig> = {}): Pool {
  const config: TenantPoolConfig = { ...DEFAULT_CDC_POOL_CONFIG, ...overrides };
  const pool = new Pool({
    connectionString: databaseUrl,
    max: config.maxConnections,
    min: Number(process.env.CDC_DB_POOL_MIN ?? 1),
    idleTimeoutMillis: config.idleTimeoutMillis,
    connectionTimeoutMillis: config.connectionTimeoutMillis,
  });
  poolConfigs.set(pool, config);
  return pool;
}

/** Reads the current saturation of a CDC pool (bounded connections + queued acquires). */
export function getPoolHealthMetrics(pool: Pool): PoolHealthMetrics {
  return {
    totalCount: pool.totalCount,
    idleCount: pool.idleCount,
    waitingCount: pool.waitingCount,
  };
}

/** True once the pool is at its connection ceiling or its waiting-client soft cap. */
export function isPoolSaturated(pool: Pool, config: TenantPoolConfig = poolConfigs.get(pool) ?? DEFAULT_CDC_POOL_CONFIG): boolean {
  const health = getPoolHealthMetrics(pool);
  if (health.waitingCount >= config.maxWaitingClients) return true;
  return health.totalCount >= config.maxConnections && health.idleCount === 0;
}

/**
 * Backpressure gate for bulk ingestion (Issue #335). Callers about to issue a
 * burst of queries (e.g. a CDC backfill page) should await this first so a
 * ledger-sync spike throttles itself against pool saturation metrics instead
 * of piling up unpooled/queued acquisitions that starve the rest of the
 * service. Uses exponential backoff and gives up with a descriptive
 * "connection acquisition timeout" error rather than hanging forever.
 */
export async function waitForPoolCapacity(
  pool: Pool,
  options: { config?: TenantPoolConfig; maxWaitMs?: number; log?: Logger } = {}
): Promise<void> {
  const config = options.config ?? poolConfigs.get(pool) ?? DEFAULT_CDC_POOL_CONFIG;
  const maxWaitMs = options.maxWaitMs ?? config.connectionTimeoutMillis * 3;
  const logger = options.log ?? getLog();
  const startedAt = Date.now();
  let delayMs = 50;
  let attempt = 0;

  while (isPoolSaturated(pool, config)) {
    attempt++;
    if (Date.now() - startedAt >= maxWaitMs) {
      throw new Error(
        `Connection acquisition timeout: CDC pool saturated for ${maxWaitMs}ms (${JSON.stringify(
          getPoolHealthMetrics(pool)
        )})`
      );
    }
    logger.warn("CDC pool saturated, throttling bulk ingestion batch", {
      attempt,
      ...getPoolHealthMetrics(pool),
      maxConnections: config.maxConnections,
      maxWaitingClients: config.maxWaitingClients,
    });
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    delayMs = Math.min(delayMs * 2, 2000);
  }
}

/**
 * Ensures the CDC tables exist. Normally the schema is created by the
 * `database/migrations/029_cdc.sql` migration, but this acts as a belt-and-braces
 * bootstrap for local dev / tests against a fresh database.
 */
export async function ensureCdcSchema(pool: Pool): Promise<void> {
  const logger = getLog();
  logger.info("Ensuring CDC schema exists");
  await pool.query(`
    -- Issue #366 — Soroban event sync checkpoints (see migration 040)
    CREATE TABLE IF NOT EXISTS soroban_event_sync_checkpoints (
      contract_id VARCHAR(255) PRIMARY KEY,
      last_ledger_sequence INTEGER NOT NULL DEFAULT 0,
      last_event_id VARCHAR(255) NOT NULL DEFAULT '',
      synced_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS soroban_processed_events (
      event_id VARCHAR(255) PRIMARY KEY,
      contract_id VARCHAR(255) NOT NULL,
      ledger_sequence INTEGER NOT NULL,
      published_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS cdc_replication_state (
      slot_name VARCHAR(255) PRIMARY KEY,
      confirmed_flush_lsn TEXT NOT NULL DEFAULT '0/0',
      last_restart_lsn TEXT,
      last_processed_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS cdc_published_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      slot_name VARCHAR(255) NOT NULL,
      lsn TEXT NOT NULL,
      seq INTEGER NOT NULL DEFAULT 0,
      event_id VARCHAR(255) NOT NULL,
      op VARCHAR(16) NOT NULL,
      schema_name VARCHAR(255) NOT NULL,
      table_name VARCHAR(255) NOT NULL,
      payload JSONB NOT NULL,
      published_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (slot_name, lsn, seq)
    );
    CREATE TABLE IF NOT EXISTS cdc_schema_versions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      schema_name VARCHAR(255) NOT NULL,
      table_name VARCHAR(255) NOT NULL,
      version INTEGER NOT NULL,
      columns JSONB NOT NULL DEFAULT '{}',
      detected_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (schema_name, table_name, version)
    );
    CREATE TABLE IF NOT EXISTS cdc_metric_snapshots (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      slot_name VARCHAR(255) NOT NULL,
      events_processed BIGINT NOT NULL DEFAULT 0,
      lag_ms BIGINT NOT NULL DEFAULT 0,
      status VARCHAR(16) NOT NULL,
      errors JSONB NOT NULL DEFAULT '[]',
      snapshot_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );
  `);
  logger.info("CDC schema ensured");
}
