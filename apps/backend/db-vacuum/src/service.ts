/**
 * DatabaseVacuumService — the worker body for issue #382.
 *
 * One pass does four things, in order:
 *   1. Scan `pg_stat_user_tables` (plus index stats) for bloat.
 *   2. Classify each table against the configured thresholds.
 *   3. Raise deduplicated alerts for anything over the line.
 *   4. Issue a non-blocking `VACUUM ANALYZE` for the worst offenders.
 *
 * Every step is injectable, so the whole pipeline is exercised in tests
 * without a database.
 */
import { createLogger, type Logger } from "@delegolabs/utils";
import type {
  BloatAlert,
  BloatAssessment,
  TableBloatStats,
  VacuumMetrics,
  VacuumRunSummary,
  VacuumThresholds,
} from "@delegolabs/types";
import { assessTables, DEFAULT_THRESHOLDS } from "./bloat/assessment.js";
import { fetchTableBloatStats, type Queryable, type StatsQueryOptions } from "./bloat/statsQuery.js";
import { buildAlerts, DeduplicatingAlertRouter } from "./alerts/alertSink.js";
import { computeMetrics, VacuumRunTracker } from "./monitor/metrics.js";
import {
  RecordingVacuumExecutor,
  type VacuumExecutor,
  type VacuumOptions,
  type VacuumTarget,
} from "./vacuum/executor.js";
import type { VacuumHistoryStore } from "./store/vacuumHistoryStore.js";

/** Raised when a tick is requested while a previous run is still in flight. */
export class VacuumRunInProgressError extends Error {
  constructor() {
    super("A vacuum run is already in progress");
    this.name = "VacuumRunInProgressError";
  }
}

/** Source of table bloat statistics. */
export interface BloatScanner {
  scan(): Promise<TableBloatStats[]>;
}

/** Scanner backed by a real PostgreSQL connection. */
export class PgBloatScanner implements BloatScanner {
  constructor(
    private readonly db: Queryable,
    private readonly options: StatsQueryOptions = {},
  ) {}

  async scan(): Promise<TableBloatStats[]> {
    return fetchTableBloatStats(this.db, this.options);
  }
}

export interface DatabaseVacuumServiceDeps {
  scanner: BloatScanner;
  executor?: VacuumExecutor;
  alertRouter: DeduplicatingAlertRouter;
  tracker?: VacuumRunTracker;
  /** Optional durable audit trail. History write failures never fail a run. */
  history?: VacuumHistoryStore;
  thresholds?: Partial<VacuumThresholds>;
  /** Assess and alert only; never issue a VACUUM. Default false. */
  dryRun?: boolean;
  /** Ceiling on vacuums per pass, protecting the box during a bloat storm. */
  maxTablesPerRun?: number;
  /**
   * Skip tables whose autovacuum has been switched off. Default true — an
   * operator disabling autovacuum usually has a reason (a replication slot,
   * a long-running analytical load) that an automatic vacuum would disturb.
   */
  skipAutovacuumDisabled?: boolean;
  /** Skip a table when another backend is already vacuuming it. Default true. */
  skipIfVacuumRunning?: boolean;
  /** Per-statement options passed through to the executor. */
  vacuumOptions?: VacuumOptions;
  serviceName?: string;
  now?: () => Date;
  log?: Logger;
}

export interface VacuumServiceConfig {
  thresholds: VacuumThresholds;
  dryRun: boolean;
  maxTablesPerRun: number;
  skipAutovacuumDisabled: boolean;
  skipIfVacuumRunning: boolean;
  serviceName: string;
}

export class DatabaseVacuumService {
  private readonly scanner: BloatScanner;
  private readonly executor: VacuumExecutor;
  private readonly alertRouter: DeduplicatingAlertRouter;
  private readonly tracker: VacuumRunTracker;
  private readonly history?: VacuumHistoryStore;
  private readonly thresholds: VacuumThresholds;
  private readonly dryRun: boolean;
  private readonly maxTablesPerRun: number;
  private readonly skipAutovacuumDisabled: boolean;
  private readonly skipIfVacuumRunning: boolean;
  private readonly vacuumOptions: VacuumOptions;
  private readonly serviceName: string;
  private readonly now: () => Date;
  private readonly log: Logger;

