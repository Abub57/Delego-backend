-- Down migration for 040_audit_chain (Issue #358)
DROP TRIGGER IF EXISTS trg_audit_chain_no_delete ON audit_chain;
DROP TRIGGER IF EXISTS trg_audit_chain_no_update ON audit_chain;
DROP FUNCTION IF EXISTS audit_chain_prevent_mutation();
DROP INDEX IF EXISTS idx_audit_chain_current_hash;
DROP INDEX IF EXISTS idx_audit_chain_timestamp;
DROP INDEX IF EXISTS idx_audit_chain_target;
DROP INDEX IF EXISTS idx_audit_chain_action;
DROP INDEX IF EXISTS idx_audit_chain_actor;
DROP INDEX IF EXISTS idx_audit_chain_sequence;
DROP TABLE IF EXISTS audit_chain;
