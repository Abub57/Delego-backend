/**
 * ColumnEncryptor — application-layer column-level encryption for PII (#68).
 *
 * The single entry point services use to encrypt a PII value before writing
 * it and decrypt it after reading:
 *
 *   const encrypted = await encryptor.encrypt("users", "email", "alice@x.com", context, "system");
 *   const plain     = await encryptor.decrypt("users", "email", encrypted, context, role);
 *
 * It composes the four concerns from issue #68:
 *   - cipher primitives  (AES-256-GCM / CBC, context-bound via AAD)
 *   - key management      (local / aws_kms / vault providers, versioned)
 *   - field access control (only permitted roles can decrypt)
 *   - key-access audit    (every encrypt/decrypt is recorded)
 *
 * Data keys are cached in-process so the hot path is a single synchronous
 * AES round-trip — the <2ms acceptance criterion is met and measured by
 * benchmark.ts.
 */

import type {
  EncryptedField,
  EncryptionConfig,
  FieldAccessRole,
  PiiColumn,
} from "@delegolabs/types";
import { decryptField, encryptField, blindIndex, EncryptionError, hasEncryptionEnvelope } from "./cipher.js";
import type { KeyProvider } from "./keyProvider.js";
import { KeyAccessAuditor } from "./audit.js";
import { FieldAccessController } from "./accessControl.js";

export interface EncryptOptions {
  /** Encryption context / AAD — bind ciphertext to a record, e.g. { userId } or { email }. */
  context?: Record<string, string>;
  /** Decryption role of the calling actor (audit + access control). */
  actorRole?: FieldAccessRole;
  /** Override the configured key version for this write (dual-write during rotation). */
  keyVersion?: number;
}

export interface DecryptOptions {
  context?: Record<string, string>;
  actorRole?: FieldAccessRole;
}

export interface DecryptionResult<T> {
  data: T;
  wasEncrypted: boolean;
  keyVersion?: number;
}

export interface ColumnEncryptorConfig {
  keyProvider: KeyProvider;
  /** Most recent key version = active. Older versions remain decryptable. */
  config: EncryptionConfig;
  access?: FieldAccessController;
  audit?: KeyAccessAuditor;
}

export interface FieldIndex {
  /** Blind (deterministic) index for equality lookups; only for `indexed` columns. */
  blind: string;
}

/**
 * Builds an encryptor from a provider + config, resolving the active key
 * version the first time it's needed.
 */
export class ColumnEncryptor {
  readonly keyProvider: KeyProvider;
  readonly config: EncryptionConfig;
  readonly access: FieldAccessController;
  readonly audit: KeyAccessAuditor;

  constructor(options: ColumnEncryptorConfig) {
    this.keyProvider = options.keyProvider;
    this.config = options.config;
    this.access = options.access ?? new FieldAccessController();
    this.audit = options.audit ?? new KeyAccessAuditor();
  }

  /**
   * The active key version new writes use. Resolved from the provider on
   * every call (a cheap in-memory read) so a rotation that promotes a new
   * version takes effect for writes immediately.
   */
  async activeVersion(): Promise<number> {
    return this.keyProvider.activeVersion();
  }

  /**
   * Encrypt a PII value for storage. Returns the EncryptedField (write the
   * .ciphertext/.iv/.authTag into the DB column, plus for `indexed` columns
   * the blind index into the companion lookup column).
   */
  async encrypt(
    table: string,
    column: string,
    plaintext: string,
    options: EncryptOptions = {}
  ): Promise<EncryptedField & { blindIndex?: string }> {
    this.assertRegistry(table, column);
    const version = options.keyVersion ?? (await this.activeVersion());
    const dataKey = await this.keyProvider.getDataKey(version);
    const context = options.context ?? {};

    const field = encryptField(plaintext, dataKey.key, this.config.algorithm, context);

    // Audit recording is deliberately not part of the hot path (#333) —
    // record() synchronously appends to the in-memory ring buffer before
    // returning, so the record exists immediately for callers of
    // audit.list()/listFor(), but we don't block encrypt() on an async sink
    // write (Postgres, etc.) that could blow the <2ms per-field budget.
    this.recordAudit({
      operation: "encrypt",
      keyId: dataKey.keyId,
      keyVersion: version,
      table,
      column,
      context,
      actorRole: options.actorRole ?? "system",
      success: true,
    });

    const result: EncryptedField & { blindIndex?: string } = {
      ...field,
      keyVersion: version,
    };
    const piiColumn = this.access.lookupFor(table, column);
    if (piiColumn?.indexed) {
      result.blindIndex = blindIndex(plaintext, dataKey.key, `${table}.${column}`);
    }
    return result;
  }

