-- Migration: 049_review_moderation_audit.sql
-- Description: Append-only audit trail for administrative review appeal verdicts (Issue #520)
-- Created: 2026-10-20

CREATE TABLE IF NOT EXISTS review_moderation_audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    appeal_id UUID NOT NULL REFERENCES review_appeals(id) ON DELETE CASCADE,
    review_id UUID NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
    operator_id UUID NOT NULL,
    verdict VARCHAR(32) NOT NULL CHECK (
        verdict IN ('remove_review', 'keep_review', 'warn_buyer', 'approved', 'rejected')
    ),
    notes TEXT NOT NULL DEFAULT '',
    decided_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_review_moderation_audit_appeal_id
    ON review_moderation_audit_logs(appeal_id);
CREATE INDEX IF NOT EXISTS idx_review_moderation_audit_review_id
    ON review_moderation_audit_logs(review_id);
CREATE INDEX IF NOT EXISTS idx_review_moderation_audit_operator_id
    ON review_moderation_audit_logs(operator_id);
CREATE INDEX IF NOT EXISTS idx_review_moderation_audit_decided_at
    ON review_moderation_audit_logs(decided_at DESC);
