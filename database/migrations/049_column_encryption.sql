-- Migration: 049_column_encryption
-- Description: Column-level encryption for PII data at rest (Issue #68).
-- Tracks data-encryption-key versions across rotations (zero-downtime dual
-- encryption) and provides an append-only audit table for key access
-- (encrypt/decrypt/rotate), satisfying SOC2/GDPR auditability and the issue's
-- "audit log tracks key access" requirement.

-- Data encryption key version registry.
-- One row per key version minted by KeyRotationManager (packages/utils/src/
-- encryption/rotation.ts). `status` drives which versions are still read
-- (`previous`) vs retired after re-encryption completes. `wrapped_key` holds
-- the KMS/Vault envelope blob (or local key fingerprint) — never a raw key.
CREATE TABLE IF NOT EXISTS encryption_key_versions (
  key_id VARCHAR(255) NOT NULL,
  version INTEGER NOT NULL,
  key_provider VARCHAR(20) NOT NULL CHECK (key_provider IN ('aws_kms', 'vault', 'local')),
  wrapped_key TEXT NOT NULL,
  activated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status VARCHAR(20) NOT NULL DEFAULT 'previous'
    CHECK (status IN ('active', 'previous', 'retired')),
  PRIMARY KEY (key_id, version)
);

CREATE INDEX IF NOT EXISTS idx_encryption_key_versions_status
  ON encryption_key_versions(status) WHERE status = 'active';

COMMENT ON TABLE encryption_key_versions IS
  'Registry of data-encryption-key versions for column-level PII encryption (Issue #68)';
COMMENT ON COLUMN encryption_key_versions.wrapped_key IS
  'Wrapped data key (KMS envelope / Vault transit ciphertext / local fingerprint) — never raw';

-- Append-only key-access audit log.
-- Mirrors the immutability strategy of audit_log (migration 025): BEFORE
-- UPDATE/DELETE triggers reject mutations, so decrypts and rotations are
-- tamper-evident. `encryption_context` is the AAD bound to the ciphertext.
CREATE TABLE IF NOT EXISTS encryption_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  operation VARCHAR(20) NOT NULL CHECK (operation IN ('encrypt', 'decrypt', 'unwrap', 'rotate')),
  table_name TEXT NOT NULL,
  column_name TEXT NOT NULL,
  key_id VARCHAR(255) NOT NULL,
  key_version INTEGER NOT NULL,
  actor_role VARCHAR(32),
  encryption_context JSONB NOT NULL DEFAULT '{}',
  success BOOLEAN NOT NULL DEFAULT TRUE,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_encryption_audit_log_table_column
  ON encryption_audit_log(table_name, column_name);
CREATE INDEX IF NOT EXISTS idx_encryption_audit_log_key
  ON encryption_audit_log(key_id, key_version);
CREATE INDEX IF NOT EXISTS idx_encryption_audit_log_occurred_at
  ON encryption_audit_log(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_encryption_audit_log_success
  ON encryption_audit_log(success) WHERE success = FALSE;

CREATE OR REPLACE FUNCTION encryption_audit_log_prevent_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'encryption_audit_log is append-only: % is not permitted (id=%)', TG_OP, OLD.id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_encryption_audit_log_no_update ON encryption_audit_log;
CREATE TRIGGER trg_encryption_audit_log_no_update
  BEFORE UPDATE ON encryption_audit_log
  FOR EACH ROW EXECUTE FUNCTION encryption_audit_log_prevent_mutation();

DROP TRIGGER IF EXISTS trg_encryption_audit_log_no_delete ON encryption_audit_log;
CREATE TRIGGER trg_encryption_audit_log_no_delete
  BEFORE DELETE ON encryption_audit_log
  FOR EACH ROW EXECUTE FUNCTION encryption_audit_log_prevent_mutation();

COMMENT ON TABLE encryption_audit_log IS
  'Append-only, tamper-evident audit of key access for column-level PII encryption (Issue #68)';

-- Down migration (manual rollback)
-- DROP TRIGGER IF EXISTS trg_encryption_audit_log_no_delete ON encryption_audit_log;
-- DROP TRIGGER IF EXISTS trg_encryption_audit_log_no_update ON encryption_audit_log;
-- DROP FUNCTION IF EXISTS encryption_audit_log_prevent_mutation();
-- DROP TABLE IF EXISTS encryption_audit_log;
-- DROP TABLE IF EXISTS encryption_key_versions;