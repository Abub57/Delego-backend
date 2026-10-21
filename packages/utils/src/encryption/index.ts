/**
 * #68 — Column-level encryption for PII data at rest.
 *
 * Composition surface for the encryption module:
 *   - cipher.ts        — AES-256-GCM/CBC primitives + blind indexes
 *   - keyProvider.ts   — local / aws_kms / vault data-key providers
 *   - accessControl.ts — field-level access control (registry-driven)
 *   - audit.ts         — key-access audit logging
 *   - columnEncryptor.ts — application-layer encrypt/decrypt facade
 *   - rotation.ts      — zero-downtime key rotation with dual encryption
 *   - benchmark.ts     — per-field latency benchmark
 */

export {
  encryptField,
  decryptField,
  blindIndex,
  serializeContext,
  contextAad,
  hasEncryptionEnvelope,
  stripEncryptionEnvelope,
  EncryptionError,
  GCM_IV_LENGTH,
  GCM_AUTH_TAG_LENGTH,
  CBC_IV_LENGTH,
  KEY_LENGTH,
  ENCRYPTION_ENVELOPE_PREFIX,
  ENCRYPTION_ENVELOPE_VERSION,
} from "./cipher.js";
export {
  createKeyProvider,
  LocalKeyProvider,
  AwsKmsKeyProvider,
  HashicorpVaultKeyProvider,
  InMemoryWrappedKeyStore,
  defaultMasterSecret,
  DEFAULT_ENCRYPTION_MASTER_KEY,
  type KeyProvider,
  type DataKey,
  type KeyProviderName,
  type WrappedKeyStore,
  type KmsCommands,
  type AwsKmsKeyProviderConfig,
  type VaultKeyProviderConfig,
  type AnyKeyProviderConfig,
} from "./keyProvider.js";
export {
  FieldAccessController,
  type FieldAccessControllerOptions,
  type FieldAccessRole,
} from "./accessControl.js";
export {
  KeyAccessAuditor,
  type KeyAccessAuditSink,
  type KeyAccessAuditorOptions,
  type KeyAccessOperation,
  type KeyAccessRecord,
} from "./audit.js";
export {
  ColumnEncryptor,
  type ColumnEncryptorConfig,
  type DecryptOptions,
  type EncryptOptions,
  type DecryptionResult,
} from "./columnEncryptor.js";
export {
  KeyRotationManager,
  dualEncryptField,
  InMemoryEncryptionKeyVersionStore,
  type EncryptionKeyVersionRow,
  type EncryptionKeyVersionStore,
  type KeyRotationManagerOptions,
  type ReEncryptResult,
  type ReEncryptTarget,
} from "./rotation.js";
export {
  runEncryptionBenchmark,
  printEncryptionBenchmark,
  type BenchmarkOptions,
  type BenchmarkResult,
} from "./benchmark.js";
export {
  PostgresEncryptionKeyVersionStore,
  PostgresKeyAccessAuditSink,
  type Queryable,
  type PostgresKeyAccessAuditSinkOptions,
} from "./postgres.js";