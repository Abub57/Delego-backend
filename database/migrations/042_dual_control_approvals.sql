-- 042_dual_control_approvals.sql
-- Issue #303 — Multi-party dual-control quorum enforcement (M-of-N sign-off).
--
-- dual_control_approvals: one approval request per order, needing
--   `required_signatures` sign-offs before the order moves to 'approved'.
-- dual_control_signatures: one row per signer. The creator of a request may
--   not sign it (enforced in DualControlService), and a signer may sign a
--   request only once (enforced by the unique index below, so a repeat
--   signature can never be counted twice toward the quorum).

CREATE TABLE IF NOT EXISTS dual_control_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id),
  required_signatures INT NOT NULL DEFAULT 2,
  created_by_user_id UUID NOT NULL REFERENCES users(id),
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS dual_control_signatures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  approval_id UUID NOT NULL REFERENCES dual_control_approvals(id),
  signer_user_id UUID NOT NULL REFERENCES users(id),
  signed_at TIMESTAMPTZ DEFAULT NOW(),
  signature_note TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_dual_control_signatures_approval_signer
  ON dual_control_signatures (approval_id, signer_user_id);

CREATE INDEX IF NOT EXISTS idx_dual_control_approvals_order
  ON dual_control_approvals (order_id);
