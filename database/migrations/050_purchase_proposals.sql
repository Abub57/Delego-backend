-- Migration: 050_purchase_proposals
-- Issue: #265 Purchase Proposal Generation & Limits Pre-Check Service
-- Description: Adds purchase_proposals table and the spent_stroops / version
--              columns to delegations for atomic allowance tracking.

-- ── 1. Extend delegations for spent-amount tracking ──────────────────────────
ALTER TABLE delegations
  ADD COLUMN IF NOT EXISTS spent_stroops        NUMERIC(30,0) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS auto_approve_threshold_stroops NUMERIC(30,0),
  ADD COLUMN IF NOT EXISTS version              INTEGER       NOT NULL DEFAULT 1;

-- Optimistic-lock index: only one UPDATE at a given version wins
CREATE UNIQUE INDEX IF NOT EXISTS idx_delegations_id_version
  ON delegations (id, version);

-- ── 2. purchase_proposals table ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS purchase_proposals (
  id                                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                           UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delegation_id                     UUID        NOT NULL REFERENCES delegations(id),
  merchant_address                  VARCHAR(64) NOT NULL,
  items                             JSONB       NOT NULL DEFAULT '[]',
  total_amount_stroops              NUMERIC(30,0) NOT NULL,
  asset_code                        VARCHAR(12) NOT NULL,
  rationale                         TEXT        NOT NULL DEFAULT '',
  status                            VARCHAR(20) NOT NULL DEFAULT 'pending_approval'
                                      CHECK (status IN ('pending_approval','auto_approved','rejected','expired')),
  requires_manual_approval          BOOLEAN     NOT NULL DEFAULT FALSE,
  delegation_limit_remaining_stroops NUMERIC(30,0) NOT NULL DEFAULT 0,
  expires_at                        TIMESTAMPTZ NOT NULL,
  created_at                        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_purchase_proposals_user_id
  ON purchase_proposals (user_id);

CREATE INDEX IF NOT EXISTS idx_purchase_proposals_delegation_id
  ON purchase_proposals (delegation_id);

CREATE INDEX IF NOT EXISTS idx_purchase_proposals_status
  ON purchase_proposals (status)
  WHERE status IN ('pending_approval','auto_approved');

-- Expire proposals automatically (requires pg_cron or a background job to run):
-- UPDATE purchase_proposals SET status = 'expired' WHERE expires_at < NOW() AND status NOT IN ('rejected','expired');

-- ── Down migration ─────────────────────────────────────────────────────────────
-- DROP INDEX  IF EXISTS idx_purchase_proposals_status;
-- DROP INDEX  IF EXISTS idx_purchase_proposals_delegation_id;
-- DROP INDEX  IF EXISTS idx_purchase_proposals_user_id;
-- DROP TABLE  IF EXISTS purchase_proposals;
-- DROP INDEX  IF EXISTS idx_delegations_id_version;
-- ALTER TABLE delegations DROP COLUMN IF EXISTS version;
-- ALTER TABLE delegations DROP COLUMN IF EXISTS auto_approve_threshold_stroops;
-- ALTER TABLE delegations DROP COLUMN IF EXISTS spent_stroops;
