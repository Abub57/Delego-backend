-- 046_dual_control_expiration.down.sql
-- Rollback migration for dual-control approval expiration.

DROP INDEX IF EXISTS idx_dual_control_expired;

ALTER TABLE dual_control_approvals 
DROP COLUMN IF EXISTS expires_at;
