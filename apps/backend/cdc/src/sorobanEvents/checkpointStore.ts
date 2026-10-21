/**
 * Soroban Event Sync Checkpoint Store (Issue #366)
 *
 * Provides durable PostgreSQL-backed persistence for the Soroban RPC event
 * listener's sync state, solving two related problems:
 *
 *   1. MISSED-LEDGER RECOVERY — After a restart or network interruption the
 *      worker must know the last ledger it successfully processed so it can
 *      resume from that point and backfill any events emitted while it was
 *      down.  Redis cursors (the existing CursorStore) are ephemeral; a Redis
 *      flush or TTL eviction means the cursor is gone and the worker would
 *      start from ledger 0, replaying all historical events.  PostgreSQL
 *      provides the durability needed to close this gap.
 *
 *   2. DEDUPLICATION — The backfill path (and normal at-least-once polling)
 *      can deliver the same Soroban event more than once.  The
 *      ProcessedEventStore records every event id that has been written to the
 *      Redis Stream so a second delivery is silently skipped rather than
 *      double-published.
 *
 * Backed by migration: database/migrations/059_soroban_event_sync_checkpoints.sql
 */

import type { Pool } from "pg";
import { createLogger, type Logger } from "@delegolabs/utils";

// ---------------------------------------------------------------------------
// EventSyncCheckpoint — the shape defined in Issue #366
// ---------------------------------------------------------------------------

/**
 * Durable checkpoint that tracks which ledger and event the Soroban ingestion
 * worker last successfully processed per contract.
 */
export interface EventSyncCheckpoint {
  /** The last ledger sequence that has been fully ingested. */
  lastLedgerSequence: number;
  /** The Soroban event id of the last event written to the event bus. */
  lastEventId: string;
  /** When this checkpoint was last advanced. */
  syncedAt: Date;
}

// ---------------------------------------------------------------------------
// CheckpointStore interface + implementations
// ---------------------------------------------------------------------------

export interface CheckpointStore {
  /**
   * Retrieve the stored checkpoint for a contract.
   * Returns `null` when no checkpoint has been saved yet (first run).
   */
  get(contractId: string): Promise<EventSyncCheckpoint | null>;

  /**
   * Upsert the checkpoint for a contract after a successful ingestion batch.
   * Idempotent — re-saving the same values is a safe no-op.
   */
  set(contractId: string, checkpoint: EventSyncCheckpoint): Promise<void>;
}

// ---------------------------------------------------------------------------
// In-memory implementation (tests / local dev)
// ---------------------------------------------------------------------------

export class InMemoryCheckpointStore implements CheckpointStore {
  private readonly checkpoints = new Map<string, EventSyncCheckpoint>();

  async get(contractId: string): Promise<EventSyncCheckpoint | null> {
    return this.checkpoints.get(contractId) ?? null;
  }

  async set(contractId: string, checkpoint: EventSyncCheckpoint): Promise<void> {
    this.checkpoints.set(contractId, { ...checkpoint });
  }

  /** Test helper: expose stored state. */
  _snapshot(): Map<string, EventSyncCheckpoint> {
    return new Map(this.checkpoints);
  }

  clear(): void {
    this.checkpoints.clear();
  }
}

// ---------------------------------------------------------------------------
// PostgreSQL implementation (production)
// ---------------------------------------------------------------------------

export class PostgresCheckpointStore implements CheckpointStore {
  private readonly pool: Pool;
  private readonly log: Logger;

  constructor(pool: Pool, log?: Logger) {
    this.pool = pool;
    this.log = log ?? createLogger("cdc:soroban:checkpointStore", process.env.LOG_LEVEL ?? "info");
  }

  async get(contractId: string): Promise<EventSyncCheckpoint | null> {
    const res = await this.pool.query<{
      last_ledger_sequence: number;
      last_event_id: string;
      synced_at: Date;
    }>(
      `SELECT last_ledger_sequence, last_event_id, synced_at
       FROM soroban_event_sync_checkpoints
       WHERE contract_id = $1`,
      [contractId]
    );

    const row = res.rows[0];
    if (!row) return null;

    return {
      lastLedgerSequence: Number(row.last_ledger_sequence),
      lastEventId: row.last_event_id,
      syncedAt: row.synced_at instanceof Date ? row.synced_at : new Date(row.synced_at),
    };
  }

  async set(contractId: string, checkpoint: EventSyncCheckpoint): Promise<void> {
    this.log.debug("Advancing Soroban event sync checkpoint", {
      contractId,
      lastLedgerSequence: checkpoint.lastLedgerSequence,
      lastEventId: checkpoint.lastEventId,
    });

    await this.pool.query(
      `INSERT INTO soroban_event_sync_checkpoints
         (contract_id, last_ledger_sequence, last_event_id, synced_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (contract_id) DO UPDATE SET
         last_ledger_sequence = EXCLUDED.last_ledger_sequence,
         last_event_id        = EXCLUDED.last_event_id,
         synced_at            = EXCLUDED.synced_at`,
      [
        contractId,
        checkpoint.lastLedgerSequence,
        checkpoint.lastEventId,
        checkpoint.syncedAt,
      ]
    );
  }
}

