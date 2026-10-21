-- Migration: 040_audit_chain
-- Description: Cryptographic SHA-256 tamper-evident audit log chaining table (Issue #358).
--
-- This table stores the cryptographically chained audit log entries where:
--   currentHash = sha256(sequence + actorId + action + targetId + previousHash + timestamp)
-- Each entry's hash is chained to the previous entry's currentHash, making
-- any modification or row deletion detectable.

CREATE TABLE IF NOT EXISTS audit_chain (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence BIGINT NOT NULL UNIQUE,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_id TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}',
  previous_hash CHAR(64),
  current_hash CHAR(64) NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_chain_sequence ON audit_chain(sequence);
CREATE INDEX IF NOT EXISTS idx_audit_chain_actor ON audit_chain(actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_chain_action ON audit_chain(action);
CREATE INDEX IF NOT EXISTS idx_audit_chain_target ON audit_chain(target_id);
CREATE INDEX IF NOT EXISTS idx_audit_chain_timestamp ON audit_chain(timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_chain_current_hash ON audit_chain(current_hash);

-- Enforce append-only: any UPDATE or DELETE against audit_chain is rejected.
CREATE OR REPLACE FUNCTION audit_chain_prevent_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_chain is append-only: % is not permitted (id=%)', TG_OP, OLD.id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_chain_no_update ON audit_chain;
CREATE TRIGGER trg_audit_chain_no_update
  BEFORE UPDATE ON audit_chain
  FOR EACH ROW EXECUTE FUNCTION audit_chain_prevent_mutation();

DROP TRIGGER IF EXISTS trg_audit_chain_no_delete ON audit_chain;
CREATE TRIGGER trg_audit_chain_no_delete
  BEFORE DELETE ON audit_chain
  FOR EACH ROW EXECUTE FUNCTION audit_chain_prevent_mutation();

-- Down migration
-- DROP TRIGGER IF EXISTS trg_audit_chain_no_delete ON audit_chain;
-- DROP TRIGGER IF EXISTS trg_audit_chain_no_update ON audit_chain;
-- DROP FUNCTION IF EXISTS audit_chain_prevent_mutation();
-- DROP INDEX IF EXISTS idx_audit_chain_current_hash;
-- DROP INDEX IF EXISTS idx_audit_chain_timestamp;
-- DROP INDEX IF EXISTS idx_audit_chain_target;
-- DROP INDEX IF EXISTS idx_audit_chain_action;
-- DROP INDEX IF EXISTS idx_audit_chain_actor;
-- DROP INDEX IF EXISTS idx_audit_chain_sequence;
-- DROP TABLE IF EXISTS audit_chain;
