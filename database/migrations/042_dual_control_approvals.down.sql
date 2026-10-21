-- Rollback for 042_dual_control_approvals.sql
DROP INDEX IF EXISTS idx_dual_control_approvals_order;
DROP INDEX IF EXISTS idx_dual_control_signatures_approval_signer;
DROP TABLE IF EXISTS dual_control_signatures;
DROP TABLE IF EXISTS dual_control_approvals;
