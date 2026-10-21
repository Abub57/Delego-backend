/**
 * Integration coverage (Issue #382): bloat detection -> threshold
 * classification -> real non-blocking VACUUM ANALYZE against live Postgres.
 *
 * The unit suite drives all of this through injected doubles, so what it cannot
 * prove is the part that actually matters here: that the query in
 * `src/bloat/statsQuery.ts` parses and returns the columns we expect from a
 * live `pg_stat_user_tables`, and that the statement built by
 * `src/vacuum/executor.ts` is accepted by a real server and actually reclaims
 * dead tuples.
 *
 * Requires the compiled db-vacuum build (dist/) and a reachable Postgres;
 * skips itself otherwise.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { isPostgresReachable, isServiceBuilt, uniqueId } from "./helpers/infra.js";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://delego:delego@localhost:5432/delego";

const dbAvailable = await isPostgresReachable();
if (!dbAvailable) {
  console.log(
    "[tests] Skipping db-vacuum bloat integration tests — no PostgreSQL reachable (start it with 'docker compose up -d postgres')",
  );
}

const serviceBuilt = isServiceBuilt("db-vacuum");
if (dbAvailable && !serviceBuilt) {
  console.log(
    "[tests] Skipping db-vacuum bloat integration tests — apps/backend/db-vacuum/dist not found (run `pnpm --filter @delegolabs/db-vacuum build` first)",
  );
}

const suite = dbAvailable && serviceBuilt ? describe : describe.skip;

const SCHEMA = uniqueId("vacuum_it");

/**
 * Polls until `check` returns a truthy value. The statistics collector writes
 * its shared-memory snapshot asynchronously, so n_dead_tup / n_live_tup lag
 * the DML that caused them by a few hundred milliseconds.
 */
