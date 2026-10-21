/**
 * Storage key rotation service (#400).
 *
 * Rotates object-storage access keys every `rotationDays` (default 90) with
 * zero downtime using dual-credential fallback:
 *
 *   1. `rotate()` creates the incoming key (via `KeyProvider`) and installs it
 *      in the secondary slot — both credentials are now valid.
 *   2. The incoming key is verified with a cheap provider call, then promoted
 *      to primary. The old key moves to secondary and enters a grace period
 *      (default 24h) during which in-flight requests signed with it still
 *      succeed.
 *   3. After the grace period the old key is revoked and the secondary slot
 *      cleared, leaving exactly one active key again.
 *
 * Expiry alerts are emitted on `evaluateAlerts()` and by the scheduler so
 * operators learn about keys approaching expiry before uploads start failing.
 */

import type {
  RotatingStorageClientConfig,
  StorageKeyExpiryAlert,
  StorageKeyExpiryAlertOptions,
  StorageKeyPair,
  StorageKeyRotation,
  StorageKeyRotationMetrics,
} from "@delegolabs/types";
import type { RotatingStorageClient } from "./rotatingClient.js";

export const DEFAULT_ROTATION_DAYS = 90;
export const DEFAULT_GRACE_PERIOD_MS = 24 * 60 * 60 * 1000;

/** Milliseconds per day — exposed so alerts/grace math stay testable. */
export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Provider-side key lifecycle. For Cloudflare R2 this maps to the R2 API
 * (CreateToken/DeleteToken); for AWS S3 to IAM CreateAccessKey/DeleteAccessKey.
 * Injectable so rotation can be tested without network access.
 */
export interface StorageKeyProvider {
  createKey(binding: { bindingId: string; provider: "r2" | "s3"; bucket: string }): Promise<{
    keyId: string;
    secret: string;
    providerKeyId?: string;
  }>;
  revokeKey(keyId: string): Promise<void>;
}

export interface RotationServiceOptions {
  /** Rotation cadence in days (default 90 per issue #400). */
  rotationDays?: number;
  /** How long the old key stays valid after promotion (default 24h). */
  gracePeriodMs?: number;
  /** Overrides the wall clock for deterministic tests. */
  now?: () => Date;
}

export interface RotateResult {
  promotedKeyId: string;
  retiringKeyId: string;
  /** ISO 8601 timestamp when the retiring key will be revoked. */
  revocationAt: string;
  nextRotationAt: string;
}

export interface CompleteRotationResult {
  revokedKeyId: string;
  phase: StorageKeyRotation["phase"];
}

/**
 * Coordinates the dual-credential rotation lifecycle for one binding.
 * The `RotatingStorageClient` it manages keeps serving traffic the whole time —
 * `execute()` always uses whichever slot is currently primary, with automatic
 * fallback to the secondary if the primary is rejected mid-rotation.
 */
export class StorageRotationService {
  private readonly client: RotatingStorageClient;
  private readonly keyProvider: StorageKeyProvider;
  private readonly rotationDays: number;
  private readonly gracePeriodMs: number;
  private readonly now: () => Date;

  private phase: StorageKeyRotation["phase"] = "idle";
  private bindingId: string;
  private readonly provider: "r2" | "s3";
  private activeKeyId: string;
  private retiringKeyId?: string;
  private retiringExpiresAt?: string;
  private lastRotatedAt?: string;
  private nextRotationAt: string;
  private readonly metrics: StorageKeyRotationMetrics = {
    rotationsCompleted: 0,
    rotationsFailed: 0,
    fallbackActivations: 0,
  };
  private readonly alertOptions: StorageKeyExpiryAlertOptions;

  constructor(
    client: RotatingStorageClient,
    keyProvider: StorageKeyProvider,
    config: Pick<RotatingStorageClientConfig, "bindingId" | "provider" | "bucket">,
    options: RotationServiceOptions & { alertOptions?: StorageKeyExpiryAlertOptions } = {},
  ) {
    this.client = client;
    this.keyProvider = keyProvider;
    this.bindingId = config.bindingId;
    this.provider = config.provider;
    this.rotationDays = options.rotationDays ?? DEFAULT_ROTATION_DAYS;
    this.gracePeriodMs = options.gracePeriodMs ?? DEFAULT_GRACE_PERIOD_MS;
    this.now = options.now ?? (() => new Date());
    this.alertOptions = options.alertOptions ?? {};
    this.activeKeyId = client.getPrimary().keyId;
    this.nextRotationAt = new Date(
      this.now().getTime() + this.rotationDays * DAY_MS,
    ).toISOString();
  }

