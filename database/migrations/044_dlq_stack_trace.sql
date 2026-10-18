-- Migration: 044_dlq_stack_trace
-- Description: Capture full error stack traces and cause chains on DLQ records (Issue #347)
--
-- Previously `orchestrator_dead_letter_queue.failed_reason` stored only the
-- error message, discarding the stack trace and any chained `error.cause`
-- that made root cause analysis in production difficult.

ALTER TABLE orchestrator_dead_letter_queue
  ADD COLUMN IF NOT EXISTS stack_trace TEXT NOT NULL DEFAULT '';

ALTER TABLE orchestrator_dead_letter_queue
  ADD COLUMN IF NOT EXISTS error_cause_chain JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN orchestrator_dead_letter_queue.stack_trace IS
  'Full error.stack captured when the job was moved to the DLQ (or on the most recent replay failure)';

COMMENT ON COLUMN orchestrator_dead_letter_queue.error_cause_chain IS
  'Formatted error.cause chain (outermost cause first), recursively serialized';