  /**
   * Decrypt a stored field. Enforces field-level access control (authorized
   * roles only) and records the key use in the audit log.
   */
  async decrypt(
    table: string,
    column: string,
    field: EncryptedField,
    options: DecryptOptions = {}
  ): Promise<{ plaintext: string; index?: string }> {
    const role = options.actorRole ?? "system";
    const decision = this.access.decide(table, column, role);
    if (!decision.allowed) {
      this.recordAudit({
        operation: "decrypt",
        keyId: this.config.keyId,
        keyVersion: field.keyVersion,
        table,
        column,
        context: options.context ?? {},
        actorRole: role,
        success: false,
        error: decision.reason,
      });
      throw new EncryptionError(
        `Access denied decrypting ${table}.${column} for role '${role}': ${decision.reason}`
      );
    }

    const dataKey = await this.keyProvider.getDataKey(field.keyVersion);
    const context = options.context ?? {};

    let plaintext: string;
    try {
      plaintext = decryptField(field, dataKey.key, context);
      this.recordAudit({
        operation: "decrypt",
        keyId: dataKey.keyId,
        keyVersion: field.keyVersion,
        table,
        column,
        context,
        actorRole: role,
        success: true,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.recordAudit({
        operation: "decrypt",
        keyId: dataKey.keyId,
        keyVersion: field.keyVersion,
        table,
        column,
        context,
        actorRole: role,
        success: false,
        error: message,
      });
      throw err;
    }

    const entry = this.access.lookupFor(table, column);
    const result: { plaintext: string; index?: string } = { plaintext };
    if (entry?.indexed) {
      result.index = blindIndex(plaintext, dataKey.key, `${table}.${column}`);
    }
    return result;
  }

  /**
   * Safely decrypt a field with graceful fallback for legacy plaintext data.
   * 
   * When reading historical data created before encryption was enabled, this method:
   * 1. Checks for the encryption envelope prefix (enc:v1:)
   * 2. If present, decrypts the data normally
   * 3. If absent, returns the plaintext with wasEncrypted=false
   * 
   * This prevents "Unsupported state or unable to authenticate data" errors
   * when loading legacy order notes and other historical PII fields.
   * 
   * Returns DecryptionResult with:
   *   - data: the plaintext value (decrypted or passthrough)
   *   - wasEncrypted: true if data was encrypted, false for legacy plaintext
   *   - keyVersion: the key version used (only when wasEncrypted=true)
   */
  async decryptSafe(
    table: string,
    column: string,
    value: string | EncryptedField,
    options: DecryptOptions = {}
  ): Promise<DecryptionResult<string>> {
    // Handle string values (database column value)
    if (typeof value === "string") {
      // Check for encryption envelope prefix
      if (!hasEncryptionEnvelope(value)) {
        // Legacy plaintext - return as-is without decryption
        return {
          data: value,
          wasEncrypted: false,
        };
      }
      
      // If we have envelope but no EncryptedField structure, we can't decrypt
      throw new EncryptionError(
        `Value has encryption envelope but EncryptedField structure is required for decryption`
      );
    }

    // Handle EncryptedField structure
    const field = value as EncryptedField;
    
    // Check if the ciphertext has encryption envelope
    if (!hasEncryptionEnvelope(field.ciphertext)) {
      // Legacy plaintext stored in EncryptedField structure - return ciphertext as plaintext
      return {
        data: field.ciphertext,
        wasEncrypted: false,
      };
    }

    // Modern encrypted data - decrypt normally
    const result = await this.decrypt(table, column, field, options);
    return {
      data: result.plaintext,
      wasEncrypted: true,
      keyVersion: field.keyVersion,
    };
  }

  /** Compute the blind index for an equality lookup without decrypting. */
  async computeIndex(table: string, column: string, value: string): Promise<string> {
    const version = await this.activeVersion();
    const dataKey = await this.keyProvider.getDataKey(version);
    return blindIndex(value, dataKey.key, `${table}.${column}`);
  }

  /**
   * Fire-and-forget audit recording (#333). `KeyAccessAuditor.record()`
   * appends to its in-memory ring buffer synchronously before it reaches
   * any `await`, so the record is visible to `audit.list()`/`listFor()`
   * immediately — but we don't hold the encrypt/decrypt hot path open for
   * whatever an external sink's I/O takes.
   */
  private recordAudit(input: Parameters<KeyAccessAuditor["record"]>[0]): void {
    void this.audit.record(input).catch((err: unknown) => {
      // KeyAccessAuditor.record() already swallows sink errors internally;
      // this only guards against an unexpected throw outside that path.
      const message = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.error("Unexpected error recording key-access audit entry", message);
    });
  }

  private assertRegistry(table: string, column: string): PiiColumn {
    const entry = this.access.lookupFor(table, column);
    if (!entry) {
      throw new EncryptionError(
        `${table}.${column} is not a registered PII column (see pii-registry.ts) — refusing to encrypt`
      );
    }
    return entry;
  }
}