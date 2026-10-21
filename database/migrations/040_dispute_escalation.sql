-- Migration: 040_dispute_escalation
-- Description: Tiered escalation tracking for stalled dispute arbitrations
-- (Issue #403). Disputes left unresolved past the stall window are escalated
-- from the tier1 queue to a senior arbitrator. These columns record the tier
-- and when it was applied so the escalation worker is idempotent.

ALTER TABLE disputes
  ADD COLUMN IF NOT EXISTS escalation_tier VARCHAR(16)
    CHECK (escalation_tier IN ('tier1', 'senior')),
  ADD COLUMN IF NOT EXISTS escalation_escalated_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_disputes_stalled_escalation
  ON disputes(created_at)
  WHERE status NOT IN ('decided', 'resolved')
    AND (escalation_tier IS NULL OR escalation_tier = 'tier1');

-- Down migration (manual rollback)
-- DROP INDEX IF EXISTS idx_disputes_stalled_escalation;
-- ALTER TABLE disputes DROP COLUMN IF EXISTS escalation_escalated_at;
-- ALTER TABLE disputes DROP COLUMN IF EXISTS escalation_tier;
