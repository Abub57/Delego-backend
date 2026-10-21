/**
 * Transactional checkpoint store for resumable Soroban event ingestion.
 *
 * Every commit runs in ONE PostgreSQL transaction that:
 *   1. locks the contract's row in `soroban_event_sync_checkpoints`
 *      (`SELECT … FOR UPDATE`) and verifies it still matches the watermark the
 *      worker last observed (compare-and-set — guards against a second
 *      replica or a stale in-memory view),
 *   2. upserts the events into `soroban_contract_events` (idempotent),
 *   3. claims the event ids in `soroban_processed_events`; only ids that were
 *      newly claimed are handed to downstream processors, so a re-read ledger
 *      is never processed twice,
 *   4. advances the watermark.
 *
 * Either all of that lands or none of it does, so a worker taken offline at
 * any instant resumes from exactly the last committed ledger.
 *
 * Backed by migrations 059_soroban_event_sync_checkpoints.sql and
 * 062_soroban_contract_events.sql.
 */

import type { Pool, PoolClient } from "pg";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IngestionCheckpoint {
  contractId: string;
  /** Every event with `ledger <= lastProcessedLedger` has been committed. */
  lastProcessedLedger: number;
  /** Id of the last event committed (empty when none yet). */
  lastEventId: string;
  updatedAt: string;
}

/** A Soroban contract event in the shape the store persists. */
export interface LedgerEvent {
  eventId: string;
  contractId: string;
  ledger: number;
  ledgerClosedAt: string;
  txHash: string;
  topics: unknown[];
  value: unknown;
  inSuccessfulContractCall: boolean;
}

/**
 * Downstream projection run inside the commit transaction, e.g. updating
 * escrow status from `release` events. Receives only events claimed for the
 * first time, in strict (ledger, eventId) order. Throwing rolls the whole
 * batch back, including the watermark.
 */
export interface LedgerEventProcessor {
  process(client: PoolClient, events: LedgerEvent[]): Promise<void>;
}

export interface CommitBatchInput {
  contractId: string;
  /** The checkpoint the worker last observed; `null` when none existed. */
  expected: IngestionCheckpoint | null;
  /** New watermark: all ledgers up to and including this one are complete. */
  throughLedger: number;
  /** Events with ledger <= throughLedger, sorted by (ledger, eventId). */
  events: LedgerEvent[];
}

export interface CommitBatchResult {
  checkpoint: IngestionCheckpoint;
  /** Events newly claimed by this commit (already-processed ids excluded). */
  processed: LedgerEvent[];
}

export interface IngestionCheckpointStore {
  /** Load checkpoints for the given contracts in a single query. */
  loadAll(contractIds: string[]): Promise<Map<string, IngestionCheckpoint>>;
  /** Atomically persist events and advance the watermark. */
  commitBatch(input: CommitBatchInput): Promise<CommitBatchResult>;
}

/**
 * The stored checkpoint no longer matches what the worker expected — another
 * writer advanced it. The worker must reload and resume from the stored value.
 */
