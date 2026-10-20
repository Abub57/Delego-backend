-- Migration: 062_soroban_contract_events
-- Description: Durable, idempotent store for ingested Soroban contract events,
--              written in the same transaction that advances the watermark in
--              `soroban_event_sync_checkpoints` (migration 059).
--
-- Resume semantics (see apps/backend/cdc/src/sorobanEvents/resumableIngestion.ts):
--   - `soroban_event_sync_checkpoints.last_ledger_sequence` = L means every
--     event with ledger <= L for that contract has been committed. On restart
--     the worker resumes at L + 1, so nothing is skipped.
--   - Events are upserted with ON CONFLICT (event_id) DO NOTHING, and
--     `soroban_processed_events` acts as the exactly-once claim table, so a
--     re-read ledger never runs downstream processors twice.

CREATE TABLE IF NOT EXISTS soroban_contract_events (
  event_id                    VARCHAR(255) PRIMARY KEY,
  contract_id                 VARCHAR(255) NOT NULL,
  ledger_sequence             INTEGER      NOT NULL,
  ledger_closed_at            TIMESTAMPTZ  NOT NULL,
  tx_hash                     VARCHAR(64)  NOT NULL,
  topics                      JSONB        NOT NULL DEFAULT '[]',
  value                       JSONB        NOT NULL DEFAULT '{}',
  in_successful_contract_call BOOLEAN      NOT NULL DEFAULT TRUE,
  ingested_at                 TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Replay / audit by contract in strict ledger order.
CREATE INDEX IF NOT EXISTS idx_soroban_contract_events_contract_ledger
  ON soroban_contract_events (contract_id, ledger_sequence, event_id);

CREATE INDEX IF NOT EXISTS idx_soroban_contract_events_tx_hash
  ON soroban_contract_events (tx_hash);

-- ── Down migration ─────────────────────────────────────────────────────────────
-- DROP INDEX IF EXISTS idx_soroban_contract_events_tx_hash;
-- DROP INDEX IF EXISTS idx_soroban_contract_events_contract_ledger;
-- DROP TABLE IF EXISTS soroban_contract_events;
