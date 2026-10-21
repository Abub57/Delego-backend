/**
 * Streaming transaction-history query streams — Issue #395.
 *
 * Provides keyset-paginated row streams straight off the database connection
 * so that exporting 100k+ rows never loads the whole result set into memory.
 * Each page returns at most `pageSize` raw rows (`raw: true` — plain objects,
 * no Sequelize model hydration); the row stream holds one page in memory at a
 * time and only fetches the next page after the current one is fully consumed,
 * so HTTP backpressure throttles DB reads.
 */
import { sequelize } from "../db.js";
import { createPagedRowStream } from "../services/csvExportService.js";
import type { FetchPage, PagedRowStreamOptions } from "../services/csvExportService.js";

/** Raw notification_events record shape used for CSV export rows. */
export interface NotificationEventExportRow {
  id: string;
  notification_id: string;
  user_id: string | null;
  template_id: string;
  channel: string;
  event_type: string;
  timestamp: Date;
  revenue: string | null;
  created_at: Date;
}

export interface TransactionHistoryFilter {
  userId?: string;
  templateId?: string;
  channel?: string;
  eventType?: string;
  /** ISO-8601 lower bound on `timestamp` (inclusive). */
  periodStart?: string;
  /** ISO-8601 upper bound on `timestamp` (inclusive). */
  periodEnd?: string;
}

export interface TransactionHistoryStreamOptions extends PagedRowStreamOptions {
  /** Optional export filters applied in SQL, not in Node. */
  filters?: TransactionHistoryFilter;
  /** Hard cap on exported rows as a safety valve (default: unlimited). */
  maxRows?: number;
}

/** Export column list — mirrors NotificationEventExportRow field order. */
const EXPORT_COLUMNS = [
  "id",
  "notification_id",
  "user_id",
  "template_id",
  "channel",
  "event_type",
  "timestamp",
  "revenue",
  "created_at",
] as const;

export const TRANSACTION_HISTORY_CSV_HEADERS: ReadonlyArray<string> = EXPORT_COLUMNS;

/**
 * Build the parameterized WHERE fragment and replacement values for the
 * optional export filters. All values are bound via Sequelize `replacements`,
 * never interpolated — consistent with the repo's parameterized-query policy.
 */
function buildFilterWhere(
  filters: TransactionHistoryFilter | undefined,
): { sql: string; replacements: Record<string, unknown> } {
  const conditions: string[] = [];
  const replacements: Record<string, unknown> = {};

  if (filters) {
    if (filters.userId) {
      conditions.push("user_id = :userId");
      replacements.userId = filters.userId;
    }
    if (filters.templateId) {
      conditions.push("template_id = :templateId");
      replacements.templateId = filters.templateId;
    }
    if (filters.channel) {
      conditions.push("channel = :channel");
      replacements.channel = filters.channel;
    }
    if (filters.eventType) {
      conditions.push("event_type = :eventType");
      replacements.eventType = filters.eventType;
    }
    if (filters.periodStart) {
      conditions.push("timestamp >= :periodStart");
      replacements.periodStart = new Date(filters.periodStart);
    }
    if (filters.periodEnd) {
      conditions.push("timestamp <= :periodEnd");
      replacements.periodEnd = new Date(filters.periodEnd);
    }
  }

  return {
    sql: conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "",
    replacements,
  };
}

/**
 * Create a FetchPage over `notification_events` ordered by `id ASC`
 * (keyset pagination: `WHERE id > :cursorId`).
 */
export function createTransactionHistoryFetchPage(
  filters?: TransactionHistoryFilter,
): FetchPage {
  const { sql: whereSql, replacements: filterReplacements } = buildFilterWhere(filters);

  return async (cursor: unknown | null, limit: number): Promise<ReadonlyArray<unknown>> => {
    const cursorId = cursor !== null && typeof cursor === "object" && "id" in (cursor as Record<string, unknown>)
      ? (cursor as { id: string }).id
      : null;

    const conditions = [...(whereSql ? [whereSql.replace(/^WHERE\s+/i, "")] : [])];
    if (cursorId !== null) {
      conditions.push("id > :cursorId");
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const replacements: Record<string, unknown> = { ...filterReplacements, limit };
    if (cursorId !== null) {
      replacements.cursorId = cursorId;
    }

    // raw: true → plain objects (no model instances), minimal per-row overhead.
    const rows = await sequelize.query(
      `SELECT ${EXPORT_COLUMNS.join(", ")}
       FROM notification_events
       ${whereClause}
       ORDER BY id ASC
       LIMIT :limit`,
      { replacements, raw: true },
    );

    return rows as ReadonlyArray<unknown>;
  };
}

/**
 * Create a Readable stream of raw `notification_events` rows ordered by `id`,
 * suitable as input for `streamCsvExport`.
 */
export function createTransactionHistoryRowStream(options: TransactionHistoryStreamOptions = {}) {
  return createPagedRowStream(
    createTransactionHistoryFetchPage(options.filters),
    options,
  );
}
