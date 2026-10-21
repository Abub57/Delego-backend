-- Migration: 040_orchestrator_dlq
-- Description: Dead Letter Queue for BullMQ job auto-replay & remediation (Issue #310)

CREATE TABLE IF NOT EXISTS orchestrator_dead_letter_queue (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  job_id TEXT NOT NULL,
  queue_name TEXT NOT NULL,
  failed_reason TEXT NOT NULL,
  attempts_made INTEGER NOT NULL DEFAULT 0,
  payload JSONB NOT NULL,
  failed_at TIMESTAMPTZ NOT NULL,
  replayed_at TIMESTAMPTZ,
  replay_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'replaying', 'replayed', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(job_id, queue_name)
);

CREATE INDEX IF NOT EXISTS idx_orchestrator_dlq_status 
  ON orchestrator_dead_letter_queue(status);

CREATE INDEX IF NOT EXISTS idx_orchestrator_dlq_queue_name 
  ON orchestrator_dead_letter_queue(queue_name);

CREATE INDEX IF NOT EXISTS idx_orchestrator_dlq_failed_at 
  ON orchestrator_dead_letter_queue(failed_at DESC);

CREATE INDEX IF NOT EXISTS idx_orchestrator_dlq_pending 
  ON orchestrator_dead_letter_queue(status, failed_at) 
  WHERE status = 'pending';

-- Index for recoverable network errors
CREATE INDEX IF NOT EXISTS idx_orchestrator_dlq_recoverable 
  ON orchestrator_dead_letter_queue(status, failed_reason) 
  WHERE status = 'pending';

COMMENT ON TABLE orchestrator_dead_letter_queue IS 
  'Dead letter queue for failed BullMQ jobs with auto-replay capability for recoverable network errors';

COMMENT ON COLUMN orchestrator_dead_letter_queue.job_id IS 
  'Original BullMQ job ID for deduplication on replay';

COMMENT ON COLUMN orchestrator_dead_letter_queue.queue_name IS 
  'BullMQ queue name where the job failed';

COMMENT ON COLUMN orchestrator_dead_letter_queue.failed_reason IS 
  'Error message or reason for job failure';

COMMENT ON COLUMN orchestrator_dead_letter_queue.payload IS 
  'Original job payload for replay';

COMMENT ON COLUMN orchestrator_dead_letter_queue.status IS 
  'Job replay status: pending (not yet replayed), replaying (in progress), replayed (successful), failed (replay failed)';

-- Down migration (manual rollback)
-- DROP INDEX IF EXISTS idx_orchestrator_dlq_recoverable;
-- DROP INDEX IF EXISTS idx_orchestrator_dlq_pending;
-- DROP INDEX IF EXISTS idx_orchestrator_dlq_failed_at;
-- DROP INDEX IF EXISTS idx_orchestrator_dlq_queue_name;
-- DROP INDEX IF EXISTS idx_orchestrator_dlq_status;
-- DROP TABLE IF EXISTS orchestrator_dead_letter_queue;
