-- Migration: 040_soroban_event_sync_checkpoints
-- Description: Durable PostgreSQL checkpoint store for the Soroban RPC event
--              listener (Issue #366). Enables the ingestion worker to discover
--              the last processed ledger sequence after a restart or network
--              interruption and backfill any events that were missed during the
--              downtime window.
--
-- Design notes:
--   - One row per contract — upserted on every successful ingestion batch.
--   - `last_ledger_sequence` is the ledger the RPC returned as `latestLedger`
--     after the most-recently completed batch, used as `startLedger` on the
--     next startup to avoid any gap.
--   - `last_event_id` is the unique event id of the last event ingested in that
--     batch, surfaced for observability / manual reconciliation.
--   - `synced_at` records when the checkpoint was last advanced; the worker
--     exposes this as a lag metric.
--
-- Deduplication reference table:
--   `soroban_processed_events` stores every event id that has been written to
--   the Redis event bus. On startup backfill and on normal polling, the worker
--   checks this table before publishing to avoid double-processing.

CREATE TABLE IF NOT EXISTS soroban_event_sync_checkpoints (
  contract_id VARCHAR(255) PRIMARY KEY,
  last_ledger_sequence INTEGER NOT NULL DEFAULT 0,
  last_event_id VARCHAR(255) NOT NULL DEFAULT '',
  synced_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Efficiently query: "which contracts have stale checkpoints?" (monitoring lag).
CREATE INDEX IF NOT EXISTS idx_soroban_event_sync_checkpoints_synced_at
  ON soroban_event_sync_checkpoints(synced_at DESC);

-- ---------------------------------------------------------------------------
-- soroban_processed_events
-- Idempotency log for the Soroban event bus writes. The ingestion worker
-- consults this table before every XADD to guarantee that a crash-recovery
-- backfill never double-publishes an event whose stream write succeeded but
-- whose checkpoint advance did not.
--
-- `event_id` is the Soroban RPC-assigned id (e.g. "000012345-1"), which is
-- unique and stable across retries for the same on-chain event.
-- `published_at` records when the XADD succeeded so stale entries can be
-- pruned by a future maintenance migration.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS soroban_processed_events (
  event_id VARCHAR(255) PRIMARY KEY,
  contract_id VARCHAR(255) NOT NULL,
  ledger_sequence INTEGER NOT NULL,
  published_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_soroban_processed_events_contract_id
  ON soroban_processed_events(contract_id);

CREATE INDEX IF NOT EXISTS idx_soroban_processed_events_ledger_sequence
  ON soroban_processed_events(contract_id, ledger_sequence);

CREATE INDEX IF NOT EXISTS idx_soroban_processed_events_published_at
  ON soroban_processed_events(published_at DESC);

-- Down migration (manual rollback)
-- DROP INDEX IF EXISTS idx_soroban_processed_events_published_at;
-- DROP INDEX IF EXISTS idx_soroban_processed_events_ledger_sequence;
-- DROP INDEX IF EXISTS idx_soroban_processed_events_contract_id;
-- DROP TABLE IF EXISTS soroban_processed_events;
-- DROP INDEX IF EXISTS idx_soroban_event_sync_checkpoints_synced_at;
-- DROP TABLE IF EXISTS soroban_event_sync_checkpoints;
