/**
 * Dual-credential storage client for Cloudflare R2 / AWS S3 (#400).
 *
 * Both R2 and S3 speak the same S3 API, so this wrapper holds two
 * S3-compatible credential slots:
 *
 *   - primary   — the active key, used for every new request
 *   - secondary — the incoming key during a rotation window
 *
 * Zero-downtime contract: an operation always tries the primary first and
 * transparently retries once with the secondary when the primary is rejected
 * (auth failures only — we do not retry data-plane errors like NoSuchKey, so
 * genuine object errors surface unchanged). In-flight uploads signed with the
 * retiring key therefore keep succeeding while rotation happens.
 *
 * Provider calls go through the `StorageObjectStore` port so unit tests can
 * assert rotation behaviour without network access, mirroring the injectable
 * fetch pattern used by `HttpCtLogSubmitter`.
 */

import type {
  RotatingStorageClientConfig,
  RotatingStorageOperationResult,
  StorageCredentials,
  StorageKeyPair,
} from "@delegolabs/types";

/** Object-store operations the rotating client needs, provider-agnostic. */
export interface StorageObjectStore {
  /** Verifies a key works (e.g. HEAD bucket / GetBucketLocation). */
  verify(key: StorageKeyPair): Promise<void>;
  /** Executes the actual data-plane operation with the given key. */
  execute<T>(key: StorageKeyPair, operation: StorageOperation<T>): Promise<T>;
}

/**
 * A single object-store operation. Receives the credential pair being used so
 * the S3 client can re-sign per attempt (the credentials are part of the
 * signature, so they cannot be fixed at client construction time).
 */
export interface StorageOperation<T> {
  description: string;
  run(credentials: StorageCredentials): Promise<T>;
}

/** Auth errors that warrant falling back to the other credential slot. */
export const AUTH_ERROR_PATTERN =
  /(InvalidAccessKeyId|SignatureDoesNotMatch|AccessDenied|401|403)/i;

export function isAuthError(err: unknown): boolean {
  const message =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : JSON.stringify(err ?? {});
  return AUTH_ERROR_PATTERN.test(message);
}

function makeKeyPair(keyId: string, secret: string, expiresAt?: string): StorageKeyPair {
  return {
    keyId,
    secret,
    expiresAt: expiresAt ?? "9999-12-31T23:59:59.999Z",
    createdAt: "1970-01-01T00:00:00.000Z",
  };
}

/**
 * Wraps any S3-compatible object store with dual-credential fallback.
 * The credentials currently in effect can be swapped at runtime by the
 * `StorageRotationService` without interrupting in-flight operations.
 */
export class RotatingStorageClient {
  private primary: StorageKeyPair;
  private secondary?: StorageKeyPair;
  private readonly store: StorageObjectStore;
  private fallbackActivations = 0;

  constructor(config: RotatingStorageClientConfig, store: StorageObjectStore) {
    this.primary = makeKeyPair(
      config.credentials.primaryKeyId,
      config.credentials.primarySecret,
      config.primaryExpiresAt,
    );
    if (config.credentials.secondaryKeyId && config.credentials.secondarySecret) {
      this.secondary = makeKeyPair(
        config.credentials.secondaryKeyId,
        config.credentials.secondarySecret,
        config.secondaryExpiresAt,
      );
    }
    this.store = store;
  }

  get credentials(): StorageCredentials {
    return {
      primaryKeyId: this.primary.keyId,
      primarySecret: this.primary.secret,
      ...(this.secondary
        ? { secondaryKeyId: this.secondary.keyId, secondarySecret: this.secondary.secret }
        : {}),
    };
  }

  /** Ids of the keys currently held in each slot (secrets never exposed). */
  get keyIds(): { primary?: string; secondary?: string } {
    return { primary: this.primary?.keyId, secondary: this.secondary?.keyId };
  }

  get fallbackCount(): number {
    return this.fallbackActivations;
  }

