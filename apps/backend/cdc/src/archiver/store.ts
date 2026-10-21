/**
 * Archive storage for the escrow snapshot archiver (Issue #290).
 *
 * Two implementations ship here:
 *
 *  - {@link PostgresEscrowArchiveStore} — the production path. It moves rows
 *    from the live escrow table into `escrow_archives` inside a single
 *    transaction, holding `FOR UPDATE SKIP LOCKED` locks on the rows it is about
 *    to relocate so two runners can never archive (or delete) the same row.
 *  - {@link InMemoryEscrowArchiveStore} — the test/local path, exercising the
 *    same contract without a database.
 *
 * Both are driven by {@link EscrowArchiver}; neither one is aware of the
 * retention window, which is the archiver's concern.
 */

import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";
import { createLogger, type Logger } from "@delegolabs/utils";

import {
  assertSqlIdentifier,
  type EscrowArchiveRecord,
  type EscrowArchiverConfig,
  type SettledEscrow,
} from "./types.js";

/**
 * The operations the archiver needs. `runExclusive` serialises concurrent
 * runners: it returns the callback's value, or `null` when another runner
 * already holds the lock.
 */
export interface EscrowArchiveStore {
  /** Rows settled before `settledBefore` still sitting in the live table. */
  countSettledBefore(settledBefore: Date): Promise<number>;

  /**
   * Atomically archives up to `limit` settled rows and prunes them from the
   * live table. Returns the rows that were archived.
   */
  moveSettledBatch(settledBefore: Date, limit: number): Promise<SettledEscrow[]>;

  /** Serialises concurrent archiver runs. */
  runExclusive<T>(run: () => Promise<T>): Promise<T | null>;
}

/** Minimal `pg` surface shared by `Pool` and `PoolClient`. */
interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[]
  ): Promise<QueryResult<R>>;
}

/**
 * Single-runner guard for the escrow archiver. Session-level on purpose: the
 * lock lives on one dedicated connection for the whole run and disappears if
 * that connection dies, so a crashed archiver can never wedge the schedule.
 */
const ARCHIVER_ADVISORY_LOCK = "delego:escrow-archiver";

/** Postgres-backed archive store used in production. */
export class PostgresEscrowArchiveStore implements EscrowArchiveStore {
  private readonly sourceTable: string;
  private readonly archiveTable: string;
  private readonly idColumn: string;
  private readonly escrowIdColumn: string;
  private readonly statusColumn: string;
  private readonly closedAtColumn: string;

  /** Connection holding the advisory lock, while a run is in flight. */
  private activeClient: PoolClient | null = null;

  constructor(
    private readonly pool: Pool,
    config: EscrowArchiverConfig,
    private readonly log: Logger = createLogger(
      "cdc:archiver",
      process.env.LOG_LEVEL ?? "info"
    )
  ) {
    this.sourceTable = assertSqlIdentifier(config.sourceTable, "ESCROW_ARCHIVE_SOURCE_TABLE");
    this.archiveTable = assertSqlIdentifier(config.archiveTable, "ESCROW_ARCHIVE_TABLE");
    this.idColumn = assertSqlIdentifier(config.sourceColumns.id, "ESCROW_ARCHIVE_ID_COLUMN");
    this.escrowIdColumn = assertSqlIdentifier(
      config.sourceColumns.escrowId,
      "ESCROW_ARCHIVE_ESCROW_ID_COLUMN"
    );
    this.statusColumn = assertSqlIdentifier(
      config.sourceColumns.status,
      "ESCROW_ARCHIVE_STATUS_COLUMN"
    );
    this.closedAtColumn = assertSqlIdentifier(
      config.sourceColumns.closedAt,
      "ESCROW_ARCHIVE_CLOSED_AT_COLUMN"
    );
  }

  /** Uses the run's dedicated connection so the advisory lock and the queries share a session. */
  private db(): Queryable {
    return this.activeClient ?? this.pool;
  }

