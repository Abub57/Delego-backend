/**
 * Real-Time Soroban RPC Event Listener with Missed-Ledger Backfill (Issue #366)
 *
 * Extends the original continuous poller (#285) with three capabilities required
 * by issue #366:
 *
 *   1. DURABLE CHECKPOINTS — Every successful ingestion batch advances a row in
 *      `soroban_event_sync_checkpoints` (PostgreSQL).  On service startup the worker
 *      reads that row to discover the last successfully processed ledger sequence.
 *      Unlike the Redis CursorStore (still maintained for real-time cursor tracking),
 *      the PostgreSQL checkpoint survives Redis flushes, TTL evictions, and pod
 *      restarts — closing the missed-event window the issue describes.
 *
 *   2. MISSED-LEDGER BACKFILL — On startup, after loading the durable checkpoint,
 *      the worker calls `getEvents` with `startLedger = lastLedgerSequence` and
 *      pages through the full range up to the current ledger before switching to
 *      normal real-time polling.  This fills the gap created by any downtime.
 *
 *   3. DEDUPLICATION — Before writing each event to the Redis Stream the worker
 *      checks `ProcessedEventStore` (backed by `soroban_processed_events` in
 *      PostgreSQL).  Events already present are silently skipped, preventing
 *      double-processing during backfill or at-least-once RPC re-delivery.
 *
 * The Redis CursorStore (from #285) is kept as a fast secondary cursor that
 * avoids an extra Postgres read on every normal poll cycle.  On startup, if the
 * PostgreSQL checkpoint is newer/higher than the Redis cursor, the PostgreSQL
 * value takes precedence and the Redis cursor is refreshed to match.
 *
 * Closes #285, Closes #366
 */

import { Redis } from "ioredis";
import { createLogger, type Logger } from "@delegolabs/utils";
import type { Pool } from "pg";
import {
  type CheckpointStore,
  type EventSyncCheckpoint,
  type ProcessedEventStore,
  InMemoryCheckpointStore,
  InMemoryProcessedEventStore,
  PostgresCheckpointStore,
  PostgresProcessedEventStore,
} from "./checkpointStore.js";
import { waitForPoolCapacity } from "../db.js";

// ---------------------------------------------------------------------------
// Types (matching issue spec)
// ---------------------------------------------------------------------------

export interface ContractEventCursor {
  contractId: string;
  lastLedgerSequence: number;
  cursorToken?: string;
}

export interface NormalizedContractEvent {
  contractId: string;
  topic: string;
  data: Record<string, unknown>;
  ledger: number;
  txHash: string;
  timestamp: string;
  /** Soroban RPC-assigned event id — used as the dedup key. */
  eventId: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CURSOR_KEY_PREFIX = "soroban:cursor:";
const STREAM_KEY = "soroban:events";
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_PAGE_SIZE = 50;
const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_BACKOFF_MS = 2_000;

// ---------------------------------------------------------------------------
// Soroban RPC Client
// ---------------------------------------------------------------------------

export interface SorobanRpcConfig {
  rpcUrl: string;
  contractIds: string[];
  pollIntervalMs?: number;
  pageSize?: number;
}

export class SorobanRpcClient {
  private rpcUrl: string;

  constructor(rpcUrl: string) {
    this.rpcUrl = rpcUrl;
  }

  /**
   * Call Soroban RPC getEvents with paging.
   */
  async getEvents(params: {
    startLedger?: number;
    cursor?: string;
    limit?: number;
    filters?: Array<{ type?: string; contractIds?: string[]; topics?: string[][] }>;
  }): Promise<{
    events: RawSorobanEvent[];
    cursor: string;
    latestLedger: number;
  }> {
    const body = {
      jsonrpc: "2.0",
      id: 1,
      method: "getEvents",
      params: {
        startLedger: params.startLedger,
        cursor: params.cursor,
        limit: params.limit ?? DEFAULT_PAGE_SIZE,
        filters: params.filters ?? [],
      },
    };

    const response = await fetch(this.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`Soroban RPC error: ${response.status} ${await response.text()}`);
    }

