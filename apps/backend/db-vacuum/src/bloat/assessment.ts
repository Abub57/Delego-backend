/**
 * Bloat assessment: turns raw `pg_stat_user_tables` counters into a severity
 * verdict plus a vacuum/no-vacuum decision.
 * Issue #382 — Automated Database Vacuum and Bloat Monitoring Worker.
 */
import type {
  BloatAssessment,
  BloatSeverity,
  IndexBloatStats,
  TableBloatStats,
  VacuumThresholds,
} from "@delegolabs/types";
import { isReservedSchema } from "./statsQuery.js";

/**
 * Conservative defaults. The worker is non-destructive, so it favours false
 * negatives: a table must be both big enough to matter and dead-tuple-heavy
 * before it is vacuumed.
 */
export const DEFAULT_THRESHOLDS: VacuumThresholds = {
  deadTupleRatio: 0.2,
  deadTupleCount: 10_000,
  minTableSizeBytes: 10 * 1024 * 1024,
  lowDeadTupleRatio: 0.2,
  mediumDeadTupleRatio: 0.25,
  highDeadTupleRatio: 0.35,
  criticalDeadTupleRatio: 0.5,
  bloatBytesEscalation: 5 * 1024 * 1024 * 1024,
  unusedIndexMinSizeBytes: 5 * 1024 * 1024,
};

/** Ordered from healthiest to worst; used for escalation and de-escalation. */
const SEVERITY_ORDER: readonly BloatSeverity[] = [
  "none",
  "low",
  "medium",
  "high",
  "critical",
];

function step(severity: BloatSeverity, delta: number): BloatSeverity {
  const index = SEVERITY_ORDER.indexOf(severity);
  const next = Math.min(SEVERITY_ORDER.length - 1, Math.max(0, index + delta));
  return SEVERITY_ORDER[next]!;
}

export function isMoreSevere(a: BloatSeverity, b: BloatSeverity): boolean {
  return SEVERITY_ORDER.indexOf(a) > SEVERITY_ORDER.indexOf(b);
}

/** Formats a fully qualified table identifier for logs, alerts and messages. */
export function qualifiedNameOf(stats: TableBloatStats): string {
  return `${stats.schemaname}.${stats.relname}`;
}

function severityForRatio(deadTupleRatio: number, thresholds: VacuumThresholds): BloatSeverity {
  if (deadTupleRatio >= thresholds.criticalDeadTupleRatio) return "critical";
  if (deadTupleRatio >= thresholds.highDeadTupleRatio) return "high";
  if (deadTupleRatio >= thresholds.mediumDeadTupleRatio) return "medium";
  if (deadTupleRatio >= thresholds.lowDeadTupleRatio) return "low";
  return "none";
}

function findUnusedIndexes(
  stats: TableBloatStats,
  thresholds: VacuumThresholds,
): IndexBloatStats[] {
  return stats.indexes.filter(
    (index) => index.idxScan === 0 && index.indexSizeBytes >= thresholds.unusedIndexMinSizeBytes,
  );
}

export interface AssessOptions {
  thresholds?: Partial<VacuumThresholds>;
}

function resolveThresholds(options: AssessOptions = {}): VacuumThresholds {
  return { ...DEFAULT_THRESHOLDS, ...options.thresholds };
}

/**
 * Evaluates a single table.
 *
 * Two independent signals can cross the vacuum threshold — the *ratio* of dead
 * tuples and the *absolute count* of them — because a small hot table can blow
 * the ratio while a large one creeps up slowly.
 */