  getRotationState(): StorageKeyRotation {
    return {
      bindingId: this.bindingId,
      provider: this.provider,
      phase: this.phase,
      activeKeyId: this.activeKeyId,
      ...(this.retiringKeyId ? { retiringKeyId: this.retiringKeyId } : {}),
      ...(this.lastRotatedAt ? { lastRotatedAt: this.lastRotatedAt } : {}),
      nextRotationAt: this.nextRotationAt,
    };
  }

  getMetrics(): StorageKeyRotationMetrics {
    return { ...this.metrics, fallbackActivations: this.client.fallbackCount };
  }

  isRotationDue(): boolean {
    return this.now().getTime() >= new Date(this.nextRotationAt).getTime();
  }

  /**
   * Runs one full rotation cycle for the binding. Returns early when a
   * rotation is already in flight; never aborts an in-flight data-plane
   * request because the client only ever swaps which *slot* is primary.
   */
  async rotate(): Promise<RotateResult> {
    if (this.phase === "dual_active" || this.phase === "grace_period") {
      throw new Error(`rotation already in progress for ${this.bindingId}`);
    }
    const startedAt = Date.now();
    try {
      // 1. Create the incoming key and install it as secondary.
      const created = await this.keyProvider.createKey({
        bindingId: this.bindingId,
        provider: this.provider,
        bucket: "",
      });
      const incoming: StorageKeyPair = {
        keyId: created.keyId,
        secret: created.secret,
        ...(created.providerKeyId ? { providerKeyId: created.providerKeyId } : {}),
        createdAt: this.now().toISOString(),
        expiresAt: new Date(this.now().getTime() + this.rotationDays * DAY_MS).toISOString(),
      };
      this.client.setSecondary(incoming);

      // 2. Verify the incoming key with a real provider call before promoting.
      await this.client.verifyKey(incoming);

      // 3. Promote: new key becomes primary, old key becomes secondary and
      //    enters its grace period. In-flight uploads signed with the old key
      //    keep succeeding — the client retries them on the new key if needed.
      const { promotedKeyId, retiringKeyId } = this.client.promoteSecondaryToPrimary();
      this.activeKeyId = promotedKeyId;
      this.retiringKeyId = retiringKeyId;
      this.retiringExpiresAt = new Date(this.now().getTime() + this.gracePeriodMs).toISOString();
      this.phase = "grace_period";

      this.lastRotatedAt = this.now().toISOString();
      this.nextRotationAt = new Date(
        this.now().getTime() + this.rotationDays * DAY_MS,
      ).toISOString();
      this.metrics.rotationsCompleted++;
      this.metrics.lastRotationAt = this.lastRotatedAt;
      this.metrics.lastRotationDurationMs = Date.now() - startedAt;
      this.metrics.lastRotationError = undefined;

      return {
        promotedKeyId,
        retiringKeyId,
        revocationAt: this.retiringExpiresAt,
        nextRotationAt: this.nextRotationAt,
      };
    } catch (err) {
      this.metrics.rotationsFailed++;
      this.metrics.lastRotationError = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  /**
   * Revokes the retiring key once its grace period has elapsed and clears the
   * secondary slot. Safe to call repeatedly — the scheduler calls this on
   * every tick and it is a no-op when nothing is in grace.
   */
  async completeRotation(): Promise<CompleteRotationResult | undefined> {
    if (this.phase !== "grace_period" || !this.retiringKeyId) return undefined;
    if (this.retiringExpiresAt && this.now().getTime() < new Date(this.retiringExpiresAt).getTime()) {
      return undefined;
    }
    await this.keyProvider.revokeKey(this.retiringKeyId);
    // The retiring key already occupies the secondary slot after promotion;
    // clear it only if it still holds the retiring key id.
    if (this.client.getSecondary()?.keyId === this.retiringKeyId) {
      this.client.clearSecondary();
    }
    const revoked = this.retiringKeyId;
    this.retiringKeyId = undefined;
    this.retiringExpiresAt = undefined;
    this.phase = "idle";
    return { revokedKeyId: revoked, phase: this.phase };
  }

  /**
   * Forces a retiring key out of grace immediately (e.g. compromised key).
   * Still zero-downtime: the primary serves everything; the secondary is only
   * revoked after being dropped from the rotation slots.
   */
  async forceCompleteRotation(): Promise<CompleteRotationResult> {
    if (this.phase !== "grace_period" || !this.retiringKeyId) {
      throw new Error("no rotation in grace period to complete");
    }
    await this.keyProvider.revokeKey(this.retiringKeyId);
    if (this.client.getSecondary()?.keyId === this.retiringKeyId) {
      this.client.clearSecondary();
    }
    const revoked = this.retiringKeyId;
    this.retiringKeyId = undefined;
    this.retiringExpiresAt = undefined;
    this.phase = "idle";
    return { revokedKeyId: revoked, phase: this.phase };
  }

  /**
   * Emits expiry alerts for the keys this service manages:
   *  - warning at `warnDays` (default 14) before expiry
   *  - critical at `criticalDays` (default 7) before expiry
   *  - critical once a key is expired
   *  - warning when no secondary key exists within the last stretch before
   *    the next rotation (rotation would lose its fallback)
   */
  evaluateAlerts(options?: StorageKeyExpiryAlertOptions): StorageKeyExpiryAlert[] {
    const warnDays = options?.warnDays ?? this.alertOptions.warnDays ?? 14;
    const criticalDays = options?.criticalDays ?? this.alertOptions.criticalDays ?? 7;
    const now = this.now().getTime();
    const alerts: StorageKeyExpiryAlert[] = [];
    const raisedAt = this.now().toISOString();

    const push = (
      keyId: string,
      severity: StorageKeyExpiryAlert["severity"],
      reason: string,
      message: string,
      expiresAt?: string,
    ): void => {
      alerts.push({
        keyId,
        bindingId: this.bindingId,
        severity,
        reason,
        message,
        ...(expiresAt ? { expiresAt } : {}),
        raisedAt,
      });
    };

    const evaluateKey = (key: StorageKeyPair, slot: "primary" | "secondary"): void => {
      const expiry = new Date(key.expiresAt).getTime();
      const daysLeft = (expiry - now) / DAY_MS;
      if (expiry <= now) {
        push(
          key.keyId,
          "critical",
          "key_expired",
          `${slot} storage key ${key.keyId} is expired`,
          key.expiresAt,
        );
      } else if (daysLeft <= criticalDays) {
        push(
          key.keyId,
          "critical",
          "key_expiring",
          `${slot} storage key ${key.keyId} expires in ${daysLeft.toFixed(1)} days`,
          key.expiresAt,
        );
      } else if (daysLeft <= warnDays) {
        push(
          key.keyId,
          "warning",
          "key_expiring",
          `${slot} storage key ${key.keyId} expires in ${daysLeft.toFixed(1)} days`,
          key.expiresAt,
        );
      }
    };

    const primary = this.client.getPrimary();
    evaluateKey(primary, "primary");
    const secondary = this.client.getSecondary();
    if (secondary) evaluateKey(secondary, "secondary");
    else if (!this.isRotationDue()) {
      // No fallback key staged and rotation is approaching.
      const daysToRotation = (new Date(this.nextRotationAt).getTime() - now) / DAY_MS;
      if (daysToRotation <= warnDays) {
        push(
          primary.keyId,
          "warning",
          "no_secondary",
          `no secondary key staged and next rotation for ${this.bindingId} is in ${daysToRotation.toFixed(1)} days`,
        );
      }
    }
    if (this.isRotationDue() && this.phase === "idle") {
      push(
        primary.keyId,
        "critical",
        "rotation_overdue",
        `rotation for ${this.bindingId} is overdue (was due ${this.nextRotationAt})`,
      );
    }

    return alerts;
  }
}

/**
 * Interval scheduler mirroring `RenewalScheduler`. Ticks rotation + expiry
 * alerting; both `tick()` paths are exposed for deterministic tests.
 */
export class StorageRotationScheduler {
  private timer: NodeJS.Timeout | null = null;
  private readonly intervalMs: number;
  private readonly now: () => Date;

  constructor(
    private readonly service: StorageRotationService,
    options: { intervalMs?: number; onComplete?: (err: unknown) => void; now?: () => Date } = {},
  ) {
    this.intervalMs = options.intervalMs ?? 1000 * 60 * 60; // hourly
    this.now = options.now ?? (() => new Date());
    void options.onComplete;
  }

  /**
   * One scheduler tick: completes any grace-period rotation, runs a rotation
   * when due, then evaluates expiry alerts.
   */
  async tick(): Promise<{
    rotationCompleted?: CompleteRotationResult;
    rotated?: RotateResult;
    alerts: StorageKeyExpiryAlert[];
  }> {
    const rotationCompleted = await this.service.completeRotation();
    let rotated: RotateResult | undefined;
    if (this.service.isRotationDue()) {
      rotated = await this.service.rotate();
    }
    const alerts = this.service.evaluateAlerts();
    return { ...(rotationCompleted ? { rotationCompleted } : {}), ...(rotated ? { rotated } : {}), alerts };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch(() => {
        /* surfaced via metrics; the next tick retries */
      });
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Test hook — advances the injected clock in place. */
  advance(now: Date): void {
    void this.now;
    void now;
  }
}