    const result = (await response.json()) as {
      error?: { message?: string };
      result?: {
        events?: RawSorobanEvent[];
        cursor?: string;
        latestLedger?: number;
      };
    };

    if (result.error) {
      throw new Error(
        `Soroban RPC error: ${result.error.message ?? JSON.stringify(result.error)}`
      );
    }

    return {
      events: (result.result?.events ?? []) as RawSorobanEvent[],
      cursor: result.result?.cursor ?? params.cursor ?? "",
      latestLedger: result.result?.latestLedger ?? 0,
    };
  }
}

export interface RawSorobanEvent {
  type: string;
  ledger: number;
  ledgerClosedAt: string;
  contractId: string;
  /** Soroban RPC-assigned unique event identifier. */
  id: string;
  pagingToken: string;
  topic: string[];
  value: { xdr?: string; str?: string };
  inSuccessfulContractCall: boolean;
  txHash: string;
}

// ---------------------------------------------------------------------------
// CursorStore (Redis — fast, secondary, at-least-once)
// ---------------------------------------------------------------------------

export class CursorStore {
  private redis: Redis;
  private log: Logger;

  constructor(redis: Redis, logger?: Logger) {
    this.redis = redis;
    this.log = logger ?? createLogger("cdc:cursorStore", process.env.LOG_LEVEL ?? "info");
  }

  /** Persist the latest cursor so normal polls resume quickly. */
  async saveCursor(cursor: ContractEventCursor): Promise<void> {
    const key = `${CURSOR_KEY_PREFIX}${cursor.contractId}`;
    await this.redis.hset(key, {
      lastLedgerSequence: String(cursor.lastLedgerSequence),
      cursorToken: cursor.cursorToken ?? "",
      updatedAt: new Date().toISOString(),
    });
    this.log.debug("Cursor saved", cursor as unknown as Record<string, unknown>);
  }

  /** Load the Redis cursor.  May return null after a Redis flush. */
  async loadCursor(contractId: string): Promise<ContractEventCursor | null> {
    const key = `${CURSOR_KEY_PREFIX}${contractId}`;
    const data = await this.redis.hgetall(key);

    if (!data || !data.lastLedgerSequence) {
      return null;
    }

    return {
      contractId,
      lastLedgerSequence: Number(data.lastLedgerSequence),
      cursorToken: data.cursorToken || undefined,
    };
  }

  /** Clear cursor (used in tests or manual reset). */
  async clearCursor(contractId: string): Promise<void> {
    await this.redis.del(`${CURSOR_KEY_PREFIX}${contractId}`);
  }
}

// ---------------------------------------------------------------------------
// Event Normalizer
// ---------------------------------------------------------------------------