export function assessTable(
  stats: TableBloatStats,
  options: AssessOptions = {},
): BloatAssessment {
  const thresholds = resolveThresholds(options);
  const totalTuples = stats.n_live_tup + stats.n_dead_tup;
  const deadTupleRatio = totalTuples > 0
    ? clampRatio(stats.n_dead_tup / totalTuples)
    : 0;

  // Mean tuple width, used to turn a dead-tuple count into reclaimable bytes.
  const meanTupleBytes = totalTuples > 0
    ? stats.totalSizeBytes / totalTuples
    : 0;
  const estimatedBloatBytes = Math.max(0, Math.round(stats.n_dead_tup * meanTupleBytes));
  const bloatRatio = stats.totalSizeBytes > 0
    ? clampRatio(estimatedBloatBytes / stats.totalSizeBytes)
    : 0;

  const reasons: string[] = [];
  let severity = severityForRatio(deadTupleRatio, thresholds);
  let exceedsThreshold = false;

  if (isReservedSchema(stats.schemaname)) {
    reasons.push(`schema ${stats.schemaname} is reserved and is never vacuumed`);
    return {
      schema: stats.schemaname,
      table: stats.relname,
      qualifiedName: qualifiedNameOf(stats),
      stats,
      deadTupleRatio,
      bloatRatio,
      estimatedBloatBytes,
      deadTuples: stats.n_dead_tup,
      liveTuples: stats.n_live_tup,
      severity: "none",
      exceedsThreshold: false,
      reasons,
      unusedIndexes: [],
    };
  }

  if (stats.totalSizeBytes < thresholds.minTableSizeBytes) {
    // Size gates *both* threshold signals. A 1MB lookup table can accumulate
    // 100k dead tuples and still not be worth a vacuum — and the absolute
    // count threshold must not override that.
    reasons.push(
      `table size ${stats.totalSizeBytes} is below the ${thresholds.minTableSizeBytes} byte minimum`,
    );
  } else if (deadTupleRatio >= thresholds.deadTupleRatio) {
    exceedsThreshold = true;
    reasons.push(
      `dead tuple ratio ${formatPct(deadTupleRatio)} >= threshold ${formatPct(thresholds.deadTupleRatio)}`,
    );
  } else {
    reasons.push(
      `dead tuple ratio ${formatPct(deadTupleRatio)} is below threshold ${formatPct(thresholds.deadTupleRatio)}`,
    );
  }

  if (
    !exceedsThreshold &&
    stats.totalSizeBytes >= thresholds.minTableSizeBytes &&
    stats.n_dead_tup >= thresholds.deadTupleCount
  ) {
    exceedsThreshold = true;
    reasons.push(
      `dead tuple count ${stats.n_dead_tup} >= threshold ${thresholds.deadTupleCount}`,
    );
  }

  // A high absolute dead-tuple count should still read as at least "high",
  // otherwise a 10M-row table with 10% churn never registers a severity.
  if (exceedsThreshold && severity === "none") {
    severity = "low";
  }

  if (estimatedBloatBytes >= thresholds.bloatBytesEscalation && severity !== "none") {
    severity = step(severity, 1);
    reasons.push(
      `estimated reclaimable ${formatBytes(estimatedBloatBytes)} >= escalation ${formatBytes(thresholds.bloatBytesEscalation)}`,
    );
  }

  if (stats.n_mod_since_analyze > 0) {
    reasons.push(
      `${stats.n_mod_since_analyze} rows changed since last analyze; ANALYZE included in the vacuum`,
    );
  }

  if (!stats.autovacuumEnabled) {
    reasons.push("autovacuum is disabled for this table");
  }

  const unusedIndexes = findUnusedIndexes(stats, thresholds);
  if (unusedIndexes.length > 0) {
    const names = unusedIndexes.map((index) => index.indexname);
    reasons.push(
      `${unusedIndexes.length} index(es) with zero scans since last stats reset: ${names.join(", ")}`,
    );
  }

  return {
    schema: stats.schemaname,
    table: stats.relname,
    qualifiedName: qualifiedNameOf(stats),
    stats,
    deadTupleRatio,
    bloatRatio,
    estimatedBloatBytes,
    deadTuples: stats.n_dead_tup,
    liveTuples: stats.n_live_tup,
    severity,
    exceedsThreshold,
    reasons,
    unusedIndexes,
  };
}

/** Evaluates a whole scan result, heaviest bloat first. */
export function assessTables(
  stats: TableBloatStats[],
  options: AssessOptions = {},
): BloatAssessment[] {
  return stats
    .map((table) => assessTable(table, options))
    .sort((a, b) => b.deadTupleRatio - a.deadTupleRatio);
}

function clampRatio(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value > 1 ? 1 : value;
}

function formatPct(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)}${units[unit]}`;
}
