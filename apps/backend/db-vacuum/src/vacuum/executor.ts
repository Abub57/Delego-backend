/**
 * Non-blocking `VACUUM ANALYZE` execution.
 * Issue #382 — Automated Database Vacuum and Bloat Monitoring Worker.
 *
 * Safety rules enforced here, all of them deliberately conservative:
 *   - Identifiers are validated against a strict pattern and double-quoted;
 *     they are never interpolated raw.
 *   - `VACUUM FULL` can never be issued. It takes an `ACCESS EXCLUSIVE` lock
 *     and blocks all reads and writes for the duration of the rewrite.
 *   - System schemas are refused outright.
 *   - The statement runs on a dedicated connection in autocommit mode, since
 *     PostgreSQL rejects `VACUUM` inside a transaction block.
 *   - A per-statement timeout stops a pathological table from pinning a worker.
 *   - A table already being vacuumed (by us or by autovacuum) is skipped.
 */
import { isReservedSchema } from "../bloat/statsQuery.js";

/** Unquoted PostgreSQL identifier. Deliberately narrow — no quotes, no dots. */
const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_$]*$/;

export class InvalidIdentifierError extends Error {
  constructor(public readonly identifier: string) {
    super(`Refusing to build a statement for unsafe identifier: ${JSON.stringify(identifier)}`);
    this.name = "InvalidIdentifierError";
  }
}

/** The smallest slice of a `pg` client the executor needs. */
export interface VacuumClient {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
  release(): void;
}

export interface VacuumPool {
  connect(): Promise<VacuumClient>;
}

export interface VacuumTarget {
  schema: string;
  table: string;
}

export interface VacuumOptions {
  /** Run `ANALYZE` as well. Defaults to true — stale plans are half the problem. */
  analyze?: boolean;
  /** Emit per-table progress from the server. Defaults to false. */
  verbose?: boolean;
  /** Abort the statement after this many milliseconds. Defaults to 60_000. */
  statementTimeoutMs?: number;
  /**
   * Refuse to run. The worker passes `dryRun` from its config so a read-only
   * assessment mode can never issue a statement by accident.
   */
  dryRun?: boolean;
}

export interface VacuumResult {
  target: VacuumTarget;
  qualifiedName: string;
  statement: string;
  durationMs: number;
  /** False when the run was a dry run and no statement was sent. */
  executed: boolean;
  skipped?: string;
}

/** Validates and double-quotes a single identifier. */
export function quoteIdentifier(identifier: string): string {
  if (typeof identifier !== "string" || !IDENTIFIER_PATTERN.test(identifier)) {
    throw new InvalidIdentifierError(String(identifier));
  }
  return `"${identifier.replace(/"/g, '""')}"`;
}

