/**
 * @delegolabs/cdc — entry point
 *
 * Change Data Capture service. Captures PostgreSQL row changes via logical
 * replication (or Debezium), transforms them into domain events, and publishes
 * them to the Redis bus with exactly-once delivery. Exposes a monitoring
 * dashboard (`/cdc/dashboard`) and metrics (`/metrics`, `/api/v1/cdc/metrics`).
 *
 * Issue #366 — Soroban RPC event listener with missed-ledger backfill is
 * started alongside the WAL pipeline when SOROBAN_RPC_URL and
 * SOROBAN_CONTRACT_IDS are configured.
 */

import { createLogger, startHttpServer } from "@delegolabs/utils";
import type { Pool } from "pg";
import { Redis } from "ioredis";

import { loadCdcRuntimeEnv } from "./config.js";
import { createCdcPool } from "./db.js";
import { createConnector } from "./connector/factory.js";
import {
  createCdcPublisher,
  type CdcPublisher,
  type MessageBroker,
} from "./publisher.js";
import { createRedisBroker } from "./broker.js";
import { createCdcPipeline, type CdcPipeline } from "./pipeline.js";
import { registerCdcRoutes } from "./routes.js";
import { createCdcMetrics } from "./metrics.js";
import {
  PostgresPublishedEventStore,
  PostgresReplicationStateStore,
  type ReplicationStateStore,
} from "./store.js";
import { PostgresSchemaEvolutionStore } from "./schemaEvolution.js";
import { InMemoryPublishedEventStore, InMemoryReplicationStateStore } from "./store.js";
import { InMemorySchemaEvolutionStore } from "./schemaEvolution.js";
import { createEscrowArchiver, startEscrowArchiveScheduler } from "./archiver/index.js";
import {
  InMemoryIngestionCheckpointStore,
  PostgresIngestionCheckpointStore,
  ResumableSorobanIngestionWorker,
  SorobanLedgerRpcClient,
  type LedgerEvent,
} from "./sorobanEvents/index.js";

/** Redis stream the Soroban events are fanned out to after commit. */
const SOROBAN_EVENT_STREAM = "soroban:events";

function optionalPositiveInt(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  return value;
}

const SERVICE_NAME = "cdc";
const log = createLogger(SERVICE_NAME, process.env.LOG_LEVEL ?? "info");