export class CheckpointConflictError extends Error {
  constructor(
    readonly contractId: string,
    readonly stored: IngestionCheckpoint | null
  ) {
    super(
      `Checkpoint for ${contractId} changed concurrently (stored ledger ${
        stored?.lastProcessedLedger ?? "none"
      })`
    );
    this.name = "CheckpointConflictError";
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

export function compareLedgerEvents(a: LedgerEvent, b: LedgerEvent): number {
  if (a.ledger !== b.ledger) return a.ledger - b.ledger;
  // Soroban event ids are zero-padded TOIDs ("0000000004294967296-0000000001"),
  // so lexicographic order matches on-chain order within a ledger.
  return a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0;
}

function sameWatermark(a: IngestionCheckpoint | null, b: IngestionCheckpoint | null): boolean {
  return (
    (a?.lastProcessedLedger ?? 0) === (b?.lastProcessedLedger ?? 0) &&
    (a?.lastEventId ?? "") === (b?.lastEventId ?? "")
  );
}

function assertCommitInput(input: CommitBatchInput): void {
  const floor = input.expected?.lastProcessedLedger ?? 0;
  if (input.throughLedger < floor) {
    throw new Error(
      `Refusing to move checkpoint for ${input.contractId} backwards (${floor} -> ${input.throughLedger})`
    );
  }
  for (let i = 0; i < input.events.length; i++) {
    const event = input.events[i];
    if (event.contractId !== input.contractId) {
      throw new Error(`Event ${event.eventId} belongs to ${event.contractId}, not ${input.contractId}`);
    }
    if (event.ledger > input.throughLedger) {
      throw new Error(`Event ${event.eventId} at ledger ${event.ledger} is beyond watermark ${input.throughLedger}`);
    }
    if (i > 0 && compareLedgerEvents(input.events[i - 1], event) >= 0) {
      throw new Error(`Events for ${input.contractId} are not in strict ledger order at ${event.eventId}`);
    }
  }
}

function nextCheckpoint(input: CommitBatchInput, now: Date): IngestionCheckpoint {
  const last = input.events[input.events.length - 1];
  return {
    contractId: input.contractId,
    lastProcessedLedger: input.throughLedger,
    lastEventId: last?.eventId ?? input.expected?.lastEventId ?? "",
    updatedAt: now.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// PostgreSQL implementation (production)
// ---------------------------------------------------------------------------

interface CheckpointRow {
  contract_id: string;
  last_ledger_sequence: number;
  last_event_id: string;
  synced_at: Date | string;
}

function rowToCheckpoint(row: CheckpointRow): IngestionCheckpoint {
  return {
    contractId: row.contract_id,
    lastProcessedLedger: Number(row.last_ledger_sequence),
    lastEventId: row.last_event_id,
    updatedAt: new Date(row.synced_at).toISOString(),
  };
}

export class PostgresIngestionCheckpointStore implements IngestionCheckpointStore {
  constructor(
    private readonly pool: Pool,
    private readonly processors: LedgerEventProcessor[] = []
  ) {}

  async loadAll(contractIds: string[]): Promise<Map<string, IngestionCheckpoint>> {
    const result = new Map<string, IngestionCheckpoint>();
    if (contractIds.length === 0) return result;

    const res = await this.pool.query<CheckpointRow>(
      `SELECT contract_id, last_ledger_sequence, last_event_id, synced_at
         FROM soroban_event_sync_checkpoints
        WHERE contract_id = ANY($1::text[])`,
      [contractIds]
    );
    for (const row of res.rows) {
      // A row at ledger 0 is a placeholder, not a real watermark.
      if (Number(row.last_ledger_sequence) > 0) result.set(row.contract_id, rowToCheckpoint(row));
    }
    return result;
  }

  async commitBatch(input: CommitBatchInput): Promise<CommitBatchResult> {
    assertCommitInput(input);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      await client.query(
        `INSERT INTO soroban_event_sync_checkpoints (contract_id) VALUES ($1)
         ON CONFLICT (contract_id) DO NOTHING`,
        [input.contractId]
      );
      const locked = await client.query<CheckpointRow>(
        `SELECT contract_id, last_ledger_sequence, last_event_id, synced_at
           FROM soroban_event_sync_checkpoints
          WHERE contract_id = $1
          FOR UPDATE`,
        [input.contractId]
      );
      const storedRow = locked.rows[0];
      const stored =
        storedRow && Number(storedRow.last_ledger_sequence) > 0 ? rowToCheckpoint(storedRow) : null;
      if (!sameWatermark(stored, input.expected)) {
        throw new CheckpointConflictError(input.contractId, stored);
      }

      let processed: LedgerEvent[] = [];
      if (input.events.length > 0) {
        await this.upsertEvents(client, input.events);
        processed = await this.claimEvents(client, input.events);
        for (const processor of this.processors) {
          if (processed.length > 0) await processor.process(client, processed);
        }
      }

      const checkpoint = nextCheckpoint(input, new Date());
      await client.query(
        `UPDATE soroban_event_sync_checkpoints
            SET last_ledger_sequence = $2,
                last_event_id        = $3,
                synced_at            = $4
          WHERE contract_id = $1`,
        [input.contractId, checkpoint.lastProcessedLedger, checkpoint.lastEventId, checkpoint.updatedAt]
      );

      await client.query("COMMIT");
      return { checkpoint, processed };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  private async upsertEvents(client: PoolClient, events: LedgerEvent[]): Promise<void> {
    await client.query(
      `INSERT INTO soroban_contract_events
         (event_id, contract_id, ledger_sequence, ledger_closed_at, tx_hash,
          topics, value, in_successful_contract_call)
       SELECT * FROM UNNEST(
         $1::text[], $2::text[], $3::int[], $4::timestamptz[], $5::text[],
         $6::jsonb[], $7::jsonb[], $8::boolean[]
       )
       ON CONFLICT (event_id) DO NOTHING`,
      [
        events.map((e) => e.eventId),
        events.map((e) => e.contractId),
        events.map((e) => e.ledger),
        events.map((e) => e.ledgerClosedAt),
        events.map((e) => e.txHash),
        events.map((e) => JSON.stringify(e.topics)),
        events.map((e) => JSON.stringify(e.value ?? null)),
        events.map((e) => e.inSuccessfulContractCall),
      ]
    );
  }

  /** Returns the subset of `events` claimed for the first time, order preserved. */
  private async claimEvents(client: PoolClient, events: LedgerEvent[]): Promise<LedgerEvent[]> {
    const res = await client.query<{ event_id: string }>(
      `INSERT INTO soroban_processed_events (event_id, contract_id, ledger_sequence, published_at)
       SELECT event_id, contract_id, ledger_sequence, NOW()
         FROM UNNEST($1::text[], $2::text[], $3::int[]) AS t(event_id, contract_id, ledger_sequence)
       ON CONFLICT (event_id) DO NOTHING
       RETURNING event_id`,
      [events.map((e) => e.eventId), events.map((e) => e.contractId), events.map((e) => e.ledger)]
    );
    const claimed = new Set(res.rows.map((row) => row.event_id));
    return events.filter((e) => claimed.has(e.eventId));
  }
}

// ---------------------------------------------------------------------------
// In-memory implementation (tests / local dev) — same all-or-nothing contract
// ---------------------------------------------------------------------------

export class InMemoryIngestionCheckpointStore implements IngestionCheckpointStore {
  readonly checkpoints = new Map<string, IngestionCheckpoint>();
  readonly events = new Map<string, LedgerEvent>();
  readonly processedIds = new Set<string>();

  /**
   * Stand-in for in-transaction processors. Throwing aborts the commit,
   * leaving every map untouched — the same guarantee ROLLBACK gives.
   */
  constructor(private readonly onProcess?: (events: LedgerEvent[]) => void | Promise<void>) {}

  async loadAll(contractIds: string[]): Promise<Map<string, IngestionCheckpoint>> {
    const result = new Map<string, IngestionCheckpoint>();
    for (const id of contractIds) {
      const checkpoint = this.checkpoints.get(id);
      if (checkpoint) result.set(id, { ...checkpoint });
    }
    return result;
  }

  async commitBatch(input: CommitBatchInput): Promise<CommitBatchResult> {
    assertCommitInput(input);
    const stored = this.checkpoints.get(input.contractId) ?? null;
    if (!sameWatermark(stored, input.expected)) {
      throw new CheckpointConflictError(input.contractId, stored ? { ...stored } : null);
    }

    const processed = input.events.filter((e) => !this.processedIds.has(e.eventId));
    if (processed.length > 0) await this.onProcess?.(processed);

    // Only mutate after every fallible step has succeeded.
    for (const event of input.events) {
      if (!this.events.has(event.eventId)) this.events.set(event.eventId, { ...event });
    }
    for (const event of processed) this.processedIds.add(event.eventId);
    const checkpoint = nextCheckpoint(input, new Date());
    this.checkpoints.set(input.contractId, checkpoint);
    return { checkpoint: { ...checkpoint }, processed };
  }
}
