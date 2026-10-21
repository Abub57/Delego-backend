/**
 * Bloat alert emission with fingerprint deduplication and a cooldown window.
 * Issue #382 — Automated Database Vacuum and Bloat Monitoring Worker.
 */
import { randomUUID } from "node:crypto";
import type { BloatAlert, BloatAssessment, BloatSeverity } from "@delegolabs/types";

export interface AlertSink {
  emit(alert: BloatAlert): void;
}

export interface AlertRouterOptions {
  /** Suppress a repeat of the same fingerprint within this window. Default 1h. */
  cooldownMs?: number;
  /** Alert `service` label. Default "db-vacuum". */
  service?: string;
  now?: () => Date;
  idFactory?: () => string;
}

/** Builds the stable deduplication key for an alert. */
export function fingerprintFor(rule: BloatAlert["rule"], qualifiedName: string): string {
  return `db-bloat:${rule}:${qualifiedName}`;
}

/** Estimated wasted bytes at which a "sustained bloat" alert is raised. */
export const BLOAT_BYTES_ALERT_THRESHOLD = 5 * 1024 * 1024 * 1024;

export function buildAlerts(
  assessments: BloatAssessment[],
  options: {
    service?: string;
    now?: Date;
    idFactory?: () => string;
    bloatBytesThreshold?: number;
  } = {},
): BloatAlert[] {
  const service = options.service ?? "db-vacuum";
  const now = options.now ?? new Date();
  const idFactory = options.idFactory ?? randomUUID;
  const bloatBytesThreshold = options.bloatBytesThreshold ?? BLOAT_BYTES_ALERT_THRESHOLD;
  const raisedAt = now.toISOString();
  const alerts: BloatAlert[] = [];

  for (const assessment of assessments) {
    const base = {
      service,
      qualifiedName: assessment.qualifiedName,
      deadTupleRatio: assessment.deadTupleRatio,
      estimatedBloatBytes: assessment.estimatedBloatBytes,
      raisedAt,
    };
    const labels = {
      table: assessment.qualifiedName,
      schema: assessment.schema,
      deadTuples: String(assessment.deadTuples),
    };

    if (assessment.exceedsThreshold) {
      alerts.push({
        ...base,
        id: idFactory(),
        fingerprint: fingerprintFor("dead_tuples", assessment.qualifiedName),
        rule: "dead_tuples",
        severity: assessment.severity,
        title: `Table bloat threshold exceeded on ${assessment.qualifiedName}`,
        message:
          `Table ${assessment.qualifiedName} has ${assessment.deadTuples} dead tuples ` +
          `(${(assessment.deadTupleRatio * 100).toFixed(1)}% of ${assessment.deadTuples + assessment.liveTuples} ` +
          `rows, ~${formatBytes(assessment.estimatedBloatBytes)} reclaimable). ${assessment.reasons.join("; ")}`,
        labels,
      });
    }

    if (
      assessment.severity !== "none" &&
      assessment.estimatedBloatBytes >= bloatBytesThreshold
    ) {
      alerts.push({
        ...base,
        id: idFactory(),
        fingerprint: fingerprintFor("bloat_bytes", assessment.qualifiedName),
        rule: "bloat_bytes",
        severity: assessment.severity,
        title: `Sustained bloat on ${assessment.qualifiedName}`,
        message:
          `Table ${assessment.qualifiedName} is wasting an estimated ` +
          `${formatBytes(assessment.estimatedBloatBytes)} ` +
          `(${(assessment.bloatRatio * 100).toFixed(1)}% of the table).`,
        labels,
      });
    }

    if (assessment.unusedIndexes.length > 0) {
      const names = assessment.unusedIndexes.map((index) => index.indexname);
      alerts.push({
        ...base,
        id: idFactory(),
        fingerprint: fingerprintFor("unused_index", assessment.qualifiedName),
        rule: "unused_index",
        // Unused indexes are a recommendation, never an automatic action.
        severity: "low" as BloatSeverity,
        title: `Unused indexes on ${assessment.qualifiedName}`,
        message:
          `Indexes with zero scans since the last stats reset: ${names.join(", ")} ` +
          `(${formatBytes(assessment.unusedIndexes.reduce((sum, i) => sum + i.indexSizeBytes, 0))} total). ` +
          `Review manually — the worker never drops indexes.`,
        labels,
      });
    }
  }

  return alerts;
}

/**
 * Wraps an {@link AlertSink} and drops repeats of a fingerprint inside the
 * cooldown window, so a chronically bloated table alerts once an hour rather
 * than once a minute.
 */
export class DeduplicatingAlertRouter {
  private readonly lastEmitted = new Map<string, number>();
  private suppressedCount = 0;

  constructor(
    private readonly sink: AlertSink,
    private readonly options: AlertRouterOptions = {},
  ) {}

  private currentTime(): Date {
    return this.options.now?.() ?? new Date();
  }

  /** Returns true when the alert was emitted, false when it was suppressed. */
  raise(alert: BloatAlert): boolean {
    const cooldownMs = this.options.cooldownMs ?? 60 * 60 * 1000;
    const at = this.currentTime().getTime();
    const previous = this.lastEmitted.get(alert.fingerprint);

    if (previous !== undefined && at - previous < cooldownMs) {
      this.suppressedCount += 1;
      return false;
    }

    this.lastEmitted.set(alert.fingerprint, at);
    this.sink.emit(this.withDefaults(alert));
    return true;
  }

  raiseAll(alerts: BloatAlert[]): BloatAlert[] {
    return alerts.filter((alert) => this.raise(alert));
  }

  suppressed(): number {
    return this.suppressedCount;
  }

  /** Clears cooldown state, e.g. between tests. */
  reset(): void {
    this.lastEmitted.clear();
    this.suppressedCount = 0;
  }

  private withDefaults(alert: BloatAlert): BloatAlert {
    return {
      ...alert,
      id: alert.id || randomUUID(),
      service: alert.service || this.options.service || "db-vacuum",
      raisedAt: alert.raisedAt || this.currentTime().toISOString(),
      labels: alert.labels ?? {},
    };
  }
}

/** Default sink: structured log line per alert. */
export class LoggingAlertSink implements AlertSink {
  constructor(
    private readonly log: {
      warn: (message: string, meta?: Record<string, unknown>) => void;
    },
  ) {}

  emit(alert: BloatAlert): void {
    this.log.warn("database bloat alert", {
      rule: alert.rule,
      severity: alert.severity,
      table: alert.qualifiedName,
      deadTupleRatio: alert.deadTupleRatio,
      estimatedBloatBytes: alert.estimatedBloatBytes,
    });
  }
}

/** In-memory sink used by tests and the dry-run mode. */
export class RecordingAlertSink implements AlertSink {
  readonly alerts: BloatAlert[] = [];

  emit(alert: BloatAlert): void {
    this.alerts.push(alert);
  }

  byRule(rule: BloatAlert["rule"]): BloatAlert[] {
    return this.alerts.filter((alert) => alert.rule === rule);
  }

  clear(): void {
    this.alerts.length = 0;
  }
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