  async countSettledBefore(settledBefore: Date): Promise<number> {
    const { rows } = await this.db().query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
         FROM ${this.sourceTable}
        WHERE ${this.closedAtColumn} IS NOT NULL
          AND ${this.closedAtColumn} < $1`,
      [settledBefore]
    );
    return rows[0]?.count ?? 0;
  }

  async moveSettledBatch(settledBefore: Date, limit: number): Promise<SettledEscrow[]> {
    const client = this.activeClient;
    if (!client) {
      throw new Error("moveSettledBatch must run inside runExclusive()");
    }

    await client.query("BEGIN");
    try {
      const locked = await client.query<{ id: string; escrow_id: string }>(
        `SELECT ${this.idColumn} AS id, ${this.escrowIdColumn} AS escrow_id
           FROM ${this.sourceTable}
          WHERE ${this.closedAtColumn} IS NOT NULL
            AND ${this.closedAtColumn} < $1
            AND ${this.statusColumn} IS NOT NULL
          ORDER BY ${this.closedAtColumn} ASC
          LIMIT $2
          FOR UPDATE SKIP LOCKED`,
        [settledBefore, limit]
      );

      if (locked.rows.length === 0) {
        await client.query("COMMIT");
        return [];
      }

      const archived = await client.query<{
        escrow_id: string;
        final_status: string;
        settled_at: Date;
        archive_payload: Record<string, unknown>;
      }>(
        `INSERT INTO ${this.archiveTable}
                (${this.escrowIdColumn}, final_status, settled_at, archive_payload)
         SELECT s.${this.escrowIdColumn},
                s.${this.statusColumn},
                s.${this.closedAtColumn},
                to_jsonb(s)
           FROM ${this.sourceTable} s
          WHERE s.${this.idColumn} = ANY($1)
         ON CONFLICT (${this.escrowIdColumn}) DO NOTHING
         RETURNING ${this.escrowIdColumn} AS escrow_id,
                   final_status,
                   settled_at,
                   archive_payload`,
        [locked.rows.map((row) => row.id)]
      );

      const archivedIds = new Set(archived.rows.map((row) => row.escrow_id));
      if (archivedIds.size < locked.rows.length) {
        this.log.warn("Skipped rows already present in the archive table", {
          locked: locked.rows.length,
          archived: archivedIds.size,
        });
      }

      if (archivedIds.size > 0) {
        const prunedIds = locked.rows
          .filter((row) => archivedIds.has(row.escrow_id))
          .map((row) => row.id);
        await client.query(
          `DELETE FROM ${this.sourceTable} WHERE ${this.idColumn} = ANY($1)`,
          [prunedIds]
        );
      }

      await client.query("COMMIT");

      return archived.rows.map((row) => ({
        escrowId: row.escrow_id,
        finalStatus: row.final_status,
        settledAt: toIsoString(row.settled_at),
        payload: row.archive_payload,
      }));
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    }
  }

  async runExclusive<T>(run: () => Promise<T>): Promise<T | null> {
    const client = await this.pool.connect();
    let locked = false;
    try {
      const result = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
        [ARCHIVER_ADVISORY_LOCK]
      );
      locked = result.rows[0]?.locked === true;
      if (!locked) {
        this.log.info("Another backfill/prune run holds the archiver lock; skipping");
        return null;
      }

      this.activeClient = client;
      return await run();
    } finally {
      this.activeClient = null;
      if (locked) {
        await client
          .query("SELECT pg_advisory_unlock(hashtext($1))", [ARCHIVER_ADVISORY_LOCK])
          .catch(() => undefined);
      }
      client.release();
    }
  }
}

/**
 * In-memory archive store. Mirrors the Postgres semantics 1:1 — settled rows
 * move out of `live`, already-archived escrow ids are skipped rather than
 * overwritten, and batches are ordered oldest-settled-first.
 */
export class InMemoryEscrowArchiveStore implements EscrowArchiveStore {
  private live: SettledEscrow[] = [];
  private archives: EscrowArchiveRecord[] = [];

  constructor(seed: SettledEscrow[] = []) {
    this.live = seed.map((row) => ({ ...row }));
  }

  async countSettledBefore(settledBefore: Date): Promise<number> {
    return this.live.filter((row) => isSettledBefore(row, settledBefore)).length;
  }

  async moveSettledBatch(settledBefore: Date, limit: number): Promise<SettledEscrow[]> {
    const candidates = this.live
      .filter((row) => isSettledBefore(row, settledBefore))
      .sort((a, b) => Date.parse(a.settledAt) - Date.parse(b.settledAt))
      .slice(0, limit);

    const archived: SettledEscrow[] = [];
    for (const candidate of candidates) {
      if (this.archives.some((row) => row.escrowId === candidate.escrowId)) {
        continue;
      }
      this.archives.push({
        id: `archive-${this.archives.length + 1}`,
        escrowId: candidate.escrowId,
        finalStatus: candidate.finalStatus,
        settledAt: candidate.settledAt,
        archivePayload: { ...candidate.payload },
        archivedAt: new Date().toISOString(),
      });
      // Prune by row identity, mirroring the Postgres store's `DELETE ... WHERE id = ANY(...)`:
      // an unarchived duplicate that shares the escrow id survives the batch.
      const index = this.live.indexOf(candidate);
      if (index >= 0) this.live.splice(index, 1);
      archived.push(candidate);
    }

    return archived;
  }

  async runExclusive<T>(run: () => Promise<T>): Promise<T | null> {
    return run();
  }

  /** Test helper: rows still in the live table. */
  getLiveEscrows(): SettledEscrow[] {
    return this.live.map((row) => ({ ...row }));
  }

  /** Test helper: rows moved into cold storage. */
  getArchivedEscrows(): EscrowArchiveRecord[] {
    return this.archives.map((row) => ({ ...row }));
  }
}

function isSettledBefore(row: SettledEscrow, settledBefore: Date): boolean {
  const settledAt = Date.parse(row.settledAt);
  return Number.isFinite(settledAt) && settledAt < settledBefore.getTime();
}

/** Postgres hands back `TIMESTAMPTZ` as a `Date`; tolerate an already-ISO string. */
function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}
