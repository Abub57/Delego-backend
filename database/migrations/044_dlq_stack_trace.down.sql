ALTER TABLE orchestrator_dead_letter_queue DROP COLUMN IF EXISTS error_cause_chain;
ALTER TABLE orchestrator_dead_letter_queue DROP COLUMN IF EXISTS stack_trace;
