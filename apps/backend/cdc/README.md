# @delegolabs/cdc

Change Data Capture (CDC) service for the Delego platform — real-time database
synchronization across services.

Captures PostgreSQL row changes via **logical replication** (native slots) or an
external **Debezium** cluster, transforms them into domain events, and publishes
them to the **Redis** bus (durable stream + real-time pub/sub) with **exactly-once**
delivery.

## Features

- **Capture INSERT / UPDATE / DELETE** row changes for configured tables
- **Logical replication** connector (native Postgres, `test_decoding` plugin, no
  extra install) and a **Debezium** connector for external clusters
- **Transform** raw WAL changes into canonical `CDCEvent`s and `CDCDomainEvent`s
- **Publish** to Redis: durable stream `cdc:events` (group-consumable) and
  per-table pub/sub topics (`cdc:<schema>:<table>`)
- **Exactly-once** delivery via the `cdc_published_events` dedup table + durable
  replication checkpoints (`cdc_replication_state`)
- **Schema evolution** handling (`cdc_schema_versions`) — payloads carry the
  source `schemaVersion` so consumers can interpret old layouts
- **Monitoring dashboard** showing WAL lag, throughput, and errors
- **Failover / recovery** by resuming from the durable slot checkpoint (<30s)
- **Escrow snapshot archiver & ledger pruner** (`src/archiver/`) — a nightly job
  that moves escrows settled longer than the retention window (default 90 days)
  into the cold `escrow_archives` table, keeping the live table compact, and
  prunes the migrated rows in the same transaction (Issue #290)

## Architecture

```
PostgreSQL (WAL)                       CDC Service                  Redis
┌─────────────┐   logical replication   ┌───────────────────┐      ┌────────────┐
│ tables      │ ──────────────────────► │ Connector         │      │ stream     │
│ orders      │   publisher+slot        │   ▼               │      │ cdc:events │
│ wallets     │                         │ Transformer       │ ───► │ pub/sub    │
│ ...         │                         │   ▼               │      │ cdc:pub:.. │
└─────────────┘                         │ Publisher         │      └────────────┘
                                        │  (exactly-once)   │
                                        │   ▼               │
                                        │ Checkpoint (PG)   │
                                        └───────────────────┘
```

The pipeline is a **single consumer per slot** (logical replication delivers a
serial WAL stream, preserving per-table ordering). Scale out by running one
pipeline per slot. Exactly-once is enforced by recording each change in
`cdc_published_events` (unique on `slot:lsn:seq`) before publishing; a crash
between publish and checkpoint causes a replay that the dedup table turns into
no-ops.

## Installation & Run

```bash
pnpm install
pnpm --filter @delegolabs/cdc dev
```

### Prerequisites

1. PostgreSQL with logical decoding enabled:

```yaml
# docker-compose.yml (already configured)
command: ["postgres", "-c", "wal_level=logical", "-c", "max_replication_slots=10", "-c", "max_wal_senders=10"]
```

2. Apply the CDC migration:

```bash
pnpm db:migrate
```

3. Configure via environment (`CDC_*`, see `.env.example`) or a JSON config file
   (`CDC_CONFIG_PATH`).

Example `CDC_TABLES`:

```json
[
  { "schema": "public", "table": "orders", "pkColumns": ["id"] },
  { "schema": "public", "table": "wallets", "pkColumns": ["id"] }
]
```

### Debezium mode

Set `CDC_CONNECTOR=debezium` and provide a `DebeziumSource` (see
`src/connector/debezium.ts`). The pipeline and exactly-once semantics are
identical to the logical-replication path.

## Endpoints

| Endpoint                | Description                                             |
| ----------------------- | ------------------------------------------------------- |
| `GET /health`           | Health surface                                          |
| `GET /cdc/dashboard`    | HTML monitoring dashboard (WAL lag, throughput, errors) |
| `GET /api/v1/cdc/metrics` | JSON `CDCMetrics` snapshot                            |
| `GET /api/v1/cdc/position` | Current WAL LSN + lag ms                              |
| `GET /api/v1/cdc/config`  | Effective config (secrets redacted)                   |
| `GET /metrics`          | Prometheus text metrics (`delego_cdc_*`)                |
| `POST /api/v1/cdc/pause`  | Pause the pipeline                                   |
| `POST /api/v1/cdc/resume` | Resume the pipeline                                  |

## Configuration

| Env                      | Default                        | Description                              |
| ------------------------ | ------------------------------ | ---------------------------------------- |
| `CDC_PORT`               | `3017`                         | HTTP port                               |
| `CDC_CONNECTOR`          | `logical_replication`          | `logical_replication` or `debezium`     |
| `CDC_CONFIG_PATH`        | —                              | Optional path to a JSON `CDCConfig`     |
| `CDC_DB_HOST/PORT/NAME/USER/PASSWORD` | `localhost/5432/delego/delego/delego` | Source database |
| `CDC_TABLES`             | —                              | JSON array of `{schema, table, pkColumns}` |
| `CDC_PUBLICATION`        | `delego_cdc_publication`       | Publication name                        |
| `CDC_SLOT`               | `delego_cdc_slot`              | Replication slot name                   |
| `CDC_TOPIC_PREFIX`       | `cdc`                          | Redis topic prefix                      |
| `CDC_POLL_INTERVAL_MS`   | `500`                          | Poll cadence when idle                  |
| `CDC_METRICS_INTERVAL_MS`| `5000`                         | Metrics snapshot interval               |
| `ESCROW_ARCHIVE_ENABLED` | `true`                         | Run the nightly escrow archiver         |
| `ESCROW_ARCHIVE_RETENTION_DAYS` | `90`                    | Archive escrows settled longer ago than this |
| `ESCROW_ARCHIVE_BATCH_SIZE` | `500`                       | Rows moved per transaction              |
| `ESCROW_ARCHIVE_MAX_BATCHES` | `20`                      | Batches per nightly run                 |
| `ESCROW_ARCHIVE_HOUR_UTC` | `3`                           | UTC hour the nightly run fires at       |
| `ESCROW_ARCHIVE_SOURCE_TABLE` | `escrows`                 | Live escrow table                       |
| `ESCROW_ARCHIVE_TABLE`   | `escrow_archives`              | Cold-storage table                      |
| `ESCROW_ARCHIVE_{ID,ESCROW_ID,STATUS,CLOSED_AT}_COLUMN` | `id`/`escrow_id`/`status`/`closed_at` | Source column mapping |

## Escrow snapshot archiver

`src/archiver/` keeps the live escrow table (and its indexes) compact by moving
long-settled rows into `escrow_archives`:

- One run per day at `ESCROW_ARCHIVE_HOUR_UTC` (default 03:00 UTC). The next run is
  armed only after the previous one settles, and an in-flight run skips the next
  tick, so two archivers can never overlap.
- Each batch is one transaction: `SELECT … FOR UPDATE SKIP LOCKED` the oldest
  settled rows, insert their full `to_jsonb` snapshot into `escrow_archives`
  (`ON CONFLICT (escrow_id) DO NOTHING`), then delete exactly the rows that were
  archived. A crash between the insert and the delete costs nothing: the next run
  re-inserts, conflicts, and prunes.
- `maxBatches` (default 20) bounds the work per night, so a large backlog drains
  over several runs instead of holding a long transaction on the primary.
- Multi-instance safe: a `pg_try_advisory_lock` admits a single runner across CDC
  replicas, and the row locks mean even an unlucky race cannot archive or delete
  the same row twice.

Nothing is discarded — `archive_payload` holds the complete source row, so audit
queries and later-required columns survive the move.

## Testing

```bash
pnpm --filter @delegolabs/cdc test
```

Unit tests cover: WAL decoding, Debezium envelope normalization, transform,
**exactly-once** semantics (replay does not double-publish), schema evolution,
metrics, **failover** (resume from durable checkpoint), and the **escrow archiver**
(retention cutoff, bounded batches, idempotent re-runs, nightly scheduling).

## Failover & Recovery

- Each batch's changes are durably recorded (`cdc_published_events`) **before** the
  slot checkpoint (`cdc_replication_state`) advances.
- On restart, the pipeline resumes from the persisted `confirmedFlushLsn` — no
  events are lost or duplicated (replays are deduped).
- Pause/resume endpoints allow draining / controlled failover testing.
