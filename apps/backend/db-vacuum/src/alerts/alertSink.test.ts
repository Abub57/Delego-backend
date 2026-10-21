import { describe, expect, it } from "vitest";
import type { BloatAlert, TableBloatStats } from "@delegolabs/types";
import { assessTable } from "../bloat/assessment.js";
import {
  buildAlerts,
  DeduplicatingAlertRouter,
  fingerprintFor,
  LoggingAlertSink,
  RecordingAlertSink,
} from "./alertSink.js";

const MB = 1024 * 1024;
const GB = 1024 * MB;

function stats(overrides: Partial<TableBloatStats> = {}): TableBloatStats {
  return {
    schemaname: "public",
    relname: "orders",
    n_live_tup: 500,
    n_dead_tup: 500,
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

function alert(overrides: Partial<BloatAlert> = {}): BloatAlert {
  return {
    id: "a1",
    fingerprint: fingerprintFor("dead_tuples", "public.orders"),
    rule: "dead_tuples",
    severity: "high",
    service: "db-vacuum",
    title: "t",
    message: "m",
    qualifiedName: "public.orders",
    deadTupleRatio: 0.5,
    estimatedBloatBytes: 0,
    raisedAt: "2026-01-01T00:00:00.000Z",
    labels: {},
    ...overrides,
  };
}

describe("fingerprintFor", () => {
  it("is stable and distinct per rule and table", () => {
    expect(fingerprintFor("dead_tuples", "public.orders")).toBe(
      fingerprintFor("dead_tuples", "public.orders"),
    );
    expect(fingerprintFor("dead_tuples", "public.orders")).not.toBe(
      fingerprintFor("unused_index", "public.orders"),
    );
    expect(fingerprintFor("dead_tuples", "public.orders")).not.toBe(
      fingerprintFor("dead_tuples", "public.items"),
    );
  });
});

describe("buildAlerts", () => {
  it("raises a dead-tuples alert only above the threshold", () => {
    const bloated = assessTable(stats());
    const healthy = assessTable(stats({ n_live_tup: 990, n_dead_tup: 10 }));

    const alerts = buildAlerts([bloated, healthy]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.rule).toBe("dead_tuples");
    // 500 dead of 1000 rows is a 50% ratio: critical.
    expect(alerts[0]?.severity).toBe("critical");
    expect(alerts[0]?.qualifiedName).toBe("public.orders");
    expect(alerts[0]?.message).toContain("dead tuples");
  });

  it("does not raise a bytes alert for a small amount of waste", () => {
    const alerts = buildAlerts([assessTable(stats())]);
    expect(alerts.filter((a) => a.rule === "bloat_bytes")).toHaveLength(0);
  });

  it("raises a bytes alert when the absolute waste is large", () => {
    // 20% dead on a 100GB table: ~20GB reclaimable.
    const big = assessTable(
      stats({ n_live_tup: 800, n_dead_tup: 200, totalSizeBytes: 100 * GB }),
    );
    const alerts = buildAlerts([big]);
    const bytesAlert = alerts.find((a) => a.rule === "bloat_bytes");
    expect(bytesAlert).toBeDefined();
    expect(bytesAlert?.estimatedBloatBytes).toBeGreaterThan(5 * GB);
  });

  it("honours a custom bytes threshold", () => {
    const bloated = assessTable(stats());
    const alerts = buildAlerts([bloated], { bloatBytesThreshold: 1 });
    expect(alerts.filter((a) => a.rule === "bloat_bytes")).toHaveLength(1);
  });

  it("raises a low-severity advisory for unused indexes", () => {
    const withUnused = assessTable(
      stats({
        indexes: [
          { indexname: "orders_old_idx", indexSizeBytes: 8 * MB, idxScan: 0, idxTupRead: 0 },
        ],
      }),
    );
    const alerts = buildAlerts([withUnused]);
    const advisory = alerts.find((a) => a.rule === "unused_index");
    expect(advisory?.severity).toBe("low");
    expect(advisory?.message).toContain("orders_old_idx");
    // The worker reports unused indexes; it never drops them.
    expect(advisory?.message).toContain("never drops indexes");
  });

  it("labels alerts for routing", () => {
    const alerts = buildAlerts([assessTable(stats())], { service: "custom-service" });
    expect(alerts[0]?.service).toBe("custom-service");
    expect(alerts[0]?.labels.table).toBe("public.orders");
    expect(alerts[0]?.labels.schema).toBe("public");
  });

  it("uses the injected clock and id factory", () => {
    const now = new Date("2026-03-04T05:06:07.000Z");
    const alerts = buildAlerts([assessTable(stats())], { now, idFactory: () => "fixed-id" });
    expect(alerts[0]?.raisedAt).toBe(now.toISOString());
    expect(alerts[0]?.id).toBe("fixed-id");
  });

  it("returns no alerts for an empty scan", () => {
    expect(buildAlerts([])).toEqual([]);
  });
});

describe("DeduplicatingAlertRouter", () => {
  function makeRouter(cooldownMs = 1000) {
    const sink = new RecordingAlertSink();
    let now = new Date("2026-01-01T00:00:00.000Z").getTime();
    const router = new DeduplicatingAlertRouter(sink, {
      cooldownMs,
      now: () => new Date(now),
      service: "db-vacuum",
    });
    return {
      sink,
      router,
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  it("emits the first alert and suppresses the repeat inside the window", () => {
    const { sink, router, advance } = makeRouter(1000);

    expect(router.raise(alert())).toBe(true);
    advance(500);
    expect(router.raise(alert())).toBe(false);
    expect(sink.alerts).toHaveLength(1);
    expect(router.suppressed()).toBe(1);
  });

  it("re-emits once the cooldown has elapsed", () => {
    const { sink, router, advance } = makeRouter(1000);

    router.raise(alert());
    advance(999);
    router.raise(alert());
    advance(1);
    expect(router.raise(alert())).toBe(true);
    expect(sink.alerts).toHaveLength(2);
  });

  it("deduplicates per fingerprint, not per table", () => {
    const { sink, router } = makeRouter(1000);
    router.raise(alert());
    router.raise(alert({ fingerprint: fingerprintFor("unused_index", "public.orders") }));
    expect(sink.alerts).toHaveLength(2);
  });

  it("raiseAll returns only the alerts that were emitted", () => {
    const { router } = makeRouter(1000);
    // The first is new and the third has a different fingerprint, so both go
    // out; the repeat of the first is suppressed.
    const emitted = router.raiseAll([alert(), alert(), alert({ fingerprint: "other" })]);
    expect(emitted).toHaveLength(2);
  });

  it("fills in default service and timestamps", () => {
    const sink = new RecordingAlertSink();
    const router = new DeduplicatingAlertRouter(sink, {
      now: () => new Date("2026-05-05T00:00:00.000Z"),
    });
    router.raise({
      ...alert(),
      id: "",
      service: "",
      raisedAt: "",
      labels: undefined as unknown as Record<string, string>,
    });
    expect(sink.alerts[0]?.service).toBe("db-vacuum");
    expect(sink.alerts[0]?.raisedAt).toBe("2026-05-05T00:00:00.000Z");
    expect(sink.alerts[0]?.id).not.toBe("");
    expect(sink.alerts[0]?.labels).toEqual({});
  });

  it("reset clears cooldown state", () => {
    const { sink, router } = makeRouter(1000);
    router.raise(alert());
    router.reset();
    expect(router.suppressed()).toBe(0);
    router.raise(alert());
    expect(sink.alerts).toHaveLength(2);
  });
});

describe("LoggingAlertSink", () => {
  it("writes a structured warning per alert", () => {
    const lines: Array<{ message: string; meta?: Record<string, unknown> }> = [];
    const sink = new LoggingAlertSink({
      warn: (message, meta) => lines.push({ message, meta }),
    });

    sink.emit(alert());

    expect(lines).toHaveLength(1);
    expect(lines[0]?.message).toBe("database bloat alert");
    expect(lines[0]?.meta?.table).toBe("public.orders");
    expect(lines[0]?.meta?.rule).toBe("dead_tuples");
  });
});

describe("RecordingAlertSink", () => {
  it("filters captured alerts by rule", () => {
    const sink = new RecordingAlertSink();
    sink.emit(alert());
    sink.emit(alert({ rule: "unused_index" }));
    expect(sink.byRule("unused_index")).toHaveLength(1);

    sink.clear();
    expect(sink.alerts).toHaveLength(0);
  });
});
