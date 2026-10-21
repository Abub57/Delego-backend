/**
 * Postgres-backed store for the audit log (Issue #66).
 *
 * Query-builder style, matching `../softDelete/softDeleteTable.ts`: every
 * function takes a `Queryable` (matches `pg.Pool` / `pg.PoolClient` /
 * `pg.Client`) and plain SQL, rather than going through an ORM — this
 * codebase talks to Postgres directly via `pg` for the same kind of
 * cross-cutting infra concern (see `paymentRecordStore.ts`).
 *
 * The `audit_log` table itself is append-only at the DB level (see
 * `database/migrations/025_audit_log.sql`'s triggers) — this module never
 * issues an UPDATE or DELETE against it.
 */
import type {
  AuditLogEntry,
  AuditLogEntryInput,
  AuditOperation,
  AuditQuery,
  AuditQueryResult,
  Queryable,
} from "./types.js";
import { computeEntryHash } from "./hashChain.js";
import { dispatchAuditLogEntry } from "./cefExporter.js";

export class AuditLogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditLogError";
  }
}

interface AuditLogRow extends Record<string, unknown> {
  id: string;
  sequence_num: string | number;
  table_name: string;
  record_id: string;
  operation: string;
  user_id: string | null;
  session_id: string | null;
  ip_address: string | null;
  user_agent: string | null;
  old_values: Record<string, unknown> | null;
  new_values: Record<string, unknown> | null;
  changed_fields: string[];
  occurred_at: Date | string;
  transaction_id: string;
  prev_hash: string | null;
  entry_hash: string;
}

function mapRow(row: AuditLogRow): AuditLogEntry {
  return {
    id: row.id,
    // pg returns BIGINT/BIGSERIAL columns as strings by default (to avoid
    // silent precision loss above Number.MAX_SAFE_INTEGER); Number() is
    // safe here in practice — audit_log would need ~9 quadrillion rows
    // before sequence_num could exceed MAX_SAFE_INTEGER.
    sequenceNum: Number(row.sequence_num),
    tableName: row.table_name,
    recordId: row.record_id,
    operation: row.operation as AuditOperation,
    userId: row.user_id,
    sessionId: row.session_id,
    ipAddress: row.ip_address,
    userAgent: row.user_agent,
    oldValues: row.old_values,
    newValues: row.new_values,
    changedFields: row.changed_fields ?? [],
    occurredAt: row.occurred_at instanceof Date ? row.occurred_at : new Date(row.occurred_at),
    transactionId: row.transaction_id,
    prevHash: row.prev_hash,
    entryHash: row.entry_hash,
  };
}

/**
 * Derive `changedFields` from old/new values when the caller didn't supply
 * it explicitly: keys present in either object whose values differ
 * (via JSON comparison — good enough for the plain-JSON audit payloads
 * this module deals with; not intended for exotic types like Map/Set).
 */
function deriveChangedFields(
  oldValues: Record<string, unknown> | null,
  newValues: Record<string, unknown> | null
): string[] {
  const keys = new Set([...Object.keys(oldValues ?? {}), ...Object.keys(newValues ?? {})]);
  const changed: string[] = [];
  for (const key of keys) {
    const oldVal = oldValues?.[key];
    const newVal = newValues?.[key];
    if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) changed.push(key);
  }
  return changed.sort();
}

/**
 * Fetch the `entry_hash` of the most recent audit_log row (by
 * `sequence_num`, the authoritative chain-order key — see the migration's
 * comment on why not `occurred_at`/`id`), or null if the table is empty
 * (this will be the first entry in the chain).
 *
 * Note: under concurrent writers this read-then-insert has a race — two
 * concurrent `recordAuditEntry` calls could both read the same "latest"
 * hash and insert siblings rather than a strict chain. The DB-level
 * immutability trigger still guarantees no entry is ever altered/removed
 * after the fact, so tamper evidence holds; a fully serialized chain
 * would need a DB-side sequence/trigger to compute entry_hash instead of
 * computing it in application code. Documented as a known limitation
 * rather than solved here — see docs/deployment/audit-log-siem-retention.md.
 */
async function getLatestEntryHash(db: Queryable): Promise<string | null> {
  const result = await db.query<{ entry_hash: string }>(
    `SELECT entry_hash FROM audit_log ORDER BY sequence_num DESC LIMIT 1`
  );
  return result.rows[0]?.entry_hash ?? null;
}

/**
 * Append one entry to the audit log, computing its hash chain fields
 * (`prevHash`/`entryHash`) against the current tail of the chain.
 */