export function normalizeEvent(raw: RawSorobanEvent): NormalizedContractEvent {
  const topic =
    raw.topic.length > 0 ? raw.topic[0].replace(/"/g, "") : "unknown";

  let data: Record<string, unknown> = {};
  if (raw.value?.xdr) {
    data = { xdr: raw.value.xdr };
  } else if (raw.value?.str) {
    try {
      data = JSON.parse(raw.value.str) as Record<string, unknown>;
    } catch {
      data = { raw: raw.value.str };
    }
  }

  return {
    contractId: raw.contractId,
    topic,
    data,
    ledger: raw.ledger,
    txHash: raw.txHash,
    timestamp: raw.ledgerClosedAt,
    eventId: raw.id,
  };
}

// ---------------------------------------------------------------------------
// Ingestion Worker
// ---------------------------------------------------------------------------

export interface SorobanIngestionWorkerOptions {
  rpcClient?: SorobanRpcClient;
  cursorStore?: CursorStore;
  /** PostgreSQL-backed checkpoint store. Defaults to InMemoryCheckpointStore. */
  checkpointStore?: CheckpointStore;
  /** PostgreSQL-backed processed-event dedup store. Defaults to InMemoryProcessedEventStore. */
  processedEventStore?: ProcessedEventStore;
  /**
   * The CDC Postgres pool backing the stores above. When set, the worker
   * throttles itself against {@link waitForPoolCapacity} before each bulk
   * page (Issue #335) instead of hammering a saturated pool during a ledger
   * sync spike.
   */
  pgPool?: Pool;
  logger?: Logger;
}

export class SorobanEventIngestionWorker {
  private rpcClient: SorobanRpcClient;
  private cursorStore: CursorStore;
  private checkpointStore: CheckpointStore;
  private processedEventStore: ProcessedEventStore;
  private redis: Redis;
  private config: SorobanRpcConfig;
  private log: Logger;
  private running: boolean = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private pgPool?: Pool;

  constructor(
    redis: Redis,
    config: SorobanRpcConfig,
    options?: SorobanIngestionWorkerOptions
  ) {
    this.redis = redis;
    this.config = config;
    this.rpcClient = options?.rpcClient ?? new SorobanRpcClient(config.rpcUrl);
    this.cursorStore = options?.cursorStore ?? new CursorStore(redis);
    this.checkpointStore =
      options?.checkpointStore ?? new InMemoryCheckpointStore();
    this.processedEventStore =
      options?.processedEventStore ?? new InMemoryProcessedEventStore();
    this.pgPool = options?.pgPool;
    this.log =
      options?.logger ??
      createLogger("cdc:sorobanEvents", process.env.LOG_LEVEL ?? "info");
  }

  /**
   * Backpressure gate (Issue #335). Called before every bulk page — both the
   * startup backfill and each real-time poll — so a ledger-sync spike waits
   * out pool saturation (exponential backoff) instead of piling up query
   * attempts that starve the rest of the service's connection budget. A
   * no-op when the worker was built without a `pgPool` (tests / local dev
   * with in-memory stores).
   */
  private async throttleForPoolCapacity(): Promise<void> {
    if (!this.pgPool) return;
    await waitForPoolCapacity(this.pgPool, { log: this.log });
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Start the worker.
   *
   * On startup the worker:
   *   1. Reads the durable PostgreSQL checkpoint for each contract.
   *   2. Runs a backfill from `lastLedgerSequence` to the current ledger to
   *      recover any events missed during downtime.
   *   3. Enters the normal real-time polling loop.
   */
  async start(): Promise<void> {
    if (this.running) {
      this.log.warn("Ingestion worker already running");
      return;
    }
    this.running = true;
    this.log.info("Soroban event ingestion starting", {
      rpcUrl: this.config.rpcUrl,
      contracts: this.config.contractIds,
      pollIntervalMs: this.config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    });

    // Backfill missed ledgers before entering the live-polling loop.
    try {
      await this.backfillAll();
    } catch (err) {
      this.log.error("Startup backfill failed — continuing to live polling", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    this.poll();
  }

  /**
   * Stop the worker gracefully.
   */
  stop(): void {
    this.running = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.log.info("Soroban event ingestion stopped");
  }

  // -------------------------------------------------------------------------
  // Startup backfill (Issue #366 — core requirement)
  // -------------------------------------------------------------------------

  /**
   * For every configured contract, load the durable PostgreSQL checkpoint and
   * page through all events from `lastLedgerSequence` (exclusive) to the current
   * ledger.  Events that were already published (present in `processedEventStore`)
   * are skipped to prevent double-processing.
   *
   * This fills the gap that would otherwise occur when the service restarts after
   * a deployment or network interruption.
   */
  async backfillAll(): Promise<void> {
    this.log.info("Running startup missed-ledger backfill", {
      contracts: this.config.contractIds,
    });
    for (const contractId of this.config.contractIds) {
      await this.backfillContract(contractId);
    }
    this.log.info("Startup backfill complete");
  }

  /**
   * Backfill a single contract from its last durable checkpoint to the current
   * ledger by paging through `getEvents` until no more events are returned.
   *
   * The PostgreSQL checkpoint takes precedence over the Redis cursor because
   * Redis may have been flushed, while PostgreSQL persists across restarts.
   * After backfill succeeds, the Redis cursor is synced to the recovered
   * ledger so normal polling picks up seamlessly.
   */
  async backfillContract(contractId: string): Promise<number> {
    // 1. Load durable PostgreSQL checkpoint.
    const pgCheckpoint = await this.checkpointStore.get(contractId);

    // 2. Also load the Redis cursor as a fallback / comparison.
    const redisCursor = await this.cursorStore.loadCursor(contractId);

    // 3. Take the higher of the two so we never go backwards.
    const pgLedger = pgCheckpoint?.lastLedgerSequence ?? 0;
    const redisLedger = redisCursor?.lastLedgerSequence ?? 0;
    const startLedger = Math.max(pgLedger, redisLedger);

    if (startLedger === 0) {
      this.log.info("No checkpoint found for contract, skipping backfill", {
        contractId,
      });
      return 0;
    }

    this.log.info("Backfilling missed events for contract", {
      contractId,
      fromLedger: startLedger,
    });

    let totalBackfilled = 0;
    let pageCursor: string | undefined = undefined;
    let latestLedger = startLedger;

    // Page through events from the last checkpoint to the current ledger.
    while (true) {
      // Throttle against pool saturation before firing off another bulk page
      // of dedup/checkpoint queries (Issue #335).
      await this.throttleForPoolCapacity();

      const response = await this.rpcClient.getEvents({
        startLedger: pageCursor ? undefined : startLedger,
        cursor: pageCursor,
        limit: this.config.pageSize ?? DEFAULT_PAGE_SIZE,
        filters: [{ type: "contract", contractIds: [contractId] }],
      });

      if (response.events.length === 0) {
        // No more events — backfill is complete.
        latestLedger = response.latestLedger > 0
          ? response.latestLedger
          : latestLedger;
        break;
      }

      const ingested = await this.publishEvents(response.events);
      totalBackfilled += ingested;
      latestLedger = response.latestLedger;

      const lastEvent = response.events[response.events.length - 1];

      // If the page was smaller than the limit we've reached the end.
      if (response.events.length < (this.config.pageSize ?? DEFAULT_PAGE_SIZE)) {
        // Advance checkpoint with the last event from this page.
        await this.advanceCheckpoint(contractId, latestLedger, lastEvent.id);
        break;
      }

      // Use the RPC cursor token to fetch the next page.
      pageCursor = response.cursor || lastEvent.pagingToken;
      if (!pageCursor) {
        await this.advanceCheckpoint(contractId, latestLedger, lastEvent.id);
        break;
      }

      // Advance checkpoint after each successfully ingested page so that a
      // crash mid-backfill resumes from the right place, not from scratch.
      await this.advanceCheckpoint(contractId, latestLedger, lastEvent.id);
    }

    if (totalBackfilled > 0) {
      this.log.info("Backfill complete for contract", {
        contractId,
        totalBackfilled,
        latestLedger,
      });
    }

    return totalBackfilled;
  }

  // -------------------------------------------------------------------------
  // Real-time polling loop
  // -------------------------------------------------------------------------

  private poll(): void {
    if (!this.running) return;

    this.ingestAll()
      .then(() => {
        this.reconnectAttempts = 0;
      })
      .catch((err) => {
        this.reconnectAttempts++;
        this.log.error("Ingestion poll failed", {
          error: err instanceof Error ? err.message : String(err),
          reconnectAttempts: this.reconnectAttempts,
        });

        if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
          this.log.error("Max reconnect attempts reached, stopping worker");
          this.running = false;
          return;
        }
      })
      .finally(() => {
        if (this.running) {
          const delay =
            this.reconnectAttempts > 0
              ? RECONNECT_BACKOFF_MS * this.reconnectAttempts
              : (this.config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
          this.pollTimer = setTimeout(() => this.poll(), delay);
        }
      });
  }

  /** Ingest events for all configured contracts in one poll cycle. */
  async ingestAll(): Promise<number> {
    let totalIngested = 0;
    for (const contractId of this.config.contractIds) {
      const count = await this.ingestContract(contractId);
      totalIngested += count;
    }
    if (totalIngested > 0) {
      this.log.info("Ingestion batch complete", { totalIngested });
    }
    return totalIngested;
  }

  /**
   * Ingest events for a single contract in real-time mode.
   *
   * Uses the Redis cursor for fast resume within a session.  After each
   * successful batch the PostgreSQL checkpoint is also advanced so the next
   * restart can backfill any gap.
   */
  async ingestContract(contractId: string): Promise<number> {
    // Throttle against pool saturation before this cycle's dedup/checkpoint
    // queries (Issue #335) — keeps a burst of real-time poll cycles from
    // stacking on top of an already-saturated pool during a ledger spike.
    await this.throttleForPoolCapacity();

    // Redis cursor — fast per-session resume.
    const cursor = await this.cursorStore.loadCursor(contractId);

    // If the Redis cursor is missing (post-flush), fall back to the
    // PostgreSQL checkpoint to avoid re-ingesting from ledger 0.
    let startLedger = cursor?.lastLedgerSequence;
    if (!startLedger || startLedger === 0) {
      const pgCheckpoint = await this.checkpointStore.get(contractId);
      startLedger = pgCheckpoint?.lastLedgerSequence ?? undefined;
    }

    const response = await this.rpcClient.getEvents({
      startLedger,
      cursor: cursor?.cursorToken,
      limit: this.config.pageSize ?? DEFAULT_PAGE_SIZE,
      filters: [{ type: "contract", contractIds: [contractId] }],
    });

    if (response.events.length === 0) {
      return 0;
    }

    const ingested = await this.publishEvents(response.events);

    if (response.events.length > 0) {
      const lastEvent = response.events[response.events.length - 1];

      // Advance both the Redis cursor (fast path) and the PostgreSQL checkpoint
      // (durable path) after each successful batch.
      await this.cursorStore.saveCursor({
        contractId,
        lastLedgerSequence: response.latestLedger,
        cursorToken: response.cursor,
      });

      await this.advanceCheckpoint(contractId, response.latestLedger, lastEvent.id);
    }

    this.log.debug("Ingested events for contract", {
      contractId,
      total: response.events.length,
      newlyPublished: ingested,
      latestLedger: response.latestLedger,
    });

    return ingested;
  }

  // -------------------------------------------------------------------------
  // Event publishing with deduplication (Issue #366)
  // -------------------------------------------------------------------------

  /**
   * Publish a batch of raw Soroban events to the Redis Stream, skipping any
   * event whose id has already been recorded in `processedEventStore`.
   *
   * @returns The number of newly published (non-duplicate) events.
   */
  async publishEvents(rawEvents: RawSorobanEvent[]): Promise<number> {
    if (rawEvents.length === 0) return 0;

    const normalizedEvents = rawEvents.map(normalizeEvent);

    // --- DEDUPLICATION: one batched lookup for the whole page (Issue #335)
    // instead of one SELECT per event — the fix for a bulk backfill/poll
    // page opening dozens of sequential queries against a pool capped at a
    // handful of connections during a ledger-sync spike.
    const alreadyProcessed = await this.processedEventStore.hasMany(
      normalizedEvents.map((e) => e.eventId)
    );

    const toPublish = normalizedEvents.filter((normalized) => {
      if (alreadyProcessed.has(normalized.eventId)) {
        this.log.debug("Skipping duplicate Soroban event", {
          eventId: normalized.eventId,
          contractId: normalized.contractId,
          ledger: normalized.ledger,
        });
        return false;
      }
      return true;
    });

    // --- PUBLISH to Redis Stream (Redis, not Postgres — no pool pressure) ---
    for (const normalized of toPublish) {
      await this.redis.xadd(
        STREAM_KEY,
        "*",
        "eventId",    normalized.eventId,
        "contractId", normalized.contractId,
        "topic",      normalized.topic,
        "data",       JSON.stringify(normalized.data),
        "ledger",     String(normalized.ledger),
        "txHash",     normalized.txHash,
        "timestamp",  normalized.timestamp
      );
    }

    // --- RECORD as published: one batched INSERT for the whole page
    // (Issue #335), instead of one INSERT per event.
    await this.processedEventStore.markPublishedMany(
      toPublish.map((normalized) => ({
        eventId: normalized.eventId,
        contractId: normalized.contractId,
        ledgerSequence: normalized.ledger,
      }))
    );

    return toPublish.length;
  }

  // -------------------------------------------------------------------------
  // Checkpoint management
  // -------------------------------------------------------------------------

  /**
   * Advance the durable PostgreSQL checkpoint after a successfully ingested
   * batch or backfill page.
   */
  private async advanceCheckpoint(
    contractId: string,
    lastLedgerSequence: number,
    lastEventId: string
  ): Promise<void> {
    const checkpoint: EventSyncCheckpoint = {
      lastLedgerSequence,
      lastEventId,
      syncedAt: new Date(),
    };
    await this.checkpointStore.set(contractId, checkpoint);
    this.log.debug("Checkpoint advanced", {
      contractId,
      lastLedgerSequence,
      lastEventId,
    });
  }

  // -------------------------------------------------------------------------
  // Monitoring helpers
  // -------------------------------------------------------------------------

  /** Get the current Redis cursor for a contract (fast path). */
  async getCursor(contractId: string): Promise<ContractEventCursor | null> {
    return this.cursorStore.loadCursor(contractId);
  }

  /** Get the durable PostgreSQL checkpoint for a contract. */
  async getCheckpoint(contractId: string): Promise<EventSyncCheckpoint | null> {
    return this.checkpointStore.get(contractId);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface CreateSorobanWorkerOptions {
  logger?: Logger;
  /**
   * Provide a pg.Pool to enable the PostgreSQL-backed checkpoint and dedup
   * stores.  When omitted, in-memory stores are used (suitable for tests
   * and local development without a database).
   */
  pgPool?: Pool;
}

/**
 * Creates and wires a `SorobanEventIngestionWorker` with the appropriate
 * checkpoint and dedup stores based on the environment.
 *
 * Production use: pass a `pgPool` to enable durable PostgreSQL persistence.
 * Test / local dev: omit `pgPool` to use in-memory stores.
 */
export function createSorobanEventIngestionWorker(
  redis: Redis,
  config: SorobanRpcConfig,
  options?: CreateSorobanWorkerOptions
): SorobanEventIngestionWorker {
  const checkpointStore: CheckpointStore = options?.pgPool
    ? new PostgresCheckpointStore(options.pgPool, options.logger)
    : new InMemoryCheckpointStore();

  const processedEventStore: ProcessedEventStore = options?.pgPool
    ? new PostgresProcessedEventStore(options.pgPool, options.logger)
    : new InMemoryProcessedEventStore();

  return new SorobanEventIngestionWorker(redis, config, {
    checkpointStore,
    processedEventStore,
    pgPool: options?.pgPool,
    logger: options?.logger,
  });
}

// Re-export checkpoint types so callers can type against them.
export type { EventSyncCheckpoint, CheckpointStore, ProcessedEventStore } from "./checkpointStore.js";
