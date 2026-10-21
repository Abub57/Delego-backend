/**
 * HMAC signing for outbound webhook deliveries (Issue #102, #112, #381).
 *
 * Mirrors the verification side in
 * apps/backend/payments/src/autoRelease/hmac.ts (which verifies an
 * *inbound* webhook), but this signs our own *outbound* payloads so
 * receivers can verify authenticity, in the same "sha256=<hex>" style.
 *
 * Issue #381 adds dual-signing support: during a secret-rotation grace period
 * both `X-Delego-Signature` (new secret) and `X-Delego-Signature-Previous`
 * (old secret) headers are sent so receivers can verify against either key
 * while they roll out their updated secrets.
 */

import { createHmac } from "node:crypto";

// Issue #112: Changed from X-Webhook-Signature to X-Delego-Signature for webhook signature header
export const WEBHOOK_SIGNATURE_HEADER = "X-Delego-Signature";

/**
 * Header carrying the *previous* signature during a rotation grace period
 * (Issue #381). Receivers should accept a delivery if either signature header
 * matches their stored secret.
 */
export const WEBHOOK_SIGNATURE_PREVIOUS_HEADER = "X-Delego-Signature-Previous";

/**
 * Webhook payload format for outbound deliveries.
 */
export interface WebhookPayload<T = unknown> {
  id: string; // event id
  event: "order.created" | "escrow.funded" | "escrow.released" | "dispute.opened";
  timestamp: string;
  data: T;
}

/**
 * Sign `rawBody` with `secret`, returning a "sha256=<hex>" signature
 * suitable for the `X-Delego-Signature` delivery header.
 */
export function signWebhookPayload(rawBody: string, secret: string): string {
  const digest = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  return `sha256=${digest}`;
}

/**
 * Dual-sign `rawBody` with both `currentSecret` and (when provided)
 * `previousSecret`. Returns an object whose keys map directly to the headers
 * that should be included in the delivery request (Issue #381).
 *
 * When `previousSecret` is absent (no active rotation), only the
 * `X-Delego-Signature` entry is returned.
 */
export function signWebhookPayloadDual(
  rawBody: string,
  currentSecret: string,
  previousSecret?: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    [WEBHOOK_SIGNATURE_HEADER]: signWebhookPayload(rawBody, currentSecret),
  };

  if (previousSecret) {
    headers[WEBHOOK_SIGNATURE_PREVIOUS_HEADER] = signWebhookPayload(rawBody, previousSecret);
  }

  return headers;
}
