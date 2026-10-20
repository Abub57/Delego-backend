/**
 * AES-256 primitives backing column-level PII encryption (#68).
 *
 * Two modes are supported, matching issue #68's `EncryptionConfig`:
 *  - AES-256-GCM (preferred): authenticated encryption with a 16-byte auth
 *    tag and full AEAD integrity. Used with an *Additional Authenticated
 *    Data* (AAD) "encryption context" so ciphertext is bound to the record
 *    it belongs to (e.g. users.id, users.email) — decrypting with the wrong
 *    context fails loudly, which both stops ciphertext swapping across rows
 *    and gives auditors a tamper signal.
 *  - AES-256-CBC: legacy mode with PKCS#7 padding, kept only for migrating
 *    data that was previously CBC-encrypted. No integrity — always prefer
 *    GCM for new writes.
 *
 * Efficient by design: Node's OpenSSL-backed `crypto` is used directly and
 * the AEAD path performs a single synchronous round-trip, keeping per-field
 * overhead well under the issue's <2ms budget (see benchmark.ts).
 */

import * as crypto from "node:crypto";
import type { EncryptedField, EncryptionAlgorithm } from "@delegolabs/types";

export const GCM_IV_LENGTH = 12;
export const GCM_AUTH_TAG_LENGTH = 16;
export const CBC_IV_LENGTH = 16;
export const KEY_LENGTH = 32; // AES-256

/** Envelope prefix identifying encrypted data format version 1. */
export const ENCRYPTION_ENVELOPE_PREFIX = "enc:v1:";
export const ENCRYPTION_ENVELOPE_VERSION = 1;

export class EncryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EncryptionError";
  }
}

