import { describe, expect, it } from "vitest";
import type { TableBloatStats, VacuumRunSummary } from "@delegolabs/types";
import { assessTable } from "../bloat/assessment.js";
import { computeMetrics, summaryToRecords, VacuumRunTracker } from "./metrics.js";

const MB = 1024 * 1024;

function stats(overrides: Partial<TableBloatStats> = {}): TableBloatStats {
  return {
    schemaname: "public",
    relname: "orders",
    n_live_tup: 1000,
    n_dead_tup: 0,
    n_mod_since_analyze: 0,
    totalSizeBytes: 100 * MB,
    indexSizeBytes: 0,
    indexes: [],
    lastVacuum: null,
    lastAutovacuum: null,
    lastAnalyze: null,
    lastAutoanalyze: null,
    autovacuumEnabled: true,
    ...overrides,
  };
}

function makeSummary(overrides: Partial<VacuumRunSummary> = {}): VacuumRunSummary {
  return {
    runId: "run-1",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:01:00.000Z",
    durationMs: 60_000,
    tablesScanned: 10,
    tablesOverThreshold: 3,
    vacuumed: ["public.orders"],
    skipped: [{ qualifiedName: "public.items", reason: "deferred" }],
    failed: [{ qualifiedName: "public.events", reason: "lock timeout" }],
    alertsRaised: 3,
    dryRun: false,
    ...overrides,
  };
}

describe("VacuumRunTracker", () => {
  it("keeps attempts and run summaries in order", () => {
    const tracker = new VacuumRunTracker();
    tracker.recordAttempt({
      runId: "run-1",
      qualifiedName: "public.orders",
      success: true,
      durationMs: 100,
      at: "2026-01-01T00:00:00.000Z",
    });
    tracker.recordRun({
      runId: "run-1",
      at: "2026-01-01T00:01:00.000Z",
      durationMs: 60_000,
      tablesScanned: 10,
      tablesOverThreshold: 3,
      vacuumsTriggered: 1,
      vacuumsSkipped: 1,
      vacuumsFailed: 1,
      alertsRaised: 3,
    });

    expect(tracker.attemptHistory()).toHaveLength(1);
    expect(tracker.runHistory()).toHaveLength(1);
    expect(tracker.lastRun()?.runId).toBe("run-1");
  });

  it("bounds retained history so memory cannot grow without limit", () => {
    const tracker = new VacuumRunTracker();
    for (let i = 0; i < 600; i += 1) {
      tracker.recordAttempt({
        runId: `run-${i}`,
        qualifiedName: "public.orders",
        success: true,
        durationMs: i,
        at: "2026-01-01T00:00:00.000Z",
      });
    }
    expect(tracker.attemptHistory().length).toBeLessThanOrEqual(500);
    // The newest entries are the ones kept.
    expect(tracker.attemptHistory().at(-1)?.runId).toBe("run-599");
  });

  it("reset clears everything", () => {
    const tracker = new VacuumRunTracker();
    tracker.recordRun({
      runId: "run-1",
      at: "2026-01-01T00:01:00.000Z",
      durationMs: 1,
      tablesScanned: 1,
      tablesOverThreshold: 1,
      vacuumsTriggered: 1,
      vacuumsSkipped: 0,
      vacuumsFailed: 0,
      alertsRaised: 1,
    });
    tracker.reset();
    expect(tracker.attemptHistory()).toHaveLength(0);
    expect(tracker.runHistory()).toHaveLength(0);
    expect(tracker.lastRun()).toBeUndefined();
  });
});

describe("computeMetrics", () => {
  it("reports a healthy idle state before any run", () => {
    const metrics = computeMetrics(new VacuumRunTracker());
    expect(metrics.lastRunAt).toBeNull();
    expect(metrics.runs).toBe(0);
    expect(metrics.vacuumSuccessRate).toBe(1);
    expect(metrics.avgVacuumDurationMs).toBe(0);
    expect(metrics.worstTable).toBeNull();
  });

  it("summarises the latest scan", () => {
    const assessments = [
      assessTable(stats({ relname: "orders", n_live_tup: 100, n_dead_tup: 900 })),
      assessTable(stats({ relname: "items", n_live_tup: 1000, n_dead_tup: 0 })),
    ];
    const metrics = computeMetrics(new VacuumRunTracker(), { assessments });

    expect(metrics.worstTable).toBe("public.orders");
    expect(metrics.worstDeadTupleRatio).toBeCloseTo(0.9, 4);
    expect(metrics.criticalTables).toBe(1);
    expect(metrics.totalDeadTuples).toBe(900);
    expect(metrics.totalEstimatedBloatBytes).toBeGreaterThan(0);
  });

  it("computes success rate and average duration from attempts only", () => {
    const tracker = new VacuumRunTracker();
    for (const [name, success, durationMs] of [
      ["a", true, 100],
      ["b", true, 300],
      ["c", false, 0],
    ] as const) {
      tracker.recordAttempt({
        runId: "run-1",
        qualifiedName: name,
        success,
        durationMs,
        at: "2026-01-01T00:00:00.000Z",
      });
    }

    const metrics = computeMetrics(tracker);
    expect(metrics.vacuumAttempts).toBe(3);
    expect(metrics.vacuumsSucceeded).toBe(2);
    expect(metrics.vacuumsFailed).toBe(1);
    expect(metrics.vacuumSuccessRate).toBeCloseTo(0.6667, 4);
    // Average is over successful attempts only: (100 + 300) / 2.
    expect(metrics.avgVacuumDurationMs).toBe(200);
  });

  it("aggregates run counters across runs", () => {
    const tracker = new VacuumRunTracker();
    const base = {
      durationMs: 1000,
      tablesScanned: 20,
      tablesOverThreshold: 4,
      vacuumsTriggered: 2,
      vacuumsSkipped: 1,
      vacuumsFailed: 1,
      alertsRaised: 4,
    };
    tracker.recordRun({ runId: "run-1", at: "2026-01-01T00:01:00.000Z", ...base });
    tracker.recordRun({ runId: "run-2", at: "2026-01-01T00:02:00.000Z", ...base });

    const metrics = computeMetrics(tracker);
    expect(metrics.runs).toBe(2);
    expect(metrics.tablesScanned).toBe(20);
    expect(metrics.tablesOverThreshold).toBe(4);
    expect(metrics.vacuumsSkipped).toBe(2);
    expect(metrics.alertsRaised).toBe(8);
    expect(metrics.lastRunAt).toBe("2026-01-01T00:02:00.000Z");
  });

  it("passes through the suppressed alert count", () => {
    const metrics = computeMetrics(new VacuumRunTracker(), { alertsSuppressed: 12 });
    expect(metrics.alertsSuppressed).toBe(12);
  });
});

describe("summaryToRecords", () => {
  it("flattens every outcome into an audit record", () => {
    const records = summaryToRecords(makeSummary());
    expect(records).toHaveLength(3);
    expect(records.map((r) => r.outcome).sort()).toEqual(["failed", "skipped", "vacuumed"]);

    const skipped = records.find((r) => r.outcome === "skipped");
    expect(skipped?.reason).toBe("deferred");
    const failed = records.find((r) => r.outcome === "failed");
    expect(failed?.reason).toBe("lock timeout");
    expect(records.every((r) => r.runId === "run-1")).toBe(true);
  });

  it("returns nothing for a run with no actions", () => {
    expect(
      summaryToRecords(makeSummary({ vacuumed: [], skipped: [], failed: [] })),
    ).toHaveLength(0);
  });
});
