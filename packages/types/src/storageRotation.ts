/**
 * Object-storage credential rotation types (#400).
 *
 * Cloudflare R2 and AWS S3 access keys are rotated every 90 days with zero
 * downtime. The rotation strategy is dual-credential fallback:
 *
 *   1. A new key is added alongside the active one (as the secondary slot) so
 *      two independently-valid credentials exist at all times.
 *   2. In-flight requests signed with the retiring key keep succeeding while
 *      the old key remains valid during a grace period.
 *   3. Only once the new primary has been verified (a real object-store call)
 *      does the old key get scheduled for revocation — so an in-flight upload
 *      signed with the retiring key never fails mid-rotation.
 *
 * Both Cloudflare R2 and AWS S3 are S3-compatible, so a single
 * S3-API-shaped credential pair describes each key for either provider.
 */

/** A single S3-compatible access key pair (R2 API token or AWS IAM key). */
export interface StorageKeyPair {
  keyId: string;
  secret: string;
  /** Provider-assigned identifier (R2 token ID / AWS IAM access key id). */
  providerKeyId?: string;
  /** ISO 8601 timestamp when this key was created/activated. */
  createdAt: string;
  /** ISO 8601 timestamp after which the key must no longer be used. */
  expiresAt: string;
  /** True when the key has been revoked at the provider (or simulated). */
  revoked?: boolean;
}

/**
 * Dual-credential set held by the rotating storage client, exactly as
 * specified in the issue. The primary slot serves normal traffic; the
 * secondary slot is the incoming key during a rotation window.
 */
export interface StorageCredentials {
  primaryKeyId: string;
  primarySecret: string;
  secondaryKeyId?: string;
  secondarySecret?: string;
}

/** Which credential slot a request was served with, plus rotation metadata. */
export interface StorageKeySlotInfo {
  slot: "primary" | "secondary";
  keyId: string;
  /** True when the request only succeeded after the primary failed. */
  fallbackUsed: boolean;
  /** Key id that failed (and triggered the fallback), if any. */
  failedKeyId?: string;
}

export type RotationPhase =
  /** Single key in service, rotation not started. */
  | "idle"
  /** New key created and placed in the secondary slot; both keys valid. */
  | "dual_active"
  /** Secondary promoted to primary and verified; old key in grace period. */
  | "grace_period"
  /** Old key revoked; rotation complete. */
  | "rotated";

/** A scheduled rotation for one provider/bucket binding. */
export interface StorageKeyRotation {
  /** Provider-scoped identity, e.g. `r2:delego-uploads` or `s3:delego-uploads`. */
  bindingId: string;
  provider: "r2" | "s3";
  phase: RotationPhase;
  /** Key currently serving new requests. */
  activeKeyId: string;
  /** Key being retired (still valid during dual_active / grace_period). */
  retiringKeyId?: string;
  /** ISO 8601 — when the rotation completed, if it has. */
  lastRotatedAt?: string;
  /** ISO 8601 — when the active key is due for its next rotation. */
  nextRotationAt: string;
}

export interface StorageKeyRotationMetrics {
  rotationsCompleted: number;
  rotationsFailed: number;
  /** Requests served after falling back to the secondary credential. */
  fallbackActivations: number;
  lastRotationAt?: string;
  lastRotationDurationMs?: number;
  lastRotationError?: string;
}

/** Severity levels for storage-key expiry alerts. */
export type StorageKeyAlertSeverity = "info" | "warning" | "critical";

export interface StorageKeyExpiryAlert {
  keyId: string;
  bindingId: string;
  severity: StorageKeyAlertSeverity;
  /** e.g. "key_expiring" | "key_expired" | "no_secondary" | "rotation_overdue" */
  reason: string;
  message: string;
  /** ISO 8601 expiry of the key the alert refers to, when applicable. */
  expiresAt?: string;
  /** ISO 8601 timestamp the alert was raised. */
  raisedAt: string;
}

export interface StorageKeyExpiryAlertOptions {
  /** Days remaining before an alert escalates to `warning`. Default: 14. */
  warnDays?: number;
  /** Days remaining before an alert escalates to `critical`. Default: 7. */
  criticalDays?: number;
}

/** Credential payload handed to the storage client factory. */
export interface RotatingStorageClientConfig {
  bindingId: string;
  provider: "r2" | "s3";
  region?: string;
  endpoint?: string;
  bucket: string;
  credentials: StorageCredentials;
  /** ISO 8601 expiry for the primary key (used for expiry alerts). */
  primaryExpiresAt?: string;
  /** ISO 8601 expiry for the secondary key, when present. */
  secondaryExpiresAt?: string;
  /** Overrides the wall clock for deterministic tests. */
  now?: () => Date;
}

/** Result of one object-store operation executed by the rotating client. */
export interface RotatingStorageOperationResult<T> {
  result: T;
  /** Which credential slot ultimately served the request. */
  keySlot: StorageKeySlotInfo;
}
