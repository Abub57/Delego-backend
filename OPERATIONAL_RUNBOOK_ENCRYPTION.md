# Operational Runbook: Column-Level Encryption for PII (Issue #68)

## Summary

PII columns are encrypted at rest with AES-256-GCM (default) or AES-256-CBC
(legacy migration path). Data keys are wrapped per version via an external
KMS (AWS KMS or HashiCorp Vault Transit) or derived locally (dev only);
only the wrapped copy is ever persisted. Every encrypt/decrypt/rotate is
logged in an append-only audit table. This document covers day-to-day
operation, key rotation, and incident handling.

## Quick Reference

### Health Check

```sql
-- Active data-key versions (should be exactly one 'active')
SELECT key_id, version, key_provider, status, activated_at
FROM encryption_key_versions
WHERE status IN ('active', 'previous')
ORDER BY key_id, version;

-- Failed key-access attempts (spot-check for enumeration / misconfig)
SELECT table_name, column_name, actor_role, error, occurred_at
FROM encryption_audit_log
WHERE success = FALSE
ORDER BY occurred_at DESC
LIMIT 20;
```

### Common Commands

```bash
# Confirm all services booted with a real key provider (not the dev fallback)
node scripts/setup/health.js  # or your service health endpoint

# Benchmark per-field encryption latency (acceptance: < 2ms / field)
pnpm db:encryption-benchmark
```

### Key Facts

- Provider is `local`, `aws_kms`, or `vault` (env `ENCRYPTION_KEY_PROVIDER`).
- The provider is **read-only after boot**: no automatic rotation. Rotation is
  an explicit, operator-initiated run (below).
- Denied decrypts are audited too, so access-control regressions are visible in
  `encryption_audit_log`.
- If `ENCRYPTION_MASTER_KEY` is absent in a non-dev environment, the local
  provider refuses to boot (`defaultMasterSecret` throws) rather than
  silently using an insecure default.

## Key Rotation (zero-downtime, dual-encryption window)

Rotation mints a new data-key version and keeps the previous one readable
for the entire window — old rows decrypt until re-encryption backfills them.

1. Prepare the new version's material.
   - `local`: set `ENCRYPTION_MASTER_KEY_V<N+1>` and deploy config.
   - `aws_kms`: nothing extra (envelope wraps under the same KMS key).
   - `vault`: nothing extra (Transit derives per-version data keys).
2. Deploy code and config **without** enabling re-encryption.
3. Trigger rotation: start the rotation path (`KeyRotationManager.beginRotation`),
   which mints version N+1, records it in `encryption_key_versions` (status
   `active`), demotes N to `previous`, and promotes the provider's active
   version so new writes target N+1. Because old rows keep their `keyVersion`
   field, they still decrypt with N.
4. Run the re-encryption backfill over PII columns:
   ```sql
   -- Match values whose key_version is still the previous one
   SELECT table_name, column_name, id
   FROM users u
   WHERE u.encryption_key_version < N+1;
   ```
   Backfill operators must re-encrypt in old->new table order and update
   each row's `keyVersion` atomically with its ciphertext.
5. Verify dual decryption throughout the window (both `previous` and `active`
   versions present).
6. On completion, retire the old version: set status `retired`, and after the
   retention period remove obsolete master secrets / wrapped keys.

## Audit & Forensics

```sql
-- Everything touching a given PII column
SELECT operation, key_version, actor_role, success, error, occurred_at
FROM encryption_audit_log
WHERE table_name = 'users' AND column_name = 'email'
ORDER BY occurred_at DESC
LIMIT 100;

-- Rotation history
SELECT key_id, version, key_provider, status, activated_at
FROM encryption_key_versions
ORDER BY activated_at;
```

The `encryption_audit_log` table is append-only: UPDATE/DELETE triggers reject
mutation, which makes tampering evident (matching the strategy of `audit_log`,
migration 025).

## Recovery Scenarios

| Symptom | Likely cause | Action |
|---------|--------------|--------|
| Decrypt failures across a column | Wrapped key for that version missing from provider store | Re-mint/restore the version's wrapped key; do NOT rotate again blindly |
| `defaultMasterSecret` exception at boot | `ENCRYPTION_MASTER_KEY` unset in prod | Set the real master secret, restart |
| Benchmarks exceed 2ms/field | Data-key cache cold (post-restart) or provider latency | Warm the provider key cache at startup; investigate KMS/Vault latency |
| Unauthorized decrypts in audit | Access control misconfig | Fix registry roles; revoke + rotate if key material compromised |
| `ENCRYPTION_ACTIVE_KEY_VERSION` inconsistent | Config drift | Make active version match (`encryption_key_versions` `active` row) |

## Security Notes

- Never log plaintext or unwrapped keys; the module never returns raw key bytes
  to callers.
- The blind index (HMAC-SHA256) used for equality lookups derives from the
  column value + namespace, not the data key, so indexed queries still work
  after rotation.
- Rotation requires access to the external KMS; offline services cannot mint
  new versions.

## Related

- Data model: `packages/types/src/pii-registry.ts`
- Implementation: `packages/utils/src/encryption/*`
- Schema: `database/migrations/049_column_encryption.sql`