  /**
   * Runs an operation with automatic credential fallback:
   * primary → (on auth failure) → secondary → (on auth failure) error.
   * Only the credentials change between attempts; in-flight requests are
   * never aborted by a rotation.
   */
  async execute<T>(operation: StorageOperation<T>): Promise<RotatingStorageOperationResult<T>> {
    try {
      const result = await this.store.execute(this.primary, operation);
      return { result, keySlot: { slot: "primary", keyId: this.primary.keyId, fallbackUsed: false } };
    } catch (primaryError) {
      if (!this.secondary || !isAuthError(primaryError)) throw primaryError;
      this.fallbackActivations++;
      const failedKeyId = this.primary.keyId;
      const result = await this.store.execute(this.secondary, operation);
      return {
        result,
        keySlot: {
          slot: "secondary",
          keyId: this.secondary.keyId,
          fallbackUsed: true,
          failedKeyId,
        },
      };
    }
  }

  /**
   * Verifies a candidate key with a cheap provider call. Used by the rotation
   * service before promoting the incoming key, so a broken new key never
   * becomes the primary.
   */
  async verifyKey(key: StorageKeyPair): Promise<void> {
    await this.store.verify(key);
  }

  /** Atomically swaps which slot serves new requests (rotation promotion). */
  promoteSecondaryToPrimary(): { promotedKeyId: string; retiringKeyId: string } {
    if (!this.secondary) throw new Error("no secondary credential to promote");
    const retiring = this.primary;
    const promoted = this.secondary;
    this.primary = promoted;
    this.secondary = retiring;
    return { promotedKeyId: promoted.keyId, retiringKeyId: retiring.keyId };
  }

  /** Replaces the primary credential (e.g. first secondary added out-of-band). */
  setPrimary(key: StorageKeyPair): void {
    this.primary = key;
  }

  /** Installs the incoming key into the secondary slot (rotation step 1). */
  setSecondary(key: StorageKeyPair): void {
    this.secondary = key;
  }

  /** Clears the secondary slot (rotation step 3, after the old key is revoked). */
  clearSecondary(): void {
    this.secondary = undefined;
  }

  get hasSecondary(): boolean {
    return this.secondary !== undefined;
  }

  getSecondary(): StorageKeyPair | undefined {
    return this.secondary;
  }

  getPrimary(): StorageKeyPair {
    return this.primary;
  }
}

/**
 * Minimal S3-shaped store used in tests and as a reference implementation.
 * Records every credential signature so tests can assert that in-flight
 * uploads continue with the retiring key during rotation.
 */
export class InMemoryStorageObjectStore implements StorageObjectStore {
  /** keyId → number of data-plane operations signed with it. */
  readonly usage = new Map<string, number>();
  /** keyIds rejected as auth failures. */
  readonly invalidKeys = new Set<string>();
  /** Objects written, by key. */
  readonly objects = new Map<string, Uint8Array>();
  private readonly latencyMs?: number;

  constructor(options: { latencyMs?: number } = {}) {
    this.latencyMs = options.latencyMs;
  }

  invalidate(keyId: string): void {
    this.invalidKeys.add(keyId);
  }

  async verify(key: StorageKeyPair): Promise<void> {
    if (this.invalidKeys.has(key.keyId)) {
      throw new Error(`InvalidAccessKeyId: ${key.keyId} is not valid`);
    }
  }

  async execute<T>(key: StorageKeyPair, operation: StorageOperation<T>): Promise<T> {
    if (this.invalidKeys.has(key.keyId)) {
      throw new Error(`InvalidAccessKeyId: ${key.keyId} is not valid`);
    }
    if (this.latencyMs !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
    }
    this.usage.set(key.keyId, (this.usage.get(key.keyId) ?? 0) + 1);
    return operation.run({ primaryKeyId: key.keyId, primarySecret: key.secret });
  }

  async putObject(keyName: string, body: Uint8Array, credentials: StorageCredentials): Promise<void> {
    this.objects.set(keyName, body);
    void credentials;
  }

  getObject(keyName: string): Uint8Array | undefined {
    return this.objects.get(keyName);
  }
}
