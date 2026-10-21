import { describe, expect, it } from "vitest";
import type { Logger } from "@delegolabs/utils";
import type { TableBloatStats } from "@delegolabs/types";
import { DeduplicatingAlertRouter, RecordingAlertSink } from "./alerts/alertSink.js";
import { RecordingVacuumExecutor } from "./vacuum/executor.js";
import { InMemoryVacuumHistoryStore } from "./store/vacuumHistoryStore.js";
import { DatabaseVacuumService, VacuumRunInProgressError } from "./service.js";

const MB = 1024 * 1024;
const GB = 1024 * MB;

const silentLog: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

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

function bloated(overrides: Partial<TableBloatStats> = {}): TableBloatStats {
  return stats({ n_live_tup: 400, n_dead_tup: 600, ...overrides });
}

interface HarnessOptions {
  tables?: TableBloatStats[];
  dryRun?: boolean;
  maxTablesPerRun?: number;
  skipAutovacuumDisabled?: boolean;
  skipIfVacuumRunning?: boolean;
  scanError?: Error;
  history?: InMemoryVacuumHistoryStore;
}

function makeService(options: HarnessOptions = {}) {
  const sink = new RecordingAlertSink();
  const executor = new RecordingVacuumExecutor();
  const history = options.history ?? new InMemoryVacuumHistoryStore();
  const scanner = {
    scan: async () => {
      if (options.scanError) throw options.scanError;
      return options.tables ?? [];
    },
  };
  const service = new DatabaseVacuumService({
    scanner,
    executor,
    history,
    alertRouter: new DeduplicatingAlertRouter(sink, { now: () => new Date("2026-01-01T00:00:00Z") }),
    dryRun: options.dryRun,
    maxTablesPerRun: options.maxTablesPerRun,
    skipAutovacuumDisabled: options.skipAutovacuumDisabled,
    skipIfVacuumRunning: options.skipIfVacuumRunning,
    log: silentLog,
  });
  return { service, sink, executor, history };
}

describe("DatabaseVacuumService.runOnce", () => {
  it("leaves healthy tables alone", async () => {
    const { service, executor, sink } = makeService({
      tables: [stats({ n_live_tup: 1000, n_dead_tup: 0 })],
    });

    const summary = await service.runOnce();

    expect(summary.tablesScanned).toBe(1);
    expect(summary.tablesOverThreshold).toBe(0);
    expect(summary.vacuumed).toEqual([]);
    expect(executor.calls).toHaveLength(0);
    expect(sink.alerts).toHaveLength(0);
  });

  it("vacuums a bloated table and reports it", async () => {
    const { service, executor } = makeService({ tables: [bloated()] });

    const summary = await service.runOnce();

    expect(summary.tablesOverThreshold).toBe(1);
    expect(summary.vacuumed).toEqual(["public.orders"]);
    expect(executor.calls).toHaveLength(1);
    expect(executor.calls[0]?.target).toEqual({ schema: "public", table: "orders" });
  });

  it("raises an alert when dead tuples exceed the threshold", async () => {
    const { service, sink } = makeService({ tables: [bloated()] });

    await service.runOnce();

    const alert = sink.byRule("dead_tuples")[0];
    expect(alert).toBeDefined();
    expect(alert?.qualifiedName).toBe("public.orders");
    expect(alert?.severity).toBe("critical");
    expect(summaryAlerts(sink)).toBe(1);
  });

  it("suppresses repeat alerts on the next run", async () => {
    const { service, sink } = makeService({ tables: [bloated()] });

    const first = await service.runOnce();
    const second = await service.runOnce();

    expect(first.alertsRaised).toBeGreaterThan(0);
    expect(second.alertsRaised).toBe(0);
    expect(summaryAlerts(sink)).toBe(first.alertsRaised);
  });

  it("vacuums the worst offender first", async () => {
    const { service, executor } = makeService({
      tables: [
        stats({ relname: "mild", n_live_tup: 800, n_dead_tup: 200 }),
        stats({ relname: "worst", n_live_tup: 100, n_dead_tup: 900 }),
      ],
    });

    await service.runOnce();

    expect(executor.calls[0]?.target.table).toBe("worst");
  });

  it("skips a table that is already being vacuumed", async () => {
    const { service, executor } = makeService({ tables: [bloated()] });
    (executor as RecordingVacuumExecutor).setVacuumInProgress("public.orders");

    const summary = await service.runOnce();

    expect(executor.calls).toHaveLength(0);
    expect(summary.vacuumed).toEqual([]);
    expect(summary.skipped[0]?.reason).toContain("already running");
  });

  it("can be told not to check for in-flight vacuums", async () => {
    const { service, executor } = makeService({
      tables: [bloated()],
      skipIfVacuumRunning: false,
    });
    (executor as RecordingVacuumExecutor).setVacuumInProgress("public.orders");

    const summary = await service.runOnce();

    expect(summary.vacuumed).toEqual(["public.orders"]);
  });

  it("skips a table whose autovacuum is disabled by default", async () => {
    const { service } = makeService({
      tables: [bloated({ autovacuumEnabled: false })],
    });

    const summary = await service.runOnce();

    expect(summary.vacuumed).toEqual([]);
    expect(summary.skipped[0]?.reason).toContain("autovacuum is disabled");
  });

  it("can be told to vacuum tables with autovacuum disabled", async () => {
    const { service } = makeService({
      tables: [bloated({ autovacuumEnabled: false })],
      skipAutovacuumDisabled: false,
    });

    expect((await service.runOnce()).vacuumed).toEqual(["public.orders"]);
  });

  it("records a failure without aborting the rest of the run", async () => {
    const { service, executor } = makeService({
      tables: [
        stats({ relname: "a", n_live_tup: 100, n_dead_tup: 900 }),
        stats({ relname: "b", n_live_tup: 400, n_dead_tup: 600 }),
      ],
    });
    (executor as RecordingVacuumExecutor).failNext("public.a", "could not obtain lock");

    const summary = await service.runOnce();

    expect(summary.failed).toEqual([{ qualifiedName: "public.a", reason: "could not obtain lock" }]);
    expect(summary.vacuumed).toEqual(["public.b"]);
  });

  it("caps the number of vacuums per run and defers the rest", async () => {
    const { service, executor } = makeService({
      tables: [
        stats({ relname: "a", n_live_tup: 100, n_dead_tup: 900 }),
        stats({ relname: "b", n_live_tup: 200, n_dead_tup: 800 }),
        stats({ relname: "c", n_live_tup: 300, n_dead_tup: 700 }),
      ],
      maxTablesPerRun: 2,
    });

    const summary = await service.runOnce();

    expect(executor.calls).toHaveLength(2);
    expect(summary.tablesOverThreshold).toBe(3);
    expect(summary.vacuumed.sort()).toEqual(["public.a", "public.b"]);
    expect(summary.skipped[0]?.reason).toContain("deferred");
  });

  it("issues no statements in dry run mode", async () => {
    const { service, executor, sink } = makeService({ tables: [bloated()], dryRun: true });

    const summary = await service.runOnce();

    expect(summary.dryRun).toBe(true);
    expect(summary.vacuumed).toEqual([]);
    expect(executor.calls).toHaveLength(0);
    // Assessment and alerting still happen in dry run.
    expect(summary.tablesOverThreshold).toBe(1);
    expect(sink.byRule("dead_tuples")).toHaveLength(1);
    expect(summary.skipped[0]?.reason).toContain("dry run");
  });

  it("reports the run in the summary", async () => {
    const { service } = makeService({ tables: [bloated()] });
    const summary = await service.runOnce();

    expect(summary.runId).toContain("db-vacuum-");
    expect(Date.parse(summary.startedAt)).not.toBeNaN();
    expect(Date.parse(summary.finishedAt)).not.toBeNaN();
    expect(summary.durationMs).toBeGreaterThanOrEqual(0);
    expect(service.lastRun()).toEqual(summary);
  });

  it("refuses to overlap runs", async () => {
    const { service } = makeService({ tables: [bloated()] });
    const first = service.runOnce();
    await expect(service.runOnce()).rejects.toThrow(VacuumRunInProgressError);
    await first;
  });

  it("records history for the run", async () => {
    const { service, history } = makeService({ tables: [bloated()] });
    await service.runOnce();

    const records = await service.runHistory();
    expect(records).toHaveLength(1);
    expect(records[0]?.outcome).toBe("vacuumed");
    expect(records[0]?.qualifiedName).toBe("public.orders");
  });

  it("does not fail the run when history persistence fails", async () => {
    const history = new InMemoryVacuumHistoryStore();
    history.record = async () => {
      throw new Error("connection reset");
    };
    const { service } = makeService({ tables: [bloated()], history });

    const summary = await service.runOnce();
    expect(summary.vacuumed).toEqual(["public.orders"]);
  });

  it("surfaces a scan failure to the caller", async () => {
    const { service } = makeService({ scanError: new Error("connection terminated") });
    await expect(service.runOnce()).rejects.toThrow("connection terminated");
  });

  it("stays usable after a failed run", async () => {
    const { service } = makeService({ scanError: new Error("boom") });
    await expect(service.runOnce()).rejects.toThrow("boom");
    // The in-progress guard is released in a finally block.
    const second = service.runOnce();
    await expect(second).rejects.toThrow("boom");
  });
});

