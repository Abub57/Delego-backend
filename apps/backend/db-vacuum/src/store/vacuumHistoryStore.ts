/**
 * Durable audit trail of vacuum runs.
 * Issue #382 — Automated Database Vacuum and Bloat Monitoring Worker.
 *
 * The in-memory store is the default so the service and its tests run without
 * a database; the PostgreSQL store persists to `db_vacuum_run_log` (see
 * `database/migrations/040_db_vacuum_run_log.sql`).
 */
import type { VacuumRunRecord, VacuumRunSummary } from "@delegolabs/types";
import type { Queryable } from "../bloat/statsQuery.js";
import { summaryToRecords } from "../monitor/metrics.js";

export interface VacuumHistoryStore {
  record(summary: VacuumRunSummary): Promise<VacuumRunRecord[]>;
  list(limit?: number): Promise<VacuumRunRecord[]>;
}

export class InMemoryVacuumHistoryStore implements VacuumHistoryStore {
  private readonly records: VacuumRunRecord[] = [];

  async record(summary: VacuumRunSummary): Promise<VacuumRunRecord[]> {
    const entries = summaryToRecords(summary);
    this.records.push(...entries);
    return entries;
  }

  async list(limit = 100): Promise<VacuumRunRecord[]> {
    return this.records.slice(-limit).reverse();
  }
}

export class PostgresVacuumHistoryStore implements VacuumHistoryStore {
  constructor(private readonly db: Queryable) {}

  async record(summary: VacuumRunSummary): Promise<VacuumRunRecord[]> {
    const entries = summaryToRecords(summary);
    for (const entry of entries) {
      await this.db.query(
        `INSERT INTO db_vacuum_run_log
           (run_id, qualified_name, outcome, severity, dead_tuple_ratio,
            estimated_bloat_bytes, duration_ms, reason, recorded_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          entry.runId,
          entry.qualifiedName,
          entry.outcome,
          entry.severity,
          entry.deadTupleRatio,
          entry.estimatedBloatBytes,
          entry.durationMs,
          entry.reason ?? null,
          entry.at,
        ],
      );
    }
    return entries;
  }

  async list(limit = 100): Promise<VacuumRunRecord[]> {
    const result = await this.db.query(
      `SELECT run_id, qualified_name, outcome, severity, dead_tuple_ratio,
              estimated_bloat_bytes, duration_ms, reason, recorded_at
         FROM db_vacuum_run_log
        ORDER BY recorded_at DESC
        LIMIT $1`,
      [limit],
    );
    return (result.rows ?? []).map((row: any) => ({
      runId: String(row.run_id),
      qualifiedName: String(row.qualified_name),
      outcome: row.outcome,
      severity: row.severity,
      deadTupleRatio: Number(row.dead_tuple_ratio ?? 0),
      estimatedBloatBytes: Number(row.estimated_bloat_bytes ?? 0),
      durationMs: Number(row.duration_ms ?? 0),
      reason: row.reason ?? undefined,
      at: new Date(row.recorded_at).toISOString(),
    }));
  }
}