export async function recordAuditEntry(
  db: Queryable,
  input: AuditLogEntryInput
): Promise<AuditLogEntry> {
  if (!input.tableName.trim()) throw new AuditLogError("tableName is required");
  if (!input.recordId.trim()) throw new AuditLogError("recordId is required");
  if (!input.transactionId.trim()) throw new AuditLogError("transactionId is required");

  const occurredAt = new Date();
  const changedFields =
    input.changedFields ?? deriveChangedFields(input.oldValues ?? null, input.newValues ?? null);
  const prevHash = await getLatestEntryHash(db);

  const entryHash = computeEntryHash(
    {
      tableName: input.tableName,
      recordId: input.recordId,
      operation: input.operation,
      userId: input.userId ?? null,
      sessionId: input.sessionId ?? null,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
      oldValues: input.oldValues ?? null,
      newValues: input.newValues ?? null,
      changedFields,
      occurredAt,
      transactionId: input.transactionId,
    },
    prevHash
  );

  const result = await db.query<AuditLogRow>(
    `INSERT INTO audit_log (
       table_name, record_id, operation, user_id, session_id, ip_address,
       user_agent, old_values, new_values, changed_fields, occurred_at,
       transaction_id, prev_hash, entry_hash
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     RETURNING *`,
    [
      input.tableName,
      input.recordId,
      input.operation,
      input.userId ?? null,
      input.sessionId ?? null,
      input.ipAddress ?? null,
      input.userAgent ?? null,
      input.oldValues ?? null,
      input.newValues ?? null,
      changedFields,
      occurredAt,
      input.transactionId,
      prevHash,
      entryHash,
    ]
  );

  const entry = mapRow(result.rows[0]);
  dispatchAuditLogEntry(entry);
  return entry;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * Query the audit log with filtering and cursor-based pagination
 * (Issue #66's `AuditQuery`/query API). `cursor` is the `id` of the last
 * entry from a previous page; results are strictly after (or before, for
 * `sort: "asc"`) that entry in `sequence_num` order — the same
 * authoritative ordering the hash chain uses, so pagination order matches
 * chain order (see the migration's comment on why not `occurred_at`).
 */
export async function queryAuditLog(db: Queryable, query: AuditQuery): Promise<AuditQueryResult> {
  const limit = Math.min(query.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const sort = query.sort ?? "desc";
  const conditions: string[] = [];
  const values: unknown[] = [];

  const addCondition = (fragment: string, value: unknown) => {
    values.push(value);
    conditions.push(fragment.replace("$N", `$${values.length}`));
  };

  if (query.tableName) addCondition("table_name = $N", query.tableName);
  if (query.recordId) addCondition("record_id = $N", query.recordId);
  if (query.operation) addCondition("operation = $N", query.operation);
  if (query.userId) addCondition("user_id = $N", query.userId);
  if (query.from) addCondition("occurred_at >= $N", query.from);
  if (query.to) addCondition("occurred_at <= $N", query.to);

  if (query.cursor) {
    const cursorRow = await db.query<{ sequence_num: string | number }>(
      `SELECT sequence_num FROM audit_log WHERE id = $1`,
      [query.cursor]
    );
    const cursorEntry = cursorRow.rows[0];
    if (cursorEntry) {
      const op = sort === "asc" ? ">" : "<";
      addCondition(`sequence_num ${op} $N`, cursorEntry.sequence_num);
    }
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const orderClause = sort === "asc" ? "sequence_num ASC" : "sequence_num DESC";

  values.push(limit + 1);
  const result = await db.query<AuditLogRow>(
    `SELECT * FROM audit_log ${whereClause} ORDER BY ${orderClause} LIMIT $${values.length}`,
    values
  );

  const hasMore = result.rows.length > limit;
  const rows = hasMore ? result.rows.slice(0, limit) : result.rows;
  const entries = rows.map(mapRow);
  const nextCursor = hasMore ? entries[entries.length - 1].id : null;

  return { entries, nextCursor };
}

/**
 * Fetch entries for hash-chain verification, ordered oldest-first by
 * `sequence_num` (required by `verifyChain`, and the same authoritative
 * order `recordAuditEntry` chains against). Optionally scoped to a single
 * table's entries interleaved with the rest of the chain is NOT supported
 * here — the chain is global across all tables (see migration comment),
 * so verification always walks the full chain or a contiguous window of
 * it, never a single table's subset (that would skip links and look like
 * tampering).
 *
 * `afterSequenceNum` lets a caller page through the chain without loading
 * it all at once — the returned rows are still strictly `sequence_num`
 * ascending and contiguous from the given point, so a paged walk
 * (`verifyStoredChain`) never skips a link.
 */
export async function getChainSegment(
  db: Queryable,
  opts: { from?: Date; to?: Date; limit?: number; afterSequenceNum?: number } = {}
): Promise<AuditLogEntry[]> {
  const conditions: string[] = [];
  const values: unknown[] = [];

  const addCondition = (fragment: string, value: unknown) => {
    values.push(value);
    conditions.push(fragment.replace("$N", `$${values.length}`));
  };

  if (opts.from) addCondition("occurred_at >= $N", opts.from);
  if (opts.to) addCondition("occurred_at <= $N", opts.to);
  if (opts.afterSequenceNum !== undefined) {
    addCondition("sequence_num > $N", opts.afterSequenceNum);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = opts.limit ?? 10_000;
  values.push(limit);

  const result = await db.query<AuditLogRow>(
    `SELECT * FROM audit_log ${whereClause} ORDER BY sequence_num ASC LIMIT $${values.length}`,
    values
  );

  return result.rows.map(mapRow);
}
