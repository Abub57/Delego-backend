/**
 * Webhook secret rotation service (Issue #381).
 *
 * Allows merchants to rotate their webhook signing secrets while maintaining
 * a 48-hour grace period during which payloads are dual-signed with both the
 * new and the previous secret. Receivers can verify against either signature
 * so they have time to update their verification logic without downtime.
 *
 * Lifecycle:
 *   1. rotate(webhookId)  — generates a new secret; the current secret becomes
 *      `previousSecret` and `rotationDeadline` is set 48 h from now.
 *   2. signBoth(body)     — during the grace period, returns signatures for
 *      both `currentSecret` and `previousSecret` so the dispatcher can send
 *      both headers.
 *   3. cleanExpiredSecrets() — idempotent sweep that drops `previousSecret`
 *      and `rotationDeadline` from any webhook whose deadline has passed.
 */

import { createLogger } from "@delegolabs/utils";
import { randomBytes } from "node:crypto";
import { signWebhookPayload } from "./hmac.js";
import { ROTATION_GRACE_PERIOD_MS, type SecretRotationState } from "./types.js";

const log = createLogger("notifications:webhooks:secretRotation", process.env.LOG_LEVEL ?? "info");

/** The result of dual-signing a payload during the grace period. */
export interface DualSignResult {
  /** Signature computed with the new (current) secret. */
  current: string;
  /** Signature computed with the previous secret, present only in grace period. */
  previous?: string;
}

export class WebhookSecretRotationService {
  /** In-memory rotation state keyed by webhookId. */
  private states: Map<string, SecretRotationState> = new Map();

  /**
   * Initiate a secret rotation for `webhookId`.
   *
   * - If the webhook already has a rotation state, its `currentSecret` becomes
   *   the new `previousSecret` (chaining rotations).
   * - A fresh 64-hex-char secret is generated as the new `currentSecret`.
   * - `rotationDeadline` is set to `now + ROTATION_GRACE_PERIOD_MS`.
   *
   * @returns The new {@link SecretRotationState}.
   */
  rotate(webhookId: string, currentSecret: string, now = new Date()): SecretRotationState {
    const rotationDeadline = new Date(now.getTime() + ROTATION_GRACE_PERIOD_MS);
    const newSecret = randomBytes(32).toString("hex");

    const state: SecretRotationState = {
      currentSecret: newSecret,
      previousSecret: currentSecret,
      rotationDeadline,
    };

    this.states.set(webhookId, state);

    log.info("Webhook secret rotated", {
      webhookId,
      rotationDeadline: rotationDeadline.toISOString(),
    });

    return state;
  }

  /**
   * Return the active {@link SecretRotationState} for a webhook, or
   * `undefined` if no rotation has been initiated.
   */
  getState(webhookId: string): SecretRotationState | undefined {
    return this.states.get(webhookId);
  }

  /**
   * Set an externally-sourced rotation state (e.g. loaded from the database
   * after a service restart).
   */
  setState(webhookId: string, state: SecretRotationState): void {
    this.states.set(webhookId, state);
  }

  /**
   * Returns `true` if `webhookId` is currently within its grace period
   * (i.e. has a `previousSecret` whose `rotationDeadline` has not yet passed).
   */
  isInGracePeriod(webhookId: string, now = new Date()): boolean {
    const state = this.states.get(webhookId);
    if (!state?.previousSecret || !state.rotationDeadline) return false;
    return state.rotationDeadline.getTime() > now.getTime();
  }

  /**
   * Sign `rawBody` with the current secret and, if within the grace period,
   * also with the previous secret.
   *
   * @returns {@link DualSignResult} — always has `current`; `previous` is
   *   populated only during the grace period.
   */
  sign(webhookId: string, rawBody: string, now = new Date()): DualSignResult {
    const state = this.states.get(webhookId);

    if (!state) {
      throw new Error(`No rotation state found for webhook: ${webhookId}`);
    }

    const current = signWebhookPayload(rawBody, state.currentSecret);

    if (this.isInGracePeriod(webhookId, now) && state.previousSecret) {
      const previous = signWebhookPayload(rawBody, state.previousSecret);
      return { current, previous };
    }

    return { current };
  }

  /**
   * Drop `previousSecret` and `rotationDeadline` for any webhook whose
   * rotation deadline has passed. Should be called periodically (e.g. by a
   * scheduled job or before each dispatch).
   *
   * @returns The number of webhooks that were cleaned up.
   */
  cleanExpiredSecrets(now = new Date()): number {
    let cleaned = 0;

    for (const [webhookId, state] of this.states.entries()) {
      if (
        state.previousSecret &&
        state.rotationDeadline &&
        state.rotationDeadline.getTime() <= now.getTime()
      ) {
        this.states.set(webhookId, { currentSecret: state.currentSecret });
        cleaned += 1;

        log.info("Expired previous webhook secret removed", {
          webhookId,
          expiredAt: state.rotationDeadline.toISOString(),
        });
      }
    }

    return cleaned;
  }

  /**
   * Remove all rotation state for a webhook (e.g. when the webhook is deleted).
   */
  remove(webhookId: string): boolean {
    return this.states.delete(webhookId);
  }

  /** Wipe all state — useful in tests. */
  clear(): void {
    this.states.clear();
  }
}

export const defaultSecretRotationService = new WebhookSecretRotationService();
