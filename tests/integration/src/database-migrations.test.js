import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const MIGRATE_SCRIPT = path.join(REPO_ROOT, "scripts", "setup", "migrate.js");
const SCHEMA_DIR = path.join(REPO_ROOT, "database", "schema");
const MIGRATIONS_DIR = path.join(REPO_ROOT, "database", "migrations");
const BASE_DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://delego:delego@localhost:5432/delego";

const adminUrl = new URL(BASE_DATABASE_URL);
adminUrl.pathname = "/postgres";
const ADMIN_URL = adminUrl.toString();

function countSqlFiles(dir) {
  return fs.readdirSync(dir).filter((name) => name.endsWith(".sql") && !name.endsWith(".down.sql")).length;
}

const TOTAL_MIGRATION_FILES = countSqlFiles(SCHEMA_DIR) + countSqlFiles(MIGRATIONS_DIR);

async function serverReachable() {
  const client = new pg.Client({ connectionString: ADMIN_URL, connectionTimeoutMillis: 3000 });
  try {
    await client.connect();
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}

const dbAvailable = await serverReachable();
if (!dbAvailable) {
  console.log(
    `[tests] Skipping database migration tests — no PostgreSQL at ${ADMIN_URL} (start it with 'docker compose up -d postgres')`,
  );
}

const suite = dbAvailable ? describe : describe.skip;

let dbCounter = 0;

async function createDisposableDatabase(t) {
  const dbName = `delego_migrate_test_${process.pid}_${Date.now()}_${dbCounter++}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end();
  }
  const url = new URL(BASE_DATABASE_URL);
  url.pathname = `/${dbName}`;
  t.after(async () => {
    const cleanup = new pg.Client({ connectionString: ADMIN_URL });
    await cleanup.connect();
    try {
      await cleanup.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    } finally {
      await cleanup.end();
    }
  });
  return url.toString();
}

function runRunner(databaseUrl, { args = [], schemaDir, migrationsDir } = {}) {
  return spawnSync(process.execPath, [MIGRATE_SCRIPT, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      ...(schemaDir ? { DELEGO_SCHEMA_DIR: schemaDir } : {}),
      ...(migrationsDir ? { DELEGO_MIGRATIONS_DIR: migrationsDir } : {}),
    },
  });
}

async function queryDatabase(databaseUrl, sql, values = []) {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return await client.query(sql, values);
  } finally {
    await client.end();
  }
}

async function getTrackingRows(databaseUrl) {
  const result = await queryDatabase(
    databaseUrl,
    "SELECT filename, checksum, applied_at FROM schema_migrations ORDER BY id",
  );
  return result.rows.map((row) => ({
    filename: row.filename,
    checksum: row.checksum,
    applied_at: row.applied_at?.toISOString(),
  }));
}

async function listExistingTables(databaseUrl) {
  const result = await queryDatabase(
    databaseUrl,
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
  );
  return new Set(result.rows.map((row) => row.tablename));
}

function makeFixtureDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "delego-migrations-fixture-"));
  const schemaDir = path.join(root, "schema");
  const migrationsDir = path.join(root, "migrations");
  fs.mkdirSync(schemaDir);
  fs.mkdirSync(migrationsDir);
  return { root, schemaDir, migrationsDir };
}

suite("database migration runner", () => {
  before(() => {
    assert.ok(fs.existsSync(MIGRATE_SCRIPT), "migration runner script is missing");
  });

  it("discovers baseline and incremental files and applies them to a fresh database", async (t) => {
    const databaseUrl = await createDisposableDatabase(t);

    const firstRun = runRunner(databaseUrl);
    assert.equal(firstRun.status, 0, `first run failed:\n${firstRun.stderr}`);

    const tracking = await queryDatabase(
      databaseUrl,
      "SELECT filename, migration_group, version, checksum FROM schema_migrations ORDER BY migration_group, version",
    );
    assert.equal(tracking.rows.length, TOTAL_MIGRATION_FILES);
    for (const row of tracking.rows) {
      assert.match(row.checksum, /^[0-9a-f]{64}$/);
    }

    const tables = await listExistingTables(databaseUrl);
    for (const table of [
      "schema_migrations",
      "users",
      "wallets",
      "orders",
      "saga_executions",
      "purchase_workflows",
      "spend_limits",
      "permission_levels",
      "refresh_tokens",
      "processed_contract_events",
      "service_event_outbox",
      "processed_messages",
      "signing_key_versions",
      "workflow_transition_audit",
      "payment_records",
      "escrow_funding_locks",
      "workflow_events",
      "notification_preferences",
      "soroban_transaction_ledger",
      "oauth_accounts",
      "in_app_notifications",
      "scheduled_notifications",
    ]) {
      assert.ok(tables.has(table), `expected table ${table} to exist`);
    }

    const columns = await queryDatabase(
      databaseUrl,
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = 'public'
         AND (table_name, column_name) IN (('users', 'password_hash'), ('payment_records', 'dispute_tx_hash'))`,
    );
    assert.equal(columns.rows.length, 2, "expected auth-limit and dispute columns to exist");
  });

  it("is a no-op when run a second time", async (t) => {
    const databaseUrl = await createDisposableDatabase(t);

    const firstRun = runRunner(databaseUrl);
    assert.equal(firstRun.status, 0, `first run failed:\n${firstRun.stderr}`);

    const rowsBefore = await getTrackingRows(databaseUrl);
    assert.equal(rowsBefore.length, TOTAL_MIGRATION_FILES);

    const secondRun = runRunner(databaseUrl);
    assert.equal(secondRun.status, 0, `second run failed:\n${secondRun.stderr}`);
    assert.match(secondRun.stdout, /nothing to do/);
    assert.match(secondRun.stdout, /0 pending/);

    const rowsAfter = await getTrackingRows(databaseUrl);
    assert.deepEqual(rowsAfter, rowsBefore);

    const duplicates = await queryDatabase(
      databaseUrl,
      "SELECT filename FROM schema_migrations GROUP BY filename HAVING count(*) > 1",
    );
    assert.equal(duplicates.rows.length, 0);
  });

  it("reports applied and pending migrations via --status", async (t) => {
    const databaseUrl = await createDisposableDatabase(t);

    const pendingStatus = runRunner(databaseUrl, { args: ["--status"] });
    assert.equal(pendingStatus.status, 0, `status failed:\n${pendingStatus.stderr}`);
    assert.match(pendingStatus.stdout, /Applied:/);
    assert.match(pendingStatus.stdout, /Pending:/);
    assert.match(pendingStatus.stdout, new RegExp(`Applied: 0`));
    assert.match(pendingStatus.stdout, new RegExp(`Pending: ${TOTAL_MIGRATION_FILES}`));

    const migrateRun = runRunner(databaseUrl);
    assert.equal(migrateRun.status, 0);

    const appliedStatus = runRunner(databaseUrl, { args: ["--status"] });
    assert.equal(appliedStatus.status, 0, `status failed:\n${appliedStatus.stderr}`);
    assert.match(appliedStatus.stdout, new RegExp(`Applied: ${TOTAL_MIGRATION_FILES}`));
    assert.match(appliedStatus.stdout, /Pending: 0/);
    assert.match(appliedStatus.stdout, /Drifted: 0/);
    assert.match(appliedStatus.stdout, /Database is up to date\./);
  });

  it("fails with a clear error when an applied migration file is edited", async (t) => {
    const databaseUrl = await createDisposableDatabase(t);
    assert.equal(runRunner(databaseUrl).status, 0);

    const fixture = makeFixtureDir();
    fs.cpSync(SCHEMA_DIR, fixture.schemaDir, { recursive: true });
    fs.cpSync(MIGRATIONS_DIR, fixture.migrationsDir, { recursive: true });
    fs.appendFileSync(
      path.join(fixture.migrationsDir, "009_payment_records.sql"),
      "\n-- tampered after application\n",
    );
    fs.writeFileSync(
      path.join(fixture.migrationsDir, "999_post_drift_probe.sql"),
      "CREATE TABLE IF NOT EXISTS post_drift_probe (id INTEGER);\n",
    );

    const driftedRun = runRunner(databaseUrl, {
      schemaDir: fixture.schemaDir,
      migrationsDir: fixture.migrationsDir,
    });

    assert.notEqual(driftedRun.status, 0, "drifted migration must fail the run");
    const output = `${driftedRun.stdout}\n${driftedRun.stderr}`;
    assert.match(output, /checksum mismatch/i);
    assert.match(output, /009_payment_records\.sql/);
    assert.match(output, /[0-9a-f]{64}/);

    const tables = await listExistingTables(databaseUrl);
    assert.ok(!tables.has("post_drift_probe"), "no new migration may apply after drift detection");

    const rows = await getTrackingRows(databaseUrl);
    assert.equal(rows.length, TOTAL_MIGRATION_FILES);
  });

  it("fails before applying anything when versions are duplicated", async (t) => {
    const databaseUrl = await createDisposableDatabase(t);

    const fixture = makeFixtureDir();
    fs.writeFileSync(path.join(fixture.schemaDir, "001_dup_probe.sql"), "CREATE TABLE dup_probe (id INTEGER);\n");
    fs.writeFileSync(path.join(fixture.migrationsDir, "002_first.sql"), "CREATE TABLE first_probe (id INTEGER);\n");
    fs.writeFileSync(path.join(fixture.migrationsDir, "002_second.sql"), "CREATE TABLE second_probe (id INTEGER);\n");

    const duplicateRun = runRunner(databaseUrl, {
      schemaDir: fixture.schemaDir,
      migrationsDir: fixture.migrationsDir,
    });

    assert.notEqual(duplicateRun.status, 0, "duplicate versions must fail the run");
    const output = `${duplicateRun.stdout}\n${duplicateRun.stderr}`;
    assert.match(output, /Duplicate migration version 002/);
    assert.match(output, /002_first\.sql/);
    assert.match(output, /002_second\.sql/);

    const tables = await listExistingTables(databaseUrl);
    assert.ok(!tables.has("dup_probe"), "validation must happen before any SQL executes");
    assert.ok(!tables.has("first_probe"));
    assert.ok(!tables.has("second_probe"));
    assert.ok(!tables.has("schema_migrations"));
  });

  it("applies files in deterministic numeric order regardless of filesystem order", async (t) => {
    const databaseUrl = await createDisposableDatabase(t);

    const fixture = makeFixtureDir();
    fs.writeFileSync(path.join(fixture.schemaDir, "001_baseline.sql"), "SELECT 1;\n");
    fs.writeFileSync(path.join(fixture.migrationsDir, "010_zeta.sql"), "CREATE TABLE order_probe_zeta (id INTEGER);\n");
    fs.writeFileSync(path.join(fixture.migrationsDir, "002_alpha.sql"), "CREATE TABLE order_probe_alpha (id INTEGER);\n");

    const result = runRunner(databaseUrl, {
      schemaDir: fixture.schemaDir,
      migrationsDir: fixture.migrationsDir,
    });
    assert.equal(result.status, 0, `run failed:\n${result.stderr}`);

    const rows = await queryDatabase(databaseUrl, "SELECT filename FROM schema_migrations ORDER BY id");
    assert.deepEqual(
      rows.rows.map((row) => row.filename),
      ["schema/001_baseline.sql", "migration/002_alpha.sql", "migration/010_zeta.sql"],
    );
  });

  it("times out blocked migrations after five seconds and rolls back", async (t) => {
    const databaseUrl = await createDisposableDatabase(t);
    await queryDatabase(databaseUrl, "CREATE TABLE lock_timeout_probe (id INTEGER)");

    const fixture = makeFixtureDir();
    fs.writeFileSync(path.join(fixture.schemaDir, "001_baseline.sql"), "SELECT 1;\n");
    fs.writeFileSync(
      path.join(fixture.migrationsDir, "002_lock_timeout_probe.sql"),
      "ALTER TABLE lock_timeout_probe ADD COLUMN blocked_column INTEGER;\n",
    );

    const lockClient = new pg.Client({ connectionString: databaseUrl });
    await lockClient.connect();
    try {
      await lockClient.query("BEGIN");
      await lockClient.query("LOCK TABLE lock_timeout_probe IN ACCESS EXCLUSIVE MODE");

      const startedAt = Date.now();
      const result = runRunner(databaseUrl, {
        schemaDir: fixture.schemaDir,
        migrationsDir: fixture.migrationsDir,
      });
      const elapsedMs = Date.now() - startedAt;

      assert.notEqual(result.status, 0, "the blocked migration must fail");
      assert.match(`${result.stdout}\n${result.stderr}`, /lock timeout/i);
      assert.ok(elapsedMs >= 4500, `expected the timeout near five seconds, got ${elapsedMs}ms`);
      assert.ok(elapsedMs < 10000, `expected the runner to stop promptly, got ${elapsedMs}ms`);
    } finally {
      await lockClient.query("ROLLBACK");
      await lockClient.end();
    }

    const columns = await queryDatabase(
      databaseUrl,
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'lock_timeout_probe'",
    );
    assert.deepEqual(columns.rows.map((row) => row.column_name), ["id"]);

    const appliedRows = await queryDatabase(
      databaseUrl,
      "SELECT filename FROM schema_migrations WHERE filename = 'migration/002_lock_timeout_probe.sql'",
    );
    assert.equal(appliedRows.rows.length, 0, "a failed migration must not be tracked");
  });
});