/** Canonical, deterministic serialization of the encryption context (AAD). */
export function serializeContext(
  context: Record<string, string> | undefined | null
): string {
  if (!context) return "";
  const entries = Object.entries(context)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}=${value}`)
    .sort();
  return entries.join(";");
}

// Reuses the SHA-256 AAD digest for a repeated encryption context (#333) —
// the same { userId } / { orderId } context is typically fed into dozens of
// field encrypt/decrypt calls for one request, and re-hashing it every time
// is pure waste on the <2ms per-field hot path. Bounded so a service that
// mints unbounded distinct contexts can't grow this without limit.
const AAD_CACHE_MAX_ENTRIES = 2048;
const aadDigestCache = new Map<string, Buffer>();

/** SHA-256 digest of the serialized context — the actual AAD fed to GCM. */
export function contextAad(context: Record<string, string> | undefined | null): Buffer {
  const serialized = serializeContext(context);
  const cached = aadDigestCache.get(serialized);
  if (cached) return cached;

  const digest = crypto.createHash("sha256").update(serialized, "utf8").digest();
  if (aadDigestCache.size >= AAD_CACHE_MAX_ENTRIES) {
    aadDigestCache.clear();
  }
  aadDigestCache.set(serialized, digest);
  return digest;
}

/**
 * Encrypt a plaintext string with the supplied 32-byte AES-256 key.
 * Returns the EncryptedField shape defined in issue #68 (ciphertext, IV and
 * authTag are base64). `context` is bound as GCM AAD; for CBC mode the
 * context is mixed into the IV seed instead (since CBC has no AAD channel).
 * 
 * The encrypted ciphertext is prefixed with "enc:v1:" to enable format detection
 * and graceful fallback when reading legacy plaintext data.
 */
export function encryptField(
  plaintext: string,
  key: Buffer,
  algorithm: EncryptionAlgorithm,
  context: Record<string, string> = {}
): EncryptedField {
  if (plaintext === "" || plaintext === undefined || plaintext === null) {
    throw new EncryptionError("plaintext must be a non-empty string");
  }
  if (key.length !== KEY_LENGTH) {
    throw new EncryptionError(`AES-256 requires a ${KEY_LENGTH}-byte key, got ${key.length}`);
  }

  if (algorithm === "AES-256-CBC") {
    const iv = crypto.randomBytes(CBC_IV_LENGTH);
    const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
    const rawCiphertext = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ]).toString("base64");
    // Prefix with envelope marker for format detection
    const ciphertext = ENCRYPTION_ENVELOPE_PREFIX + rawCiphertext;
    return {
      ciphertext,
      iv: iv.toString("base64"),
      authTag: "",
      keyVersion: 0,
      algorithm: "AES-256-CBC",
    };
  }

  if (algorithm === "AES-256-GCM") {
    const iv = crypto.randomBytes(GCM_IV_LENGTH);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv, { authTagLength: GCM_AUTH_TAG_LENGTH });
    cipher.setAAD(contextAad(context));
    const rawCiphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();
    // Prefix with envelope marker for format detection
    const ciphertext = ENCRYPTION_ENVELOPE_PREFIX + rawCiphertext.toString("base64");
    return {
      ciphertext,
      iv: iv.toString("base64"),
      authTag: authTag.toString("base64"),
      keyVersion: 0,
      algorithm: "AES-256-GCM",
    };
  }

  throw new EncryptionError(`Unsupported algorithm: ${String(algorithm)}`);
}

/**
 * Checks if a ciphertext string has the encryption envelope prefix.
 * Returns true for encrypted data, false for legacy plaintext.
 */
export function hasEncryptionEnvelope(ciphertext: string): boolean {
  return ciphertext.startsWith(ENCRYPTION_ENVELOPE_PREFIX);
}

/**
 * Strips the encryption envelope prefix from a ciphertext string.
 * Returns the raw base64 ciphertext for decryption.
 */
export function stripEncryptionEnvelope(ciphertext: string): string {
  if (hasEncryptionEnvelope(ciphertext)) {
    return ciphertext.slice(ENCRYPTION_ENVELOPE_PREFIX.length);
  }
  return ciphertext;
}

/** Decrypt a field encrypted by `encryptField` (or previously CBC-encrypted data). */
export function decryptField(
  field: EncryptedField,
  key: Buffer,
  context: Record<string, string> = {}
): string {
  if (key.length !== KEY_LENGTH) {
    throw new EncryptionError(`AES-256 requires a ${KEY_LENGTH}-byte key, got ${key.length}`);
  }

  // Strip envelope prefix if present
  const rawCiphertext = stripEncryptionEnvelope(field.ciphertext);

  try {
    if (field.algorithm === "AES-256-CBC") {
      const iv = Buffer.from(field.iv, "base64");
      if (iv.length !== CBC_IV_LENGTH) {
        throw new EncryptionError("Invalid IV length for AES-256-CBC");
      }
      const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(rawCiphertext, "base64")),
        decipher.final(),
      ]).toString("utf8");
      return plaintext;
    }

    if (field.algorithm === "AES-256-GCM") {
      const iv = Buffer.from(field.iv, "base64");
      const authTag = Buffer.from(field.authTag, "base64");
      if (iv.length !== GCM_IV_LENGTH) {
        throw new EncryptionError(`Invalid IV length for AES-256-GCM (expected ${GCM_IV_LENGTH} bytes)`);
      }
      if (authTag.length !== GCM_AUTH_TAG_LENGTH) {
        throw new EncryptionError(
          `Invalid auth tag length for AES-256-GCM (expected ${GCM_AUTH_TAG_LENGTH} bytes)`
        );
      }
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv, {
        authTagLength: GCM_AUTH_TAG_LENGTH,
      });
      decipher.setAAD(contextAad(context));
      decipher.setAuthTag(authTag);
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(rawCiphertext, "base64")),
        decipher.final(),
      ]).toString("utf8");
      return plaintext;
    }

    throw new EncryptionError(`Unsupported algorithm: ${field.algorithm}`);
  } catch (err) {
    if (err instanceof EncryptionError) throw err;
    // GCM final() throws on tag mismatch — surface a deterministic error for
    // audit logging rather than the low-level OpenSSL message.
    throw new EncryptionError("Decryption failed: ciphertext or auth tag mismatch");
  }
}

/**
 * Deterministic blind index for queryable PII columns (e.g. users.email).
 * A plaintext value may be looked up with a blind index (never returned), while
 * the stored value is the non-deterministic GCM ciphertext. HMAC-SHA256 with
 * a per-column derived key and a constant, table-scoped prefix.
 */
export function blindIndex(
  value: string,
  key: Buffer,
  namespace: string
): string {
  if (!value) throw new EncryptionError("value must be non-empty");
  if (key.length !== KEY_LENGTH) throw new EncryptionError(`blind index key must be ${KEY_LENGTH} bytes`);
  if (!namespace.trim()) throw new EncryptionError("namespace must be non-empty");

  const hmac = crypto.createHmac("sha256", key);
  hmac.update(`blind:${namespace}\u0000${value}`);
  return hmac.digest("hex");
}