/**
 * Escrow state snapshot archiver & ledger pruner (Issue #290).
 *
 * A settled escrow only has to stay in the primary `escrows` table while it is
 * operationally warm. Once a row has been settled for longer than the retention
 * window it is moved into the cold `escrow_archives` table, which keeps the
 * primary table (and its indexes) small enough to stay resident in memory.
 *
 * Nothing is discarded: the archived row is stored as a full `to_jsonb` snapshot
 * of the source row, so columns added after this migration are captured too and
 * the audit history survives the move.
 */

/**
 * Column names the archiver reads from the live escrow source table.
 *
 * Every identifier is passed through {@link assertSqlIdentifier} before it is
 * interpolated into a statement, so these are safe to expose as configuration.
 */
export interface EscrowSourceColumns {
  /** Primary key of the source row. Default `id`. */
  id: string;
  /** Human/contract-facing escrow identifier. Default `escrow_id`. */
  escrowId: string;
  /** Terminal status of the escrow. Default `status`. */
  status: string;
  /** Timestamp the escrow settled at. Default `closed_at`. */
  closedAt: string;
}

/** One settled escrow row read from the primary table. */
export interface SettledEscrow {
  escrowId: string;
  finalStatus: string;
  /** ISO-8601 timestamp the escrow settled at. */
  settledAt: string;
  /** Full JSON snapshot of the source row. */
  payload: Record<string, unknown>;
}

/** One row in the `escrow_archives` cold-storage table. */
export interface EscrowArchiveRecord {
  id: string;
  escrowId: string;
  finalStatus: string;
  settledAt: string;
  archivePayload: Record<string, unknown>;
  archivedAt: string;
}

/** Effective archiver configuration (env-derived defaults in {@link DEFAULT_ESCROW_ARCHIVER_CONFIG}). */
export interface EscrowArchiverConfig {
  /**
   * Rows settled more than this many days ago are archived.
   *
   * Default 90 days, per the issue spec ("escrows closed > 90 days ago").
   */
  retentionDays: number;
  /** Maximum rows moved per statement. Default 500. */
  batchSize: number;
  /**
   * Maximum batches per run. Bounds the work a single nightly run can put on
   * the primary database; a backlog simply drains over subsequent nights.
   */
  maxBatches: number;
  /** Live escrow table. Default `escrows`. */
  sourceTable: string;
  /** Cold-storage table. Default `escrow_archives`. */
  archiveTable: string;
  sourceColumns: EscrowSourceColumns;
}

/** Outcome of one archiver run. */
export interface ArchiveRunResult {
  /** Rows settled past the retention window when the run started. */
  pending: number;
  /** Rows moved into `escrow_archives` (and pruned) during the run. */
  archived: number;
  /** Number of `moveSettledBatch` statements executed. */
  batches: number;
  /** True when another runner held the exclusive lock, so this run did nothing. */
  skipped: boolean;
  /** ISO-8601 timestamp the run started at. */
  startedAt: string;
  durationMs: number;
  /** Non-fatal per-batch failures; the run stops at the first one. */
  errors: string[];
}

export const DEFAULT_ESCROW_ARCHIVER_CONFIG: EscrowArchiverConfig = {
  retentionDays: 90,
  batchSize: 500,
  maxBatches: 20,
  sourceTable: "escrows",
  archiveTable: "escrow_archives",
  sourceColumns: {
    id: "id",
    escrowId: "escrow_id",
    status: "status",
    closedAt: "closed_at",
  },
};

/** Raised when the archiver is configured with an unusable value. */
export class EscrowArchiverConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EscrowArchiverConfigError";
  }
}

const SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Validates a table/column name before it is interpolated into SQL. Values that
 * are not plain, unquoted identifiers are rejected rather than escaped, so a
 * misconfigured env var can never widen a statement's reach.
 */
export function assertSqlIdentifier(value: string, label: string): string {
  if (!SQL_IDENTIFIER.test(value) || value.length > 63) {
    throw new EscrowArchiverConfigError(
      `${label} must be a plain SQL identifier (letters, digits, underscore; max 63 chars), got "${value}"`
    );
  }
  return value;
}