async function main(): Promise<void> {
  const env = loadCdcRuntimeEnv();
  if (!env.config) {
    log.error("CDC configuration is required");
    process.exit(1);
  }
  const config = env.config;
  log.info("Starting CDC service", {
    connector: config.connector,
    slot: config.slotName,
    publication: config.publication,
    port: env.port,
  });

  const pool: Pool = createCdcPool(env.databaseUrl ?? "");
  const metrics = createCdcMetrics(log);

  // Backing stores (Postgres in production, in-memory in test/local).
  const useMemory =
    process.env.NODE_ENV === "test" ||
    process.env.MOCK_PG === "true" ||
    process.env.CI === "true";
  const replicationState: ReplicationStateStore = useMemory
    ? new InMemoryReplicationStateStore()
    : new PostgresReplicationStateStore(pool);
  const publishedEvents = useMemory
    ? new InMemoryPublishedEventStore()
    : new PostgresPublishedEventStore(pool);
  const schemaEvolution = useMemory
    ? new InMemorySchemaEvolutionStore()
    : new PostgresSchemaEvolutionStore(pool);

  const broker: MessageBroker = createRedisBroker();
  const publisher: CdcPublisher = createCdcPublisher({
    slotName: config.slotName,
    broker,
    publishedEvents,
    replicationState,
    schemaEvolution,
    transformOptions: { topicPrefix: env.publishTopicPrefix ?? "cdc" },
  });

  const connector = createConnector({
    config,
    pool,
    debeziumSource: undefined,
  });

  let pipeline: CdcPipeline | undefined;
  try {
    pipeline = await createCdcPipeline({
      config,
      connector,
      publisher,
      replicationState,
      broker,
      metrics,
      pollIntervalMs: Number(process.env.CDC_POLL_INTERVAL_MS ?? 500),
      metricsIntervalMs: env.metricsIntervalMs,
    });
  } catch (err) {
    log.error("Failed to create pipeline", { error: err instanceof Error ? err.message : String(err) });
    await pool.end();
    process.exit(1);
  }

  const routes = registerCdcRoutes({
    config,
    metrics,
    getPositionLsn: () => pipeline?.position() ?? { latestLsn: "0/0", lagMs: 0 },
    onPause: () => pipeline?.pause() ?? Promise.resolve(),
    onResume: () => pipeline?.resume() ?? Promise.resolve(),
  });

  startHttpServer({
    port: env.port ?? 3017,
    serviceName: SERVICE_NAME,
    routes,
  });

  await pipeline.start();

  // ─── Escrow snapshot archiver (Issue #290) ───────────────────────────────
  // Nightly job that moves escrows settled longer than the retention window
  // (default 90 days) into `escrow_archives` and prunes them from the live
  // table. Disable with ESCROW_ARCHIVE_ENABLED=false.
  let stopEscrowArchiver: (() => void) | null = null;
  if (process.env.ESCROW_ARCHIVE_ENABLED !== "false") {
    stopEscrowArchiver = startEscrowArchiveScheduler(
      createEscrowArchiver(pool, process.env, log)
    );
  }

  // ---------------------------------------------------------------------------
  // Issue #366 — Soroban RPC event listener with missed-ledger backfill
  //
  // Started only when SOROBAN_RPC_URL and SOROBAN_CONTRACT_IDS are provided so
  // the CDC service stays backward-compatible for deployments that don't use
  // the Soroban event listener.
  // ---------------------------------------------------------------------------
  let sorobanWorker: ResumableSorobanIngestionWorker | undefined;

  const sorobanRpcUrl = process.env.SOROBAN_RPC_URL;
  const sorobanContractIds = process.env.SOROBAN_CONTRACT_IDS
    ? process.env.SOROBAN_CONTRACT_IDS.split(",").map((id) => id.trim()).filter(Boolean)
    : [];

  if (sorobanRpcUrl && sorobanContractIds.length > 0) {
    log.info("Starting Soroban event listener (Issue #366)", {
      rpcUrl: sorobanRpcUrl,
      contracts: sorobanContractIds,
    });

    const sorobanRedis = new Redis(env.redisUrl ?? "redis://localhost:6379");

    // Events, exactly-once claims and the ledger watermark commit together in
    // PostgreSQL; the Redis stream is an at-least-once fan-out after commit
    // (consumers dedupe on eventId).
    const publishToStream = async (_contractId: string, events: LedgerEvent[]): Promise<void> => {
      const pipeline = sorobanRedis.pipeline();
      for (const event of events) {
        pipeline.xadd(
          SOROBAN_EVENT_STREAM,
          "*",
          "eventId", event.eventId,
          "contractId", event.contractId,
          // `topic` keeps the field shape consumers of the legacy worker read.
          "topic", String(event.topics[0] ?? "unknown"),
          "topics", JSON.stringify(event.topics),
          "data", JSON.stringify(event.value),
          "ledger", String(event.ledger),
          "txHash", event.txHash,
          "timestamp", event.ledgerClosedAt
        );
      }
      await pipeline.exec();
    };

    sorobanWorker = new ResumableSorobanIngestionWorker(
      {
        rpc: new SorobanLedgerRpcClient(sorobanRpcUrl),
        store: useMemory
          ? new InMemoryIngestionCheckpointStore()
          : new PostgresIngestionCheckpointStore(pool),
        onCommitted: publishToStream,
        logger: log,
      },
      {
        contractIds: sorobanContractIds,
        initialLedger: optionalPositiveInt(process.env.SOROBAN_INITIAL_LEDGER, "SOROBAN_INITIAL_LEDGER"),
        windowSize: optionalPositiveInt(process.env.SOROBAN_LEDGER_WINDOW_SIZE, "SOROBAN_LEDGER_WINDOW_SIZE"),
        pageSize: optionalPositiveInt(process.env.SOROBAN_PAGE_SIZE, "SOROBAN_PAGE_SIZE"),
        pollIntervalMs: optionalPositiveInt(process.env.SOROBAN_POLL_INTERVAL_MS, "SOROBAN_POLL_INTERVAL_MS"),
      }
    );

    // start() reads soroban_event_sync_checkpoints, then resumes each contract
    // at lastProcessedLedger + 1.
    sorobanWorker.start().catch((err: unknown) => {
      log.error("Soroban event listener failed to start", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  } else {
    log.info(
      "Soroban event listener disabled — set SOROBAN_RPC_URL and SOROBAN_CONTRACT_IDS to enable"
    );
  }

  const shutdown = async (): Promise<void> => {
    log.info("Shutting down CDC pipeline");
    if (stopEscrowArchiver) {
      try {
        stopEscrowArchiver();
      } catch (err) {
        log.error("Error stopping escrow archiver", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    await sorobanWorker?.stop();
    await pipeline?.stop();
    await connector.close();
    await pool.end();
    process.exit(0);
  };

  process.on("SIGTERM", () => {
    void shutdown();
  });
  process.on("SIGINT", () => {
    void shutdown();
  });
}

main().catch((err) => {
  log.error("CDC service failed to start", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
