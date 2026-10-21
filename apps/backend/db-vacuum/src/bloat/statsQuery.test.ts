import { describe, expect, it } from "vitest";
import {
  buildBloatStatsQuery,
  fetchTableBloatStats,
  isReservedSchema,
  normalizeStatsRow,
  toNumber,
} from "./statsQuery.js";

describe("buildBloatStatsQuery", () => {
  it("reads the documented dead/live tuple columns from pg_stat_user_tables", () => {
    const { text } = buildBloatStatsQuery();
    expect(text).toContain("FROM pg_stat_user_tables");
    expect(text).toMatch(/s\.n_dead_tup/);
    expect(text).toMatch(/s\.n_live_tup/);
    expect(text).toMatch(/s\.schemaname/);
    expect(text).toMatch(/s\.relname/);
  });

  it("returns no parameters when no filters are configured", () => {
    expect(buildBloatStatsQuery().values).toEqual([]);
  });

  it("binds filters as positional parameters rather than interpolating them", () => {
    const { text, values } = buildBloatStatsQuery({
      schemas: ["public", "billing"],
      minTableSizeBytes: 1024,
      minLiveTuples: 5,
    });
    expect(values).toEqual([["public", "billing"], 1024, 5]);
    expect(text).toContain("$1::text[]");
    expect(text).toContain(">= $2");
    expect(text).toContain(">= $3");
    // A schema named with SQL metacharacters must never reach the text.
    expect(text).not.toContain("public', 'billing");
  });

  it("excludes system schemas unconditionally", () => {
    const { text } = buildBloatStatsQuery();
    expect(text).toContain("s.schemaname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')");
    expect(text).toContain("s.schemaname !~ '^pg_'");
  });

  it("appends a limit only when requested", () => {
    expect(buildBloatStatsQuery().text).not.toContain("LIMIT");
    expect(buildBloatStatsQuery({ limit: 0 }).text).not.toContain("LIMIT");
    const limited = buildBloatStatsQuery({ limit: 10 });
    expect(limited.text).toContain("LIMIT $1");
    expect(limited.values).toEqual([10]);
  });

  it("always terminates the statement with a single semicolon", () => {
    for (const opts of [{}, { limit: 5 }]) {
      const { text } = buildBloatStatsQuery(opts);
      expect(text.trimEnd().endsWith(";")).toBe(true);
      expect(text.split(";").length).toBe(2);
    }
  });
});

describe("toNumber", () => {
  it("coerces the bigint strings node-postgres returns", () => {
    // node-pg returns int8 columns as strings; arithmetic on them silently
    // coerces to NaN if this is missed.
    expect(toNumber("12000")).toBe(12000);
    expect(toNumber(12000)).toBe(12000);
    expect(toNumber(null)).toBe(0);
    expect(toNumber(undefined)).toBe(0);
  });

  it("falls back to zero for unparseable values", () => {
    expect(toNumber("not-a-number")).toBe(0);
    expect(toNumber("")).toBe(0);
    expect(toNumber(Number.NaN)).toBe(0);
    expect(toNumber(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("normalizeStatsRow", () => {
  it("normalizes a full pg row, including index json", () => {
    const row = normalizeStatsRow({
      schemaname: "public",
      relname: "orders",
      n_live_tup: "1000",
      n_dead_tup: "500",
      n_mod_since_analyze: "12",
      total_size_bytes: "1048576",
      index_size_bytes: "262144",
      last_vacuum: "2026-01-01 00:00:00+00",
      last_autovacuum: null,
      last_analyze: null,
      last_autoanalyze: "2026-01-02 00:00:00+00",
      autovacuum_enabled: true,
      indexes: [
        { indexname: "orders_pkey", indexSizeBytes: "16384", idxScan: "42", idxTupRead: "7" },
      ],
    });

    expect(row.n_live_tup).toBe(1000);
    expect(row.n_dead_tup).toBe(500);
    expect(row.n_mod_since_analyze).toBe(12);
    expect(row.indexes[0]?.idxScan).toBe(42);
    expect(row.lastVacuum).toBe("2026-01-01T00:00:00.000Z");
    expect(row.lastAutovacuum).toBeNull();
  });

  it("defaults autovacuum_enabled to true and tolerates missing columns", () => {
    const row = normalizeStatsRow({ schemaname: "public", relname: "t" });
    expect(row.autovacuumEnabled).toBe(true);
    expect(row.indexes).toEqual([]);
    expect(row.lastAnalyze).toBeNull();
  });

  it("drops malformed index entries instead of throwing", () => {
    const row = normalizeStatsRow({
      schemaname: "public",
      relname: "t",
      indexes: [null, "nope", { indexSizeBytes: 10 }, { indexname: "ok", indexSizeBytes: "5" }],
    });
    expect(row.indexes).toEqual([{ indexname: "ok", indexSizeBytes: 5, idxScan: 0, idxTupRead: 0 }]);
  });
});

describe("fetchTableBloatStats", () => {
  it("queries with bound values and maps the rows", async () => {
    const calls: Array<{ text: string; values?: unknown[] }> = [];
    const db = {
      async query(text: string, values?: unknown[]) {
        calls.push({ text, values });
        return { rows: [{ schemaname: "public", relname: "orders", n_dead_tup: "10" }] };
      },
    };

    const stats = await fetchTableBloatStats(db, { schemas: ["public"] });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.values).toEqual([["public"]]);
    expect(stats).toHaveLength(1);
    expect(stats[0]?.relname).toBe("orders");
    expect(stats[0]?.n_dead_tup).toBe(10);
  });

  it("returns an empty list when the database reports no rows", async () => {
    const db = { async query() { return { rows: [] }; } };
    expect(await fetchTableBloatStats(db)).toEqual([]);
  });
});

describe("isReservedSchema", () => {
  it("identifies system schemas", () => {
    expect(isReservedSchema("pg_catalog")).toBe(true);
    expect(isReservedSchema("information_schema")).toBe(true);
    expect(isReservedSchema("pg_toast")).toBe(true);
    expect(isReservedSchema("pg_temp_3")).toBe(true);
  });

  it("allows ordinary user schemas", () => {
    expect(isReservedSchema("public")).toBe(false);
    expect(isReservedSchema("billing")).toBe(false);
  });
});