describe("DatabaseVacuumService.scan", () => {
  it("classifies without vacuuming or alerting", async () => {
    const { service, executor, sink } = makeService({ tables: [bloated()] });

    const assessments = await service.scan();

    expect(assessments).toHaveLength(1);
    expect(assessments[0]?.exceedsThreshold).toBe(true);
    expect(executor.calls).toHaveLength(0);
    expect(sink.alerts).toHaveLength(0);
  });
});

describe("DatabaseVacuumService.metrics", () => {
  it("exposes worker metrics after a run", async () => {
    const { service } = makeService({
      tables: [bloated(), stats({ relname: "items", n_live_tup: 1000, n_dead_tup: 0 })],
    });

    await service.runOnce();
    const metrics = service.metrics();

    expect(metrics.runs).toBe(1);
    expect(metrics.tablesScanned).toBe(2);
    expect(metrics.vacuumAttempts).toBe(1);
    expect(metrics.vacuumsSucceeded).toBe(1);
    expect(metrics.vacuumSuccessRate).toBe(1);
    expect(metrics.worstTable).toBe("public.orders");
    expect(metrics.criticalTables).toBe(1);
    expect(metrics.lastRunAt).not.toBeNull();
  });

  it("counts suppressed alerts", async () => {
    const { service } = makeService({ tables: [bloated()] });
    await service.runOnce();
    await service.runOnce();
    expect(service.metrics().alertsSuppressed).toBeGreaterThan(0);
  });
});

describe("DatabaseVacuumService.config", () => {
  it("exposes the effective configuration", () => {
    const { service } = makeService({ dryRun: true, maxTablesPerRun: 2 });
    const config = service.config();

    expect(config.dryRun).toBe(true);
    expect(config.maxTablesPerRun).toBe(2);
    expect(config.serviceName).toBe("db-vacuum");
    expect(config.thresholds.deadTupleRatio).toBeGreaterThan(0);
  });
});

function summaryAlerts(sink: RecordingAlertSink): number {
  return sink.alerts.length;
}