async function eventually(check, { timeoutMs = 10_000, intervalMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await check();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return last;
}

suite("database bloat detection and VACUUM ANALYZE against real Postgres (#382)", () => {
  let pool;
  let client;
  let PgBloatScanner;
  let assessTables;
  let PgVacuumExecutor;
  let buildVacuumStatement;
  let RecordingVacuumExecutor;
  let DatabaseVacuumService;
  let DeduplicatingAlertRouter;
  let RecordingAlertSink;
  let InMemoryVacuumHistoryStore;

  const table = `${SCHEMA}_orders`;

  before(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    const bloat = await import("../../../apps/backend/db-vacuum/dist/src/bloat/statsQuery.js");
    const assessment = await import(
      "../../../apps/backend/db-vacuum/dist/src/bloat/assessment.js"
    );
    const executor = await import("../../../apps/backend/db-vacuum/dist/src/vacuum/executor.js");
    const service = await import("../../../apps/backend/db-vacuum/dist/src/service.js");
    const alerts = await import("../../../apps/backend/db-vacuum/dist/src/alerts/alertSink.js");
    const history = await import(
      "../../../apps/backend/db-vacuum/dist/src/store/vacuumHistoryStore.js"
    );

    ({ PgBloatScanner } = bloat);
    ({ assessTables } = assessment);
    ({ PgVacuumExecutor, RecordingVacuumExecutor, buildVacuumStatement } = executor);
    ({ DatabaseVacuumService } = service);
    ({ DeduplicatingAlertRouter, RecordingAlertSink } = alerts);
    ({ InMemoryVacuumHistoryStore } = history);

    // A dedicated client so we can drive DDL and VACUUM outside any pool reuse.
    client = await pool.connect();
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA}"`);
    await client.query(`DROP TABLE IF EXISTS "${SCHEMA}"."${table}"`);
    await client.query(
      `CREATE TABLE "${SCHEMA}"."${table}" (id BIGSERIAL PRIMARY KEY, payload TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
    );
  });

  after(async () => {
    if (client) {
      await client.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`).catch(() => {});
      client.release();
    }
    if (pool) await pool.end();
  });

  /** Churns the table so that most of its rows are dead. */
  async function churnTable({ live = 50, dead = 20_000 } = {}) {
    const { rows } = await client.query(
      `INSERT INTO "${SCHEMA}"."${table}" (payload)
       SELECT md5(g::text) FROM generate_series(1, $1) g`,
      [live + dead],
    );
    await client.query(
      `DELETE FROM "${SCHEMA}"."${table}" WHERE id <= $1`,
      [rows[0].id - live],
    );
    // ANALYZE refreshes the planner statistics; n_dead_tup itself comes from
    // the stats collector, which we poll for below.
    await client.query(`ANALYZE "${SCHEMA}"."${table}"`);
  }

  it("scans pg_stat_user_tables and returns the documented dead/live tuple columns", async () => {
    const scanner = new PgBloatScanner(pool);
    const stats = await scanner.scan();
    const row = stats.find((s) => s.schemaname === SCHEMA && s.relname === table);

    assert.ok(row, `expected ${SCHEMA}.${table} in the scan`);
    // Types are normalized to numbers, not the strings node-postgres returns
    // for int8 columns.
    assert.equal(typeof row.n_live_tup, "number");
    assert.equal(typeof row.n_dead_tup, "number");
    assert.equal(typeof row.totalSizeBytes, "number");
    assert.ok(row.totalSizeBytes > 0);
    assert.ok(Array.isArray(row.indexes));
    assert.equal(row.autovacuumEnabled, true);
  });

  it("classifies a churned table as over the dead-tuple threshold", async () => {
    await churnTable();

    const scanner = new PgBloatScanner(pool);
    const stats = await eventually(async () => {
      const found = (await scanner.scan()).find(
        (s) => s.schemaname === SCHEMA && s.relname === table,
      );
      return found && found.n_dead_tup > 0 ? found : null;
    });

    assert.ok(stats, "expected the collector to report dead tuples");
    assert.ok(stats.n_dead_tup > stats.n_live_tup);

    // minTableSizeBytes is lowered because the fixture table is far smaller
    // than the 10MB production default; everything else is the real default.
    const [assessment] = assessTables([stats], { thresholds: { minTableSizeBytes: 0 } });
    assert.equal(assessment.exceedsThreshold, true);
    assert.ok(assessment.deadTupleRatio > 0.5);
    assert.ok(assessment.estimatedBloatBytes > 0);
  });

  it("never reports a system schema as a vacuum candidate", async () => {
    const scanner = new PgBloatScanner(pool);
    const stats = await scanner.scan();
    assert.ok(stats.length > 0);
    for (const s of stats) {
      assert.ok(!s.schemaname.startsWith("pg_"));
      assert.notEqual(s.schemaname, "information_schema");
    }
  });

  it("issues a VACUUM ANALYZE the server accepts, and reclaims the dead tuples", async () => {
    await churnTable();

    const executor = new PgVacuumExecutor(pool, 30_000);
    const target = { schema: SCHEMA, table };
    const statement = buildVacuumStatement(target);
    assert.equal(statement, `VACUUM (ANALYZE) "${SCHEMA}"."${table}";`);
    assert.doesNotMatch(statement, /FULL/i);

    const result = await executor.vacuum(target);
    assert.equal(result.executed, true);
    assert.equal(result.qualifiedName, `${SCHEMA}.${table}`);
    assert.ok(result.durationMs >= 0);

    // The real proof: the collector's dead-tuple count drops back to zero.
    const scanner = new PgBloatScanner(pool);
    const after = await eventually(async () => {
      const found = (await scanner.scan()).find(
        (s) => s.schemaname === SCHEMA && s.relname === table,
      );
      return found && found.n_dead_tup === 0 ? found : null;
    }, { timeoutMs: 15_000 });

    assert.ok(after, "expected dead tuples to be reclaimed by VACUUM");
    assert.equal(after.n_dead_tup, 0);
    assert.ok(after.n_live_tup > 0);
  });

  it("refuses to build a statement for a system schema", async () => {
    const executor = new PgVacuumExecutor(pool);
    await assert.rejects(
      () => executor.vacuum({ schema: "pg_catalog", table: "pg_class" }),
      /unsafe identifier/,
    );
  });

  it("runs the full worker pass and records history", async () => {
    await churnTable();

    const sink = new RecordingAlertSink();
    const history = new InMemoryVacuumHistoryStore();
    const executor = new PgVacuumExecutor(pool, 30_000);
    const service = new DatabaseVacuumService({
      scanner: new PgBloatScanner(pool),
      executor,
      history,
      alertRouter: new DeduplicatingAlertRouter(sink),
      thresholds: { minTableSizeBytes: 0, deadTupleRatio: 0.2, deadTupleCount: 1000 },
      // The pool is a drop-in VacuumPool, but the guard below is exercised
      // through the recording executor in the unit suite.
      skipIfVacuumRunning: false,
      maxTablesPerRun: 10,
    });

    const summary = await service.runOnce();

    assert.ok(summary.tablesScanned > 0);
    const target = `${SCHEMA}.${table}`;
    assert.ok(
      summary.tablesOverThreshold > 0,
      `expected ${target} to be over the threshold`,
    );
    assert.ok(summary.vacuumed.includes(target));
    assert.equal(summary.failed.length, 0);
    assert.ok(summary.alertsRaised > 0);
    assert.equal(sink.byRule("dead_tuples").length > 0, true);

    const records = await service.runHistory();
    assert.ok(records.some((r) => r.qualifiedName === target && r.outcome === "vacuumed"));

    const metrics = service.metrics();
    assert.equal(metrics.runs, 1);
    assert.ok(metrics.vacuumAttempts > 0);
    assert.equal(metrics.vacuumsFailed, 0);
  });

  it("does not execute anything in dry run mode", async () => {
    await churnTable();

    const executor = new RecordingVacuumExecutor();
    const service = new DatabaseVacuumService({
      scanner: new PgBloatScanner(pool),
      executor,
      alertRouter: new DeduplicatingAlertRouter(new RecordingAlertSink()),
      thresholds: { minTableSizeBytes: 0, deadTupleRatio: 0.2, deadTupleCount: 1000 },
      dryRun: true,
    });

    const before = await new PgBloatScanner(pool).scan();
    const beforeDead = before.find((s) => s.schemaname === SCHEMA && s.relname === table)
      ?.n_dead_tup;

    const summary = await service.runOnce();

    assert.equal(summary.dryRun, true);
    assert.equal(executor.calls.length, 0);
    assert.ok(summary.skipped.some((s) => s.reason.includes("dry run")));

    const after = await new PgBloatScanner(pool).scan();
    const afterDead = after.find((s) => s.schemaname === SCHEMA && s.relname === table)
      ?.n_dead_tup;
    assert.equal(afterDead, beforeDead, "a dry run must not reclaim anything");
  });
});
