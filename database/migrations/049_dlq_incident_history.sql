-- Migration: 049_dlq_incident_history
-- Issue #588
-- Description: Audit trail for the BullMQ DLQ manager. One row per handled
--              job failure: either a scheduled exponential-backoff retry or
--              the final (permanent) quarantine of the job.

CREATE TABLE IF NOT EXISTS dlq_incident_history (
  id                BIGSERIAL PRIMARY KEY,
  queue_name        TEXT        NOT NULL,
  job_id            TEXT        NOT NULL,
  job_name          TEXT        NOT NULL,
  -- 1-based failure count for this job lineage (original job id).
  attempt           INTEGER     NOT NULL CHECK (attempt >= 1),
  outcome           TEXT        NOT NULL CHECK (outcome IN ('retry_scheduled', 'quarantined')),
  error_class       TEXT        NOT NULL CHECK (error_class IN ('transient', 'fatal', 'unclassified')),
  error_name        TEXT,
  error_message     TEXT        NOT NULL,
  -- Backoff applied before the next attempt; NULL when quarantined.
  retry_delay_ms    INTEGER,
  -- 'fatal_error' | 'retries_exhausted' | 'unclassified_error'; NULL when retried.
  quarantine_reason TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dlq_incident_history_job
  ON dlq_incident_history (queue_name, job_id, created_at);

CREATE INDEX IF NOT EXISTS idx_dlq_incident_history_quarantined
  ON dlq_incident_history (created_at) WHERE outcome = 'quarantined';
