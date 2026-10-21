# db-vacuum (`@delegolabs/db-vacuum`)

**Port**: 3022 · **Health**: `GET /health` · **Issue**: #382

Automated PostgreSQL **bloat detection and non-blocking `VACUUM ANALYZE`**.

The worker watches high-churn tables for dead-tuple accumulation, alerts when
they cross a threshold, and reclaims the space — without taking the locks that
would turn a maintenance task into an outage.

## How it works

Each pass (every `DB_VACUUM_INTERVAL_MS`, default 15 minutes) does four things:

1. **Scan** — reads `schemaname, relname, n_dead_tup, n_live_tup` from
   `pg_stat_user_tables`, joined with `pg_class` for autovacuum settings and
   `pg_stat_user_indexes` / `pg_statio_user_indexes` for per-index size and scan
   counts, so table *and* index bloat signals arrive in one round trip.
2. **Classify** — turns raw counters into a severity verdict
   (`none → low → medium → high → critical`) plus a vacuum/no-vacuum decision.
3. **Alert** — raises deduplicated alerts (default 1h cooldown per
   rule + table) for tables over the line, and a low-severity advisory listing
   unused indexes.
4. **Vacuum** — issues `VACUUM (ANALYZE)` for the worst offenders, worst first,
   capped at `DB_VACUUM_MAX_TABLES_PER_RUN` per pass.

### Thresholds

A table is vacuumed when it is **large enough to matter** *and* either the
dead-tuple **ratio** or the absolute dead-tuple **count** crosses its limit.
Both signals are needed: a small hot table blows the ratio, while a large table
creeps up on a count.

| Setting | Env | Default | Meaning |
|---|---|---|---|
| `deadTupleRatio` | `DB_VACUUM_DEAD_TUPLE_RATIO` | `0.2` | Ratio that marks a table bloated |
| `deadTupleCount` | `DB_VACUUM_DEAD_TUPLE_COUNT` | `10000` | Absolute dead tuples that mark it bloated |
| `minTableSizeBytes` | `DB_VACUUM_MIN_TABLE_SIZE_BYTES` | `10 MiB` | Ignore tables below this |
| `bloatBytesEscalation` | — | `5 GiB` | Reclaimable bytes that bump severity one step |
| `maxTablesPerRun` | `DB_VACUUM_MAX_TABLES_PER_RUN` | `5` | Ceiling on vacuums per pass |
| `statementTimeoutMs` | `DB_VACUUM_STATEMENT_TIMEOUT_MS` | `60000` | Per-statement timeout |
| `intervalMs` | `DB_VACUUM_INTERVAL_MS` | `900000` | Pass interval |
| alert cooldown | `DB_VACUUM_ALERT_COOLDOWN_MS` | `3600000` | Repeat-alert suppression window |

`bloatBytesEscalation` is absolute rather than relative on purpose: 20% bloat
is noise on a 50MB table and an incident on a 200GB one.

## Safety

`VACUUM` is one of the few statements that cannot run in a transaction and one
of the few that can take a table offline, so the executor is defensive:

- **`VACUUM FULL` is impossible.** The statement builder has no `full` option —
  `VACUUM FULL` rewrites the table under an `ACCESS EXCLUSIVE` lock, which is
  the outage this worker exists to prevent.
- **Non-blocking.** Plain `VACUUM ANALYZE` only takes a `SHARE UPDATE EXCLUSIVE`
  lock, so reads and writes continue.
- **Identifiers are validated and quoted**, never interpolated. Anything that is
  not a bare identifier (`^[A-Za-z_][A-Za-z0-9_$]*$`) is rejected before a
  connection is even checked out.
- **System schemas are refused** (`pg_catalog`, `information_schema`, `pg_toast`,
  and anything matching `^pg_`), even via a misconfigured allowlist.
- **Autocommit is mandatory** — the statement runs on its own connection with no
  `BEGIN`, since PostgreSQL rejects `VACUUM` inside a transaction block. The
  `statement_timeout` is therefore set at session level and reset afterwards.
- **A per-statement timeout** stops a pathological table from pinning a worker.
- **No concurrent vacuums on one table** — a table already being vacuumed by us
  or by autovacuum is skipped.
- **Runs never overlap.** A pass requested while one is in flight is rejected.
- **Unused indexes are reported, never dropped.** Dropping an index is a schema
  change with its own rollback plan, not something a background worker should do.
- **`DB_VACUUM_DRY_RUN=true`** assesses and alerts without issuing any statement.
  The service also boots in dry run when no `DATABASE_URL` is configured.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Liveness + database reachability |
| `GET` | `/api/v1/db-vacuum/config` | Effective thresholds and run config |
| `GET` | `/api/v1/db-vacuum/bloat` | Fresh scan + per-table assessments |
| `GET` | `/api/v1/db-vacuum/metrics` | Worker metrics (see below) |
| `POST` | `/api/v1/db-vacuum/run` | Trigger a pass (`409` if one is in flight) |
| `GET` | `/api/v1/db-vacuum/runs` | Last run summary |

## Metrics

`GET /api/v1/db-vacuum/metrics` returns `lastRunAt`, `lastRunDurationMs`,
`runs`, `tablesScanned`, `tablesOverThreshold`, `vacuumAttempts`,
`vacuumsSucceeded`, `vacuumsFailed`, `vacuumsSkipped`, `vacuumSuccessRate`,
`avgVacuumDurationMs`, `alertsRaised`, `alertsSuppressed`, `criticalTables`,
`totalDeadTuples`, `totalEstimatedBloatBytes`, `worstDeadTupleRatio` and
`worstTable`.

Attempt and run history are held in a bounded in-memory window (500 entries), so
memory cannot grow without limit. A durable per-table audit trail is written to
`db_vacuum_run_log` (migration `database/migrations/040_db_vacuum_run_log.sql`)
when the service has a database; a storage failure is logged and never fails an
otherwise successful run.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | — | PostgreSQL connection string. Unset ⇒ dry run with empty scans. |
| `DB_VACUUM_PORT` | `3022` | HTTP port |
| `DB_VACUUM_ENABLED` | `true` | Set `false` to disable the scheduled worker |
| `DB_VACUUM_DRY_RUN` | `false` | Set `true` to assess without vacuuming |
| `DB_VACUUM_SKIP_AUTOVACUUM_DISABLED` | `true` | Skip tables with autovacuum switched off |
| `DB_VACUUM_SKIP_IF_RUNNING` | `true` | Skip tables already being vacuumed |

## Development

```bash
pnpm --filter @delegolabs/db-vacuum dev      # watch mode
pnpm --filter @delegolabs/db-vacuum test     # unit tests
pnpm --filter @delegolabs/db-vacuum build    # compile to dist/
```

Every collaborator is injectable — the scanner, the executor, the alert sink
and the history store — so the whole pipeline is exercised in unit tests without
a database. `RecordingVacuumExecutor` and `RecordingAlertSink` are the test
doubles; `PgBloatScanner` / `PgVacuumExecutor` are the production pair.

Integration coverage lives in
`tests/integration/src/db-vacuum-bloat.integration.test.js` and exercises the
real query and a real `VACUUM ANALYZE` against Postgres. It skips itself when no
database or build is available.
