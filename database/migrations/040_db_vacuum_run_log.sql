-- Migration: 040_db_vacuum_run_log
-- Description: Audit trail for the automated database vacuum and bloat
-- monitoring worker (Issue #382). The worker records one row per table per
-- run so operators can answer "when was this last vacuumed, and did it work?"
-- without waiting for autovacuum's own logs to be rotated away.

CREATE TABLE IF NOT EXISTS db_vacuum_run_log (
  id                    BIGSERIAL PRIMARY KEY,
  run_id                TEXT        NOT NULL,
  qualified_name        TEXT        NOT NULL,
  outcome               TEXT        NOT NULL CHECK (outcome IN ('vacuumed', 'skipped', 'failed')),
  severity              TEXT        NOT NULL DEFAULT 'none',
  dead_tuple_ratio      DOUBLE PRECISION NOT NULL DEFAULT 0,
  estimated_bloat_bytes BIGINT      NOT NULL DEFAULT 0,
  duration_ms           INTEGER     NOT NULL DEFAULT 0,
  reason                TEXT,
  recorded_at           TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Operators page the log newest-first, usually filtered to a single table.
CREATE INDEX IF NOT EXISTS idx_db_vacuum_run_log_recorded_at
  ON db_vacuum_run_log(recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_db_vacuum_run_log_qualified_name
  ON db_vacuum_run_log(qualified_name, recorded_at DESC);

-- Rollback (manual):
-- DROP TABLE IF EXISTS db_vacuum_run_log;
