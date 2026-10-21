/**
 * Database vacuum and bloat monitoring domain types.
 * Issue #382 — Automated Database Vacuum and Bloat Monitoring Worker.
 */

/** Severity ladder for a table's bloat assessment, ordered from healthy to critical. */
export type BloatSeverity = "none" | "low" | "medium" | "high" | "critical";

/** A single index observed on a table, used to report index bloat signals. */
export interface IndexBloatStats {
  indexname: string;
  /** Total size of the index on disk, in bytes. */
  indexSizeBytes: number;
  /** Cumulative number of index scans since stats were last reset. */
  idxScan: number;
  /** Number of rows removed by this index's last planned index cleanup. */
  idxTupRead: number;
}

/**
 * Raw snapshot of a user table taken from `pg_stat_user_tables` (joined with
 * `pg_statio_user_tables` and `pg_class` for sizes) plus its index stats.
 *
 * Counts come straight from the collector, so they are only as fresh as the
 * last stats reset — callers should treat them as advisory.
 */
export interface TableBloatStats {
  schemaname: string;
  relname: string;
  /** Estimated live rows. */
  n_live_tup: number;
  /** Estimated dead (obsolete) rows eligible for removal by VACUUM. */
  n_dead_tup: number;
  /** Rows inserted/updated/deleted since the last ANALYZE. */
  n_mod_since_analyze: number;
  /** Total on-disk size of the table (heap + toast + indexes), in bytes. */
  totalSizeBytes: number;
  /** Total on-disk size of all indexes on the table, in bytes. */
  indexSizeBytes: number;
  /** Indexes on this table with zero scans since the last stats reset. */
  indexes: IndexBloatStats[];
  lastVacuum: string | null;
  lastAutovacuum: string | null;
  lastAnalyze: string | null;
  lastAutoanalyze: string | null;
  /** False when autovacuum has been switched off for this table. */
  autovacuumEnabled: boolean;
}

/** The verdict for one table: how bloated it is, and whether it needs vacuuming. */
export interface BloatAssessment {
  schema: string;
  table: string;
  /** `schema.table` identifier, safe to log and use as a dedupe key. */
  qualifiedName: string;
  stats: TableBloatStats;
  /** `n_dead_tup / (n_live_tup + n_dead_tup)`, clamped to 0..1. */
  deadTupleRatio: number;
  /**
   * Byte-level estimate of wasted space, as a fraction of the table's total
   * size. Under the standard approximation this tracks `deadTupleRatio`; it is
   * kept separate because the absolute figure ({@link estimatedBloatBytes}) is
   * the one that drives alerting.
   */
  bloatRatio: number;
  /** Estimated reclaimable bytes on disk. */
  estimatedBloatBytes: number;
  deadTuples: number;
  liveTuples: number;
  severity: BloatSeverity;
  /** True when any configured threshold was crossed and a vacuum is warranted. */
  exceedsThreshold: boolean;
  /** Human-readable reasons the threshold was (or was not) crossed. */
  reasons: string[];
  /** Indexes with zero scans since the last stats reset. */
  unusedIndexes: IndexBloatStats[];
}

/** Thresholds controlling when a table is considered bloated and vacuumed. */
export interface VacuumThresholds {
  /** Dead-tuple ratio (0..1) that marks a table as bloated. */
  deadTupleRatio: number;
  /** Absolute dead-tuple count that marks a table as bloated regardless of ratio. */
  deadTupleCount: number;
  /** Tables smaller than this are ignored — vacuuming them is wasted work. */
  minTableSizeBytes: number;
  /** Ratio at which severity becomes "critical". */
  criticalDeadTupleRatio: number;
  /** Ratio at which severity becomes "high". */
  highDeadTupleRatio: number;
  /** Ratio at which severity becomes "medium". */
  mediumDeadTupleRatio: number;
  /** Ratio at which severity becomes "low" (the alerting floor). */
  lowDeadTupleRatio: number;
  /**
   * Estimated wasted bytes at which severity is escalated one step. Absolute
   * rather than relative: 20% bloat is noise on a 50MB table and an incident
   * on a 200GB one.
   */
  bloatBytesEscalation: number;
  /** Indexes at least this large are reported as unused when `idx_scan = 0`. */
  unusedIndexMinSizeBytes: number;
}

export type VacuumOutcome = "vacuumed" | "skipped" | "failed";

/** Why a table was not vacuumed, or why a vacuum attempt failed. */
export interface VacuumSkipReason {
  qualifiedName: string;
  reason: string;
}

/** An alert raised for a table that crossed a threshold. */
export interface BloatAlert {
  id: string;
  /** Stable identity for a table+rule pair, used for alert deduplication. */
  fingerprint: string;
  rule: "dead_tuples" | "bloat_bytes" | "unused_index";
  severity: BloatSeverity;
  service: string;
  title: string;
  message: string;
  qualifiedName: string;
  deadTupleRatio: number;
  estimatedBloatBytes: number;
  raisedAt: string;
  labels: Record<string, string>;
}

/** One row of the audit trail persisted per table per run. */
export interface VacuumRunRecord {
  runId: string;
  qualifiedName: string;
  outcome: VacuumOutcome;
  severity: BloatSeverity;
  deadTupleRatio: number;
  estimatedBloatBytes: number;
  durationMs: number;
  reason?: string;
  at: string;
}

/** Aggregate counters describing worker health. */
export interface VacuumMetrics {
  lastRunAt: string | null;
  lastRunDurationMs: number;
  runs: number;
  tablesScanned: number;
  tablesOverThreshold: number;
  vacuumAttempts: number;
  vacuumsSucceeded: number;
  vacuumsFailed: number;
  vacuumsSkipped: number;
  /** Successful vacuums / attempts, or 1 when nothing was attempted yet. */
  vacuumSuccessRate: number;
  avgVacuumDurationMs: number;
  alertsRaised: number;
  alertsSuppressed: number;
  criticalTables: number;
  totalDeadTuples: number;
  totalEstimatedBloatBytes: number;
  worstDeadTupleRatio: number;
  worstTable: string | null;
}

/** Result of a single worker pass over the database. */
export interface VacuumRunSummary {
  runId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  tablesScanned: number;
  tablesOverThreshold: number;
  vacuumed: string[];
  skipped: VacuumSkipReason[];
  failed: VacuumSkipReason[];
  alertsRaised: number;
  /** When true no VACUUM statement is issued; the run is a read-only assessment. */
  dryRun: boolean;
}
