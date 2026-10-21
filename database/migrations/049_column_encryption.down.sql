-- Down migration for 049_column_encryption (Issue #68)
DROP TRIGGER IF EXISTS trg_encryption_audit_log_no_delete ON encryption_audit_log;
DROP TRIGGER IF EXISTS trg_encryption_audit_log_no_update ON encryption_audit_log;
DROP FUNCTION IF EXISTS encryption_audit_log_prevent_mutation();
DROP TABLE IF EXISTS encryption_audit_log;
DROP TABLE IF EXISTS encryption_key_versions;