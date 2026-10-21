import { describe, expect, it } from "vitest";
import type { TableBloatStats } from "@delegolabs/types";
import { assessTable, assessTables, DEFAULT_THRESHOLDS, isMoreSevere } from "./assessment.js";

const MB = 1024 * 1024;

function makeStats(overrides: Partial<TableBloatStats> = {}): TableBloatStats {
  return {
    schemaname: "public",
    relname: "orders",
    n_live_tup: 1_000,
    n_dead_tup: 100,
    n_mod_since_analyze: 0,
    totalSizeBytes: 100 * MB,
    indexSizeBytes: 10 * MB,
    indexes: [],
    lastVacuum: null,
    lastAutovacuum: null,
    lastAnalyze: null,
    lastAutoanalyze: null,
    autovacuumEnabled: true,
    ...overrides,
  };
}

describe("assessTable", () => {
  it("computes the dead tuple ratio from live and dead counts", () => {
    const result = assessTable(makeStats({ n_live_tup: 750, n_dead_tup: 250 }));
    expect(result.deadTupleRatio).toBeCloseTo(0.25, 5);
    expect(result.deadTuples).toBe(250);
    expect(result.liveTuples).toBe(750);
    expect(result.qualifiedName).toBe("public.orders");
  });

  it("treats a table with no rows as having zero bloat", () => {
    const result = assessTable(makeStats({ n_live_tup: 0, n_dead_tup: 0 }));
    expect(result.deadTupleRatio).toBe(0);
    expect(result.estimatedBloatBytes).toBe(0);
    expect(result.bloatRatio).toBe(0);
    expect(result.exceedsThreshold).toBe(false);
    expect(result.severity).toBe("none");
  });

  it("crosses the threshold on ratio alone", () => {
    const result = assessTable(makeStats({ n_live_tup: 800, n_dead_tup: 200 }));
    expect(result.deadTupleRatio).toBeCloseTo(0.2, 5);
    expect(result.exceedsThreshold).toBe(true);
    expect(result.severity).toBe("low");
  });

  it("crosses the threshold on absolute dead tuple count even at a low ratio", () => {
    // A very large table creeps up slowly: 2% dead, but 100k dead tuples.
    const result = assessTable(
      makeStats({ n_live_tup: 4_900_000, n_dead_tup: 100_000, totalSizeBytes: 5_000 * MB }),
    );
    expect(result.deadTupleRatio).toBeLessThan(DEFAULT_THRESHOLDS.deadTupleRatio);
    expect(result.deadTuples).toBeGreaterThanOrEqual(DEFAULT_THRESHOLDS.deadTupleCount);
    expect(result.exceedsThreshold).toBe(true);
    expect(result.reasons.join(" ")).toContain("dead tuple count");
  });

  it("ignores tables below the minimum size", () => {
    const result = assessTable(
      makeStats({ n_dead_tup: 100_000, n_live_tup: 1, totalSizeBytes: 1024 }),
    );
    expect(result.exceedsThreshold).toBe(false);
    expect(result.reasons.join(" ")).toContain("below the");
  });

  it("maps ratios onto the severity ladder", () => {
    const cases: Array<[number, string]> = [
      [0.05, "none"],
      [0.2, "low"],
      [0.3, "medium"],
      [0.4, "high"],
      [0.6, "critical"],
    ];
    for (const [deadShare, expected] of cases) {
      const live = Math.round(1000 * (1 - deadShare));
      const dead = 1000 - live;
      const result = assessTable(makeStats({ n_live_tup: live, n_dead_tup: dead }));
      expect(result.severity, `ratio ~${deadShare}`).toBe(expected);
    }
  });

  it("escalates severity when the absolute reclaimable bytes are severe", () => {
    // 20% dead, but on a 100GB table: 20GB wasted, which bumps "low" up a step.
    const result = assessTable(
      makeStats({ n_live_tup: 800, n_dead_tup: 200, totalSizeBytes: 100 * 1024 * MB }),
    );
    expect(result.deadTupleRatio).toBeCloseTo(0.2, 5);
    expect(result.severity).toBe("medium");
    expect(result.reasons.join(" ")).toContain("escalation");
  });

  it("does not escalate a small table with the same ratio", () => {
    const result = assessTable(makeStats({ n_live_tup: 800, n_dead_tup: 200 }));
    expect(result.severity).toBe("low");
    expect(result.reasons.join(" ")).not.toContain("escalation");
  });

  it("estimates reclaimable bytes from mean tuple width", () => {
    const result = assessTable(
      makeStats({ n_live_tup: 500, n_dead_tup: 500, totalSizeBytes: 1000 * MB }),
    );
    // 1000 tuples over 1000MB => 1MB per tuple; 500 dead => 500MB reclaimable.
    expect(result.estimatedBloatBytes).toBe(500 * MB);
    expect(result.bloatRatio).toBeCloseTo(0.5, 5);
  });

  it("never vacuums a reserved schema", () => {
    const result = assessTable(
      makeStats({ schemaname: "pg_catalog", n_dead_tup: 1_000_000, n_live_tup: 1 }),
    );
    expect(result.exceedsThreshold).toBe(false);
    expect(result.severity).toBe("none");
    expect(result.reasons.join(" ")).toContain("reserved");
  });

  it("reports unused indexes above the size floor and ignores small ones", () => {
    const result = assessTable(
      makeStats({
        indexes: [
          { indexname: "big_unused", indexSizeBytes: 8 * MB, idxScan: 0, idxTupRead: 0 },
          { indexname: "small_unused", indexSizeBytes: 1024, idxScan: 0, idxTupRead: 0 },
          { indexname: "used", indexSizeBytes: 8 * MB, idxScan: 99, idxTupRead: 0 },
        ],
      }),
    );
    expect(result.unusedIndexes.map((i) => i.indexname)).toEqual(["big_unused"]);
    expect(result.reasons.join(" ")).toContain("zero scans");
  });

  it("notes that ANALYZE is needed when rows changed since the last one", () => {
    const result = assessTable(makeStats({ n_mod_since_analyze: 42 }));
    expect(result.reasons.join(" ")).toContain("since last analyze");
  });

  it("surfaces a table with autovacuum disabled without dropping the verdict", () => {
    const result = assessTable(makeStats({ n_live_tup: 500, n_dead_tup: 500, autovacuumEnabled: false }));
    expect(result.exceedsThreshold).toBe(true);
    expect(result.reasons.join(" ")).toContain("autovacuum is disabled");
  });

  it("honours overridden thresholds", () => {
    const stats = makeStats({ n_live_tup: 990, n_dead_tup: 10, totalSizeBytes: 1 });
    expect(assessTable(stats).exceedsThreshold).toBe(false);
    expect(
      assessTable(stats, { thresholds: { minTableSizeBytes: 0, deadTupleRatio: 0.001 } })
        .exceedsThreshold,
    ).toBe(true);
  });
});

describe("assessTables", () => {
  it("returns assessments ordered worst-first", () => {
    const results = assessTables([
      makeStats({ relname: "healthy", n_live_tup: 990, n_dead_tup: 10 }),
      makeStats({ relname: "worst", n_live_tup: 100, n_dead_tup: 900 }),
      makeStats({ relname: "middle", n_live_tup: 500, n_dead_tup: 500 }),
    ]);
    expect(results.map((r) => r.table)).toEqual(["worst", "middle", "healthy"]);
  });
});

describe("isMoreSevere", () => {
  it("orders severities", () => {
    expect(isMoreSevere("critical", "high")).toBe(true);
    expect(isMoreSevere("low", "none")).toBe(true);
    expect(isMoreSevere("none", "low")).toBe(false);
    expect(isMoreSevere("high", "high")).toBe(false);
  });
});