// ---------------------------------------------------------------------------
// ProcessedEventStore interface + implementations
// ---------------------------------------------------------------------------

/**
 * Idempotency log for event bus writes.  The worker checks this before every
 * XADD so that a crash-recovery backfill never double-publishes an event.
 */
export interface ProcessedEventStoreEntry {
  eventId: string;
  contractId: string;
  ledgerSequence: number;
}

export interface ProcessedEventStore {
  /**
   * Check whether `eventId` was already published.
   */
  has(eventId: string): Promise<boolean>;

  /**
   * Record `eventId` as published.  Idempotent — inserting a duplicate is
   * safe (ON CONFLICT DO NOTHING / Map.set is a no-op for the same key).
   */
  markPublished(eventId: string, contractId: string, ledgerSequence: number): Promise<void>;

  /**
   * Batched dedup check (Issue #335). Returns the subset of `eventIds` that
   * have already been published, in a single round trip instead of one query
   * per event — the shape that lets a bulk backfill page stay within the
   * CDC pool's connection budget during a ledger-sync spike.
   */
  hasMany(eventIds: string[]): Promise<Set<string>>;

  /**
   * Batched insert (Issue #335) — records an entire ingestion page as
   * published in one statement rather than one `INSERT` per event.
   */
  markPublishedMany(entries: ProcessedEventStoreEntry[]): Promise<void>;
}

// ---------------------------------------------------------------------------
// In-memory ProcessedEventStore (tests / local dev)
// ---------------------------------------------------------------------------

export class InMemoryProcessedEventStore implements ProcessedEventStore {
  private readonly published = new Set<string>();

  async has(eventId: string): Promise<boolean> {
    return this.published.has(eventId);
  }

  async markPublished(eventId: string, _contractId: string, _ledgerSequence: number): Promise<void> {
    this.published.add(eventId);
  }

  async hasMany(eventIds: string[]): Promise<Set<string>> {
    return new Set(eventIds.filter((id) => this.published.has(id)));
  }

  async markPublishedMany(entries: ProcessedEventStoreEntry[]): Promise<void> {
    for (const entry of entries) this.published.add(entry.eventId);
  }

  size(): number {
    return this.published.size;
  }

  clear(): void {
    this.published.clear();
  }
}

// ---------------------------------------------------------------------------
// PostgreSQL ProcessedEventStore (production)
// ---------------------------------------------------------------------------

export class PostgresProcessedEventStore implements ProcessedEventStore {
  private readonly pool: Pool;
  private readonly log: Logger;

  constructor(pool: Pool, log?: Logger) {
    this.pool = pool;
    this.log = log ?? createLogger("cdc:soroban:processedEvents", process.env.LOG_LEVEL ?? "info");
  }

  async has(eventId: string): Promise<boolean> {
    const res = await this.pool.query<{ event_id: string }>(
      `SELECT event_id FROM soroban_processed_events WHERE event_id = $1 LIMIT 1`,
      [eventId]
    );
    return (res.rowCount ?? 0) > 0;
  }

  async markPublished(eventId: string, contractId: string, ledgerSequence: number): Promise<void> {
    this.log.debug("Recording Soroban event as published", { eventId, contractId, ledgerSequence });

    await this.pool.query(
      `INSERT INTO soroban_processed_events (event_id, contract_id, ledger_sequence, published_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (event_id) DO NOTHING`,
      [eventId, contractId, ledgerSequence]
    );
  }

  /**
   * Batched dedup lookup — one `= ANY($1)` query for a whole ingestion page
   * instead of one `SELECT` per event, so a bulk backfill burst issues a
   * single round trip against the pool rather than dozens.
   */
  async hasMany(eventIds: string[]): Promise<Set<string>> {
    if (eventIds.length === 0) return new Set();
    const res = await this.pool.query<{ event_id: string }>(
      `SELECT event_id FROM soroban_processed_events WHERE event_id = ANY($1::text[])`,
      [eventIds]
    );
    return new Set(res.rows.map((row) => row.event_id));
  }

  /**
   * Batched insert — records an entire page of newly-published events in one
   * statement (via `UNNEST`) instead of one `INSERT` per event. This is the
   * core fix for Issue #335: during a ledger-sync spike, a 50-event backfill
   * page previously opened up to 50 sequential query round trips against a
   * pool capped at a handful of connections.
   */
  async markPublishedMany(entries: ProcessedEventStoreEntry[]): Promise<void> {
    if (entries.length === 0) return;
    this.log.debug("Recording Soroban event batch as published", { count: entries.length });

    const eventIds = entries.map((e) => e.eventId);
    const contractIds = entries.map((e) => e.contractId);
    const ledgerSequences = entries.map((e) => e.ledgerSequence);

    await this.pool.query(
      `INSERT INTO soroban_processed_events (event_id, contract_id, ledger_sequence, published_at)
       SELECT event_id, contract_id, ledger_sequence, NOW()
       FROM UNNEST($1::text[], $2::text[], $3::int[]) AS t(event_id, contract_id, ledger_sequence)
       ON CONFLICT (event_id) DO NOTHING`,
      [eventIds, contractIds, ledgerSequences]
    );
  }
}