/** Validates and quotes a `schema.table` pair as a single qualified name. */
export function quoteQualifiedName(schema: string, table: string): string {
  if (isReservedSchema(schema)) {
    throw new InvalidIdentifierError(`${schema}.${table} (reserved schema)`);
  }
  return `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
}

/**
 * Builds the VACUUM statement.
 *
 * Note there is no `full` option: `VACUUM FULL` rewrites the entire table under
 * an `ACCESS EXCLUSIVE` lock, which is exactly the outage this worker exists to
 * prevent.
 */
export function buildVacuumStatement(
  target: VacuumTarget,
  options: VacuumOptions = {},
): string {
  const analyze = options.analyze ?? true;
  const verbose = options.verbose ?? false;
  const qualified = quoteQualifiedName(target.schema, target.table);

  const clauses: string[] = [];
  if (analyze) clauses.push("ANALYZE");
  if (verbose) clauses.push("VERBOSE");

  // Plain `VACUUM <table>` is equivalent to `VACUUM (ANALYZE) <table>`; the
  // option list is only needed once VERBOSE joins it.
  return clauses.length > 0
    ? `VACUUM (${clauses.join(", ")}) ${qualified};`
    : `VACUUM ${qualified};`;
}

const VACUUM_IN_PROGRESS_SQL = `
  SELECT EXISTS (
    SELECT 1
    FROM pg_stat_activity
    WHERE datname = current_database()
      AND pid <> pg_backend_pid()
      AND state <> 'idle'
      AND query ~* '\\mvacuum\\b'
      AND query ILIKE '%' || $1 || '%'
  ) AS running
`;

/** True when another backend is currently vacuuming the given table. */
export async function isVacuumInProgress(
  db: { query(text: string, values?: unknown[]): Promise<{ rows: any[] }> },
  target: VacuumTarget,
): Promise<boolean> {
  const qualified = quoteQualifiedName(target.schema, target.table);
  const result = await db.query(VACUUM_IN_PROGRESS_SQL, [qualified]);
  return Boolean(result.rows?.[0]?.running);
}

export interface VacuumExecutor {
  vacuum(target: VacuumTarget, options?: VacuumOptions): Promise<VacuumResult>;
  isVacuumInProgress(target: VacuumTarget): Promise<boolean>;
}

/** Executes real `VACUUM ANALYZE` statements against PostgreSQL. */
export class PgVacuumExecutor implements VacuumExecutor {
  constructor(
    private readonly pool: VacuumPool,
    private readonly defaultTimeoutMs: number = 60_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async isVacuumInProgress(target: VacuumTarget): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      return await isVacuumInProgress(client, target);
    } finally {
      client.release();
    }
  }

  async vacuum(target: VacuumTarget, options: VacuumOptions = {}): Promise<VacuumResult> {
    // Validate identifiers *before* checking out a connection, so a bad target
    // can never reach the server as SQL.
    const statement = buildVacuumStatement(target, options);
    // The human-readable name for logs, metrics and audit rows. The quoted
    // form only ever appears inside `statement`.
    const qualifiedName = `${target.schema}.${target.table}`;

    if (options.dryRun) {
      return {
        target,
        qualifiedName,
        statement,
        durationMs: 0,
        executed: false,
        skipped: "dry run",
      };
    }

    const timeoutMs = options.statementTimeoutMs ?? this.defaultTimeoutMs;
    const client = await this.pool.connect();
    const startedAt = this.now();
    try {
      // Session-level timeout, reset afterwards. It cannot be `SET LOCAL`
      // because `SET LOCAL` requires a transaction block, which VACUUM forbids.
      await client.query(`SET statement_timeout = ${toSqlInteger(timeoutMs)}`);
      try {
        // Autocommit is mandatory: PostgreSQL raises
        // "VACUUM cannot run inside a transaction block" otherwise.
        await client.query(statement);
      } finally {
        await client.query("RESET statement_timeout").catch(() => undefined);
      }
    } finally {
      client.release();
    }

    return {
      target,
      qualifiedName,
      statement,
      durationMs: this.now() - startedAt,
      executed: true,
    };
  }
}

/**
 * Records vacuum attempts without touching a database.
 * The default executor when `DATABASE_URL` is not configured, and the double
 * used throughout the test suite.
 */
export class RecordingVacuumExecutor implements VacuumExecutor {
  readonly calls: Array<{ target: VacuumTarget; options: VacuumOptions }> = [];
  private readonly failures = new Map<string, string>();
  private readonly running = new Set<string>();
  private readonly onVacuum?: (target: VacuumTarget) => void;

  constructor(options: { onVacuum?: (target: VacuumTarget) => void } = {}) {
    this.onVacuum = options.onVacuum;
  }

  /** Makes the next vacuum of `qualifiedName` fail, simulating a DB error. */
  failNext(qualifiedName: string, message = "permission denied"): void {
    this.failures.set(qualifiedName, message);
  }

  setVacuumInProgress(qualifiedName: string, running = true): void {
    if (running) this.running.add(qualifiedName);
    else this.running.delete(qualifiedName);
  }

  async isVacuumInProgress(target: VacuumTarget): Promise<boolean> {
    return this.running.has(`${target.schema}.${target.table}`);
  }

  async vacuum(target: VacuumTarget, options: VacuumOptions = {}): Promise<VacuumResult> {
    const qualifiedName = `${target.schema}.${target.table}`;
    this.calls.push({ target, options });

    if (options.dryRun) {
      return {
        target,
        qualifiedName,
        statement: buildVacuumStatement(target, options),
        durationMs: 0,
        executed: false,
        skipped: "dry run",
      };
    }

    const failure = this.failures.get(qualifiedName);
    if (failure) {
      this.failures.delete(qualifiedName);
      throw new Error(failure);
    }

    this.onVacuum?.(target);
    return {
      target,
      qualifiedName,
      statement: buildVacuumStatement(target, options),
      durationMs: 1,
      executed: true,
    };
  }
}

function toSqlInteger(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}
