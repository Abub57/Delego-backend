-- 046_dual_control_expiration.sql
-- Issue #XXX — Dual-control approval expiration management.
--
-- Adds expires_at column to track when approval requests expire, and creates
-- a composite index on (status, expires_at) to optimize the expiration worker
-- query that transitions pending requests to expired status without causing
-- deadlocks with concurrent user approval submissions.

ALTER TABLE dual_control_approvals 
ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

-- Set default expiration to 24 hours from creation for existing rows
UPDATE dual_control_approvals 
SET expires_at = created_at + INTERVAL '24 hours' 
WHERE expires_at IS NULL;

-- Composite index to optimize expiration worker lookups
-- This index allows the worker to efficiently find expired pending approvals
-- without scanning the entire table
CREATE INDEX IF NOT EXISTS idx_dual_control_expired
  ON dual_control_approvals (status, expires_at)
  WHERE status = 'pending';

-- Add a comment explaining the index purpose
COMMENT ON INDEX idx_dual_control_expired IS 
  'Optimizes expiration worker queries that select pending approvals with expires_at < NOW(). 
   The partial index (WHERE status = ''pending'') reduces index size and maintenance overhead 
   since only pending approvals need expiration processing.';
