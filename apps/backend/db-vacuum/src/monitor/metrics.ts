/**
 * Worker metrics for the vacuum/bloat monitor.
 * Issue #382 — Automated Database Vacuum and Bloat Monitoring Worker.
 */
import type {
  BloatAssessment,
  VacuumMetrics,
  VacuumRunRecord,
  VacuumRunSummary,
} from "@delegolabs/types";

/** Number of completed runs retained in memory for reporting. */
const MAX_RECORDS = 500;

/** One recorded VACUUM attempt. */
export interface VacuumAttemptRecord {
  runId: string;
  qualifiedName: string;
  success: boolean;
  durationMs: number;
  at: string;
}

export interface RunSummaryRecord {
  runId: string;
  at: string;
  durationMs: number;
  tablesScanned: number;
  tablesOverThreshold: number;
  vacuumsTriggered: number;
  vacuumsSkipped: number;
  vacuumsFailed: number;
  alertsRaised: number;
}

/**
 * Keeps a bounded rolling window of vacuum attempts and run summaries so
 * success rate and average duration can be reported. Injectable for assertions.
 */
export class VacuumRunTracker {
  private readonly attempts: VacuumAttemptRecord[] = [];
  private readonly runs: RunSummaryRecord[] = [];

  recordAttempt(record: VacuumAttemptRecord): void {
    this.attempts.push(record);
    if (this.attempts.length > MAX_RECORDS) this.attempts.shift();
  }

  recordRun(summary: RunSummaryRecord): void {
    this.runs.push(summary);
    if (this.runs.length > MAX_RECORDS) this.runs.shift();
  }

  attemptHistory(): readonly VacuumAttemptRecord[] {
    return this.attempts;
  }

  runHistory(): readonly RunSummaryRecord[] {
    return this.runs;
  }

  lastRun(): RunSummaryRecord | undefined {
    return this.runs[this.runs.length - 1];
  }

  reset(): void {
    this.attempts.length = 0;
    this.runs.length = 0;
  }
}

export interface ComputeMetricsInput {
  /** Most recent scan result; drives the instantaneous gauge values. */
  assessments?: BloatAssessment[];
  alertsSuppressed?: number;
}

/**
 * Aggregates run history and the latest scan into a single metrics object.
 * Counts are cumulative over the tracker's window, not since process start.
 */
export function computeMetrics(
  tracker: VacuumRunTracker,
  input: ComputeMetricsInput = {},
): VacuumMetrics {
  const attempts = tracker.attemptHistory();
  const runs = tracker.runHistory();
  const assessments = input.assessments ?? [];
  const lastRun = tracker.lastRun();

  const successful = attempts.filter((attempt) => attempt.success);
  const failed = attempts.filter((attempt) => !attempt.success);

  const vacuumSuccessRate = attempts.length === 0
    ? 1
    : successful.length / attempts.length;

  const avgVacuumDurationMs = successful.length === 0
    ? 0
    : Math.round(
        successful.reduce((sum, attempt) => sum + attempt.durationMs, 0) / successful.length,
      );

  // The highest-ratio table is the headline number; ties resolve to the first
  // seen so the metric is stable between runs.
  const worst = assessments.reduce<BloatAssessment | undefined>((current, assessment) => {
    if (!current) return assessment;
    return assessment.deadTupleRatio > current.deadTupleRatio ? assessment : current;
  }, undefined);

  return {
    lastRunAt: lastRun?.at ?? null,
    lastRunDurationMs: lastRun?.durationMs ?? 0,
    runs: runs.length,
    tablesScanned: lastRun?.tablesScanned ?? 0,
    tablesOverThreshold: lastRun?.tablesOverThreshold ?? 0,
    vacuumAttempts: attempts.length,
    vacuumsSucceeded: successful.length,
    vacuumsFailed: failed.length,
    vacuumsSkipped: runs.reduce((sum, run) => sum + run.vacuumsSkipped, 0),
    vacuumSuccessRate: Number(vacuumSuccessRate.toFixed(4)),
    avgVacuumDurationMs,
    alertsRaised: runs.reduce((sum, run) => sum + run.alertsRaised, 0),
    alertsSuppressed: input.alertsSuppressed ?? 0,
    criticalTables: assessments.filter((a) => a.severity === "critical").length,
    totalDeadTuples: assessments.reduce((sum, a) => sum + a.deadTuples, 0),
    totalEstimatedBloatBytes: assessments.reduce((sum, a) => sum + a.estimatedBloatBytes, 0),
    worstDeadTupleRatio: round4(worst?.deadTupleRatio ?? 0),
    worstTable: worst?.qualifiedName ?? null,
  };
}

function round4(value: number): number {
  return Number(value.toFixed(4));
}

/** Flattens a run summary into per-table audit records. */
export function summaryToRecords(summary: VacuumRunSummary): VacuumRunRecord[] {
  const records: VacuumRunRecord[] = [];
  const at = summary.finishedAt;

  for (const name of summary.vacuumed) {
    records.push({
      runId: summary.runId,
      qualifiedName: name,
      outcome: "vacuumed",
      severity: "none",
      deadTupleRatio: 0,
      estimatedBloatBytes: 0,
      durationMs: 0,
      at,
    });
  }
  for (const entry of summary.skipped) {
    records.push({
      runId: summary.runId,
      qualifiedName: entry.qualifiedName,
      outcome: "skipped",
      severity: "none",
      deadTupleRatio: 0,
      estimatedBloatBytes: 0,
      durationMs: 0,
      reason: entry.reason,
      at,
    });
  }
  for (const entry of summary.failed) {
    records.push({
      runId: summary.runId,
      qualifiedName: entry.qualifiedName,
      outcome: "failed",
      severity: "none",
      deadTupleRatio: 0,
      estimatedBloatBytes: 0,
      durationMs: 0,
      reason: entry.reason,
      at,
    });
  }

  return records;
}
