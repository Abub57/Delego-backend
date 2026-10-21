/**
 * Table bloat statistics collection.
 * Issue #382 — Automated Database Vacuum and Bloat Monitoring Worker.
 *
 * The primary source is `pg_stat_user_tables`, which reports the estimated
 * `n_live_tup` / `n_dead_tup` per user table. We join on `pg_class` for
 * autovacuum settings and on `pg_statio_user_tables` / `pg_stat_user_indexes`
 * for index sizes and scan counts, so index-level bloat signals come back in
 * the same round trip as the heap counters.
 */
import type { IndexBloatStats, TableBloatStats } from "@delegolabs/types";

/** Schemas the worker refuses to inspect or vacuum. */
export const RESERVED_SCHEMAS: readonly string[] = [
  "pg_catalog",
  "information_schema",
  "pg_toast",
];

/** Matches any system/internal schema (`pg_*`, `pg_temp_*`). */
export const INTERNAL_SCHEMA_PATTERN = /^pg_|^pg_temp_/;

export interface StatsQueryOptions {
  /**
   * Schemas to inspect. Defaults to every non-system user schema.
   * `pg_stat_user_tables` already excludes system catalogs.
   */
  schemas?: string[];
  /** Skip tables smaller than this many bytes. */
  minTableSizeBytes?: number;
  /** Skip tables with fewer live rows than this. */
  minLiveTuples?: number;
  /** Cap on returned rows; 0 disables the limit. */
  limit?: number;
}

/**
 * Builds the bloat scan query. Parameters are positional (`$1`, `$2`, ...) so
 * the caller never has to interpolate identifiers or user input into SQL.
 */
export function buildBloatStatsQuery(options: StatsQueryOptions = {}): {
  text: string;
  values: unknown[];
} {
  const values: unknown[] = [];
  const params: string[] = [];
  const push = (value: unknown): string => {
    values.push(value);
    params.push(`$${values.length}`);
    return params[params.length - 1];
  };

  const filters: string[] = [
    // pg_stat_user_tables is already restricted to user tables, but the
    // additional guard keeps the query safe if it is ever pointed elsewhere.
    "s.schemaname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')",
    "s.schemaname !~ '^pg_'",
  ];

  if (options.schemas && options.schemas.length > 0) {
    filters.push(`s.schemaname = ANY(${push(options.schemas)}::text[])`);
  }
  if (options.minTableSizeBytes !== undefined) {
    filters.push(`pg_table_size(s.relid) >= ${push(options.minTableSizeBytes)}`);
  }
  if (options.minLiveTuples !== undefined) {
    filters.push(`s.n_live_tup >= ${push(options.minLiveTuples)}`);
  }

  const base = `
    SELECT
      s.schemaname,
      s.relname,
      s.n_live_tup,
      s.n_dead_tup,
      s.n_mod_since_analyze,
      s.last_vacuum,
      s.last_autovacuum,
      s.last_analyze,
      s.last_autoanalyze,
      pg_table_size(s.relid) AS total_size_bytes,
      pg_indexes_size(s.relid) AS index_size_bytes,
      COALESCE(
        NOT ('autovacuum_enabled=off' = ANY(COALESCE(c.reloptions, '{}'::text[]))),
        TRUE
      ) AS autovacuum_enabled,
      COALESCE(
        (
          SELECT json_agg(
            json_build_object(
              'indexname', ix.indexrelname,
              'indexSizeBytes', pg_relation_size(ix.indexrelid),
              'idxScan', COALESCE(st.idx_scan, 0),
              'idxTupRead', COALESCE(st.idx_tup_read, 0)
            )
          )
          FROM pg_stat_user_indexes ix
          JOIN pg_index i ON i.indexrelid = ix.indexrelid
          LEFT JOIN pg_statio_user_indexes st
            ON st.indexrelid = ix.indexrelid AND st.schemaname = ix.schemaname AND st.relname = ix.relname
          WHERE ix.relid = s.relid
        ),
        '[]'::json
      ) AS indexes
    FROM pg_stat_user_tables s
    JOIN pg_class c ON c.oid = s.relid
    WHERE ${filters.join("\n      AND ")}
    ORDER BY s.n_dead_tup DESC, pg_table_size(s.relid) DESC
  `;

  const withoutTrailingSemicolon = base.trimEnd().replace(/;$/, "");
  const limitClause = options.limit && options.limit > 0
    ? ` LIMIT ${push(options.limit)}`
    : "";

  return { text: `${withoutTrailingSemicolon}${limitClause};`, values };
}

/** A `pg`-compatible query surface, so tests can pass a plain object. */
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
}

/**
 * Coerces a `bigint` column into a JS number.
 *
 * node-postgres returns `int8` (OID 20) as a *string* by default to avoid
 * precision loss, so `n_dead_tup` arrives as `"12000"` rather than `12000`.
 * Every numeric field is normalized here so downstream arithmetic is correct.
 */
export function toNumber(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "boolean") return value ? 1 : 0;
  const parsed = typeof value === "string" ? Number(value.trim()) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function toTimestamp(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  const text = String(value).trim();
  if (text === "") return null;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function normalizeIndexes(raw: unknown): IndexBloatStats[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === "object")
    .map((entry) => ({
      indexname: String(entry.indexname ?? ""),
      indexSizeBytes: toNumber(entry.indexSizeBytes),
      idxScan: toNumber(entry.idxScan),
      idxTupRead: toNumber(entry.idxTupRead),
    }))
    .filter((index) => index.indexname !== "");
}

/** Maps a raw `pg` row to a {@link TableBloatStats} record. */
export function normalizeStatsRow(row: Record<string, unknown>): TableBloatStats {
  return {
    schemaname: String(row.schemaname ?? ""),
    relname: String(row.relname ?? ""),
    n_live_tup: toNumber(row.n_live_tup),
    n_dead_tup: toNumber(row.n_dead_tup),
    n_mod_since_analyze: toNumber(row.n_mod_since_analyze),
    totalSizeBytes: toNumber(row.total_size_bytes ?? row.totalSizeBytes),
    indexSizeBytes: toNumber(row.index_size_bytes ?? row.indexSizeBytes),
    indexes: normalizeIndexes(row.indexes),
    lastVacuum: toTimestamp(row.last_vacuum),
    lastAutovacuum: toTimestamp(row.last_autovacuum),
    lastAnalyze: toTimestamp(row.last_analyze),
    lastAutoanalyze: toTimestamp(row.last_autoanalyze),
    autovacuumEnabled: row.autovacuum_enabled === undefined
      ? true
      : Boolean(row.autovacuum_enabled),
  };
}

/** Fetches and normalizes bloat statistics for every candidate table. */
export async function fetchTableBloatStats(
  db: Queryable,
  options: StatsQueryOptions = {},
): Promise<TableBloatStats[]> {
  const { text, values } = buildBloatStatsQuery(options);
  const result = await db.query(text, values);
  return (result.rows ?? []).map((row) => normalizeStatsRow(row));
}

/**
 * True when a table sits in a schema the worker must never touch.
 * Used to keep a misconfigured schema allowlist from reaching system objects.
 */
export function isReservedSchema(schema: string): boolean {
  return RESERVED_SCHEMAS.includes(schema) || INTERNAL_SCHEMA_PATTERN.test(schema);
}