  private lastAssessments: BloatAssessment[] = [];
  private lastSummary: VacuumRunSummary | null = null;
  private inProgress = false;

  constructor(deps: DatabaseVacuumServiceDeps) {
    this.scanner = deps.scanner;
    this.executor = deps.executor ?? new RecordingVacuumExecutor();
    this.alertRouter = deps.alertRouter;
    this.tracker = deps.tracker ?? new VacuumRunTracker();
    this.history = deps.history;
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...deps.thresholds };
    this.dryRun = deps.dryRun ?? false;
    this.maxTablesPerRun = deps.maxTablesPerRun ?? 5;
    this.skipAutovacuumDisabled = deps.skipAutovacuumDisabled ?? true;
    this.skipIfVacuumRunning = deps.skipIfVacuumRunning ?? true;
    this.vacuumOptions = deps.vacuumOptions ?? {};
    this.serviceName = deps.serviceName ?? "db-vacuum";
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? createLogger(this.serviceName);
  }

  config(): VacuumServiceConfig {
    return {
      thresholds: this.thresholds,
      dryRun: this.dryRun,
      maxTablesPerRun: this.maxTablesPerRun,
      skipAutovacuumDisabled: this.skipAutovacuumDisabled,
      skipIfVacuumRunning: this.skipIfVacuumRunning,
      serviceName: this.serviceName,
    };
  }

  /** Scans and classifies without vacuuming or alerting. */
  async scan(): Promise<BloatAssessment[]> {
    const stats = await this.scanner.scan();
    return assessTables(stats, { thresholds: this.thresholds });
  }

  /** Assessments from the most recent `runOnce()`, or `[]` before the first. */
  assessments(): readonly BloatAssessment[] {
    return this.lastAssessments;
  }

  lastRun(): VacuumRunSummary | null {
    return this.lastSummary;
  }

  /** Recent run history from the configured store, newest first. */
  async runHistory(limit = 100) {
    if (!this.history) return [];
    return this.history.list(limit);
  }

  metrics(): VacuumMetrics {
    return computeMetrics(this.tracker, {
      assessments: [...this.lastAssessments],
      alertsSuppressed: this.alertRouter.suppressed(),
    });
  }

  /**
   * Executes one full pass. Throws {@link VacuumRunInProgressError} if a pass
   * is already running — the worker must never overlap vacuums with itself.
   */
  async runOnce(): Promise<VacuumRunSummary> {
    if (this.inProgress) throw new VacuumRunInProgressError();
    this.inProgress = true;

    const startedAtMs = this.now().getTime();
    const startedAt = new Date(startedAtMs).toISOString();
    const runId = `${this.serviceName}-${startedAtMs}`;

    const summary: VacuumRunSummary = {
      runId,
      startedAt,
      finishedAt: startedAt,
      durationMs: 0,
      tablesScanned: 0,
      tablesOverThreshold: 0,
      vacuumed: [],
      skipped: [],
      failed: [],
      alertsRaised: 0,
      dryRun: this.dryRun,
    };

    try {
      const stats = await this.scanner.scan();
      const assessments = assessTables(stats, { thresholds: this.thresholds });
      this.lastAssessments = assessments;

      const overThreshold = assessments.filter((a) => a.exceedsThreshold);
      summary.tablesScanned = assessments.length;
      summary.tablesOverThreshold = overThreshold.length;

      // Alerts are raised for every assessment so unused-index findings are
      // reported even on tables that are not yet bloated enough to vacuum.
      const alerts = buildAlerts(assessments, {
        service: this.serviceName,
        now: this.now(),
      });
      const raised = this.alertRouter.raiseAll(alerts);
      summary.alertsRaised = raised.length;

      if (raised.length > 0) {
        this.log.warn("bloat thresholds exceeded", {
          runId,
          alerts: raised.map((alert: BloatAlert) => `${alert.rule}:${alert.qualifiedName}`),
        });
      }

      // Worst offender first, capped per run so a cluster-wide bloat spike
      // cannot turn into a storm of concurrent vacuums.
      const candidates = overThreshold.slice(0, this.dryRun ? 0 : this.maxTablesPerRun);

      for (const assessment of candidates) {
        const target: VacuumTarget = { schema: assessment.schema, table: assessment.table };
        const reason = await this.skipReason(assessment, target);
        if (reason) {
          summary.skipped.push({ qualifiedName: assessment.qualifiedName, reason });
          continue;
        }

        try {
          const result = await this.executor.vacuum(target, {
            ...this.vacuumOptions,
            dryRun: this.dryRun,
          });
          this.tracker.recordAttempt({
            runId,
            qualifiedName: result.qualifiedName,
            success: true,
            durationMs: result.durationMs,
            at: this.now().toISOString(),
          });
          summary.vacuumed.push(assessment.qualifiedName);
          this.log.info("vacuum completed", {
            runId,
            table: assessment.qualifiedName,
            deadTupleRatio: Number(assessment.deadTupleRatio.toFixed(4)),
            durationMs: result.durationMs,
          });
        } catch (err) {
          const message = (err as Error).message ?? String(err);
          this.tracker.recordAttempt({
            runId,
            qualifiedName: assessment.qualifiedName,
            success: false,
            durationMs: 0,
            at: this.now().toISOString(),
          });
          summary.failed.push({ qualifiedName: assessment.qualifiedName, reason: message });
          this.log.error("vacuum failed", {
            runId,
            table: assessment.qualifiedName,
            error: message,
          });
        }
      }

      if (this.dryRun) {
        // Nothing was executed, but the assessment is still worth reporting.
        for (const assessment of overThreshold) {
          summary.skipped.push({
            qualifiedName: assessment.qualifiedName,
            reason: "dry run: no statement issued",
          });
        }
      } else if (overThreshold.length > candidates.length) {
        const deferred = overThreshold.slice(candidates.length);
        for (const assessment of deferred) {
          summary.skipped.push({
            qualifiedName: assessment.qualifiedName,
            reason: `deferred: per-run limit of ${this.maxTablesPerRun} table(s) reached`,
          });
        }
      }

      return summary;
    } finally {
      const finishedMs = this.now().getTime();
      summary.finishedAt = new Date(finishedMs).toISOString();
      summary.durationMs = finishedMs - startedAtMs;
      this.lastSummary = summary;
      this.tracker.recordRun({
        runId,
        at: summary.finishedAt,
        durationMs: summary.durationMs,
        tablesScanned: summary.tablesScanned,
        tablesOverThreshold: summary.tablesOverThreshold,
        vacuumsTriggered: summary.vacuumed.length,
        vacuumsSkipped: summary.skipped.length,
        vacuumsFailed: summary.failed.length,
        alertsRaised: summary.alertsRaised,
      });
      if (this.history) {
        // The audit trail is best-effort: a storage problem must not turn a
        // successful vacuum into a failed run.
        try {
          await this.history.record(summary);
        } catch (err) {
          this.log.error("failed to persist vacuum history", {
            runId,
            error: (err as Error).message,
          });
        }
      }
      this.inProgress = false;
    }
  }

  private async skipReason(
    assessment: BloatAssessment,
    target: VacuumTarget,
  ): Promise<string | null> {
    if (this.skipAutovacuumDisabled && !assessment.stats.autovacuumEnabled) {
      return "autovacuum is disabled for this table";
    }
    if (this.skipIfVacuumRunning) {
      try {
        if (await this.executor.isVacuumInProgress(target)) {
          return "a vacuum is already running for this table";
        }
      } catch (err) {
        // Failing open here would risk two vacuums racing on one table; the
        // next run will retry.
        return `could not check for an in-flight vacuum: ${(err as Error).message}`;
      }
    }
    return null;
  }
}
