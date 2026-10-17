/**
 * Carrier Tracking Webhook Receiver (Issue #291).
 *
 * Ingests EasyPost (extensible to FedEx / UPS) tracking updates, verifies
 * the HMAC webhook signature, and pushes normalized events to a BullMQ
 * processing queue. The HTTP route must respond 200 within 500ms — so it
 * only validates + enqueues and never awaits downstream processing.
 *
 * Scope: apps/backend/payments/src/webhooks/carrierWebhook.ts
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createLogger } from "@delegolabs/utils";

const log = createLogger("payments:webhooks:carrier", process.env.LOG_LEVEL ?? "info");

// ---------------------------------------------------------------------------
// Types (from issue #291)
// ---------------------------------------------------------------------------

export type CarrierTrackingStatus =
  | "pre_transit"
  | "in_transit"
  | "out_for_delivery"
  | "delivered"
  | "return_to_sender"
  | "failure";

export interface EasyPostTrackingDetail {
  status: string;
  message: string;
  datetime: string;
  source: string;
}

export interface EasyPostTrackingWebhook {
  id: string;
  description: "tracker.updated";
  result: {
    tracking_code: string;
    status: CarrierTrackingStatus;
    status_detail: string;
    carrier: string;
    est_delivery_date: string;
    tracking_details: EasyPostTrackingDetail[];
  };
}

/**
 * Provider-agnostic normalized event pushed to the processing queue.
 * `provider` defaults to "easypost" — FedEx / UPS mappers can reuse this
 * shape later without changing consumers.
 */
export interface NormalizedCarrierEvent {
  eventId: string;
  provider: string;
  trackingCode: string;
  carrier: string;
  status: CarrierTrackingStatus;
  statusDetail: string;
  estDeliveryDate: string;
  detailCount: number;
  latestMessage: string | null;
  receivedAt: string;
}

export interface CarrierWebhookValidationError {
  code: "VALIDATION_ERROR";
  message: string;
}

const ALLOWED_STATUSES: readonly CarrierTrackingStatus[] = [
  "pre_transit",
  "in_transit",
  "out_for_delivery",
  "delivered",
  "return_to_sender",
  "failure",
];

// ---------------------------------------------------------------------------
// Secret
// ---------------------------------------------------------------------------

/** Dedicated secret for carrier webhooks — never reuse the escrow secret. */
export function getCarrierWebhookSecret(): string | null {
  return (
    process.env.EASYPOST_WEBHOOK_SECRET ??
    process.env.CARRIER_WEBHOOK_SECRET ??
    null
  );
}

/** Header names accepted for the HMAC signature (EasyPost-compatible). */
export const CARRIER_SIGNATURE_HEADERS = [
  "x-easypost-hmac-sha256",
  "x-hmac-signature",
  "x-webhook-signature",
  "x-signature",
  "x-hub-signature-256",
] as const;

export function extractCarrierSignature(
  headers: Record<string, string | string[] | undefined>
): string | undefined {
  for (const name of CARRIER_SIGNATURE_HEADERS) {
    const raw = headers[name] ?? headers[name.toLowerCase()];
    if (Array.isArray(raw)) return raw[0];
    if (typeof raw === "string" && raw.length > 0) return raw;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Timing-safe HMAC verification (Issue #351)
// ---------------------------------------------------------------------------

/** Accepts a "sha256=<hex>" style prefix in addition to a bare hex digest. */
function stripSignaturePrefix(signature: string): string {
  const trimmed = signature.trim();
  const eq = trimmed.indexOf("=");
  if (eq > 0 && /^[a-z0-9]+$/i.test(trimmed.slice(0, eq))) {
    return trimmed.slice(eq + 1);
  }
  return trimmed;
}

/**
 * Timing-safe HMAC-SHA256 verification for incoming carrier webhooks.
 *
 * `crypto.timingSafeEqual` throws a `RangeError` when its two buffers have
 * different lengths, so comparing a trusted `expected` digest directly
 * against an attacker-controlled `providedSignature` of arbitrary length
 * can't use it without first branching on `.length` — and an early return
 * on that branch alone is its own (minor) length-oracle side channel.
 *
 * Both signatures are instead re-hashed to a fixed-size SHA-256 digest
 * before the constant-time comparison. Digests are always 32 bytes
 * regardless of the input length, so `timingSafeEqual` can run
 * unconditionally — no length check, no early return, no exception.
 */
export function timingSafeHmacVerify(
  payload: string | Buffer,
  secret: string,
  providedSignature: string | undefined | null
): boolean {
  if (!secret) {
    return false;
  }

  const expected = createHmac("sha256", secret).update(payload).digest("hex");
  const provided = stripSignaturePrefix(providedSignature ?? "");

  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  const providedDigest = createHash("sha256").update(provided, "utf8").digest();

  return timingSafeEqual(providedDigest, expectedDigest);
}

// ---------------------------------------------------------------------------
// Validation + normalization
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateEasyPostPayload(
  body: unknown
): { ok: true; value: EasyPostTrackingWebhook } | { ok: false; error: CarrierWebhookValidationError } {
  if (!isRecord(body)) {
    return { ok: false, error: { code: "VALIDATION_ERROR", message: "Request body must be a JSON object" } };
  }
  const { id, description, result } = body;
  if (typeof id !== "string" || !id) {
    return { ok: false, error: { code: "VALIDATION_ERROR", message: "id is required" } };
  }
  if (description !== "tracker.updated") {
    return {
      ok: false,
      error: { code: "VALIDATION_ERROR", message: 'description must be "tracker.updated"' },
    };
  }
  if (!isRecord(result)) {
    return { ok: false, error: { code: "VALIDATION_ERROR", message: "result is required" } };
  }
  const { tracking_code, status, carrier, tracking_details } = result as Record<string, unknown>;
  if (typeof tracking_code !== "string" || !tracking_code) {
    return { ok: false, error: { code: "VALIDATION_ERROR", message: "result.tracking_code is required" } };
  }
  if (typeof status !== "string" || !(ALLOWED_STATUSES as readonly string[]).includes(status)) {
    return {
      ok: false,
      error: {
        code: "VALIDATION_ERROR",
        message: `result.status must be one of: ${ALLOWED_STATUSES.join(", ")}`,
      },
    };
  }
  if (typeof carrier !== "string" || !carrier) {
    return { ok: false, error: { code: "VALIDATION_ERROR", message: "result.carrier is required" } };
  }
  if (tracking_details !== undefined && !Array.isArray(tracking_details)) {
    return {
      ok: false,
      error: { code: "VALIDATION_ERROR", message: "result.tracking_details must be an array" },
    };
  }

  const payload = body as unknown as EasyPostTrackingWebhook;
  log.debug("Validated EasyPost tracking webhook", {
    id: payload.id,
    trackingCode: payload.result.tracking_code,
    status: payload.result.status,
  });
  return { ok: true, value: payload };
}

export function normalizeEasyPostEvent(
  payload: EasyPostTrackingWebhook,
  provider = "easypost"
): NormalizedCarrierEvent {
  const details = Array.isArray(payload.result.tracking_details)
    ? payload.result.tracking_details
    : [];
  const latest = details.length > 0 ? details[details.length - 1] : null;
  return {
    eventId: payload.id,
    provider,
    trackingCode: payload.result.tracking_code,
    carrier: payload.result.carrier,
    status: payload.result.status,
    statusDetail: payload.result.status_detail ?? "",
    estDeliveryDate: payload.result.est_delivery_date ?? "",
    detailCount: details.length,
    latestMessage: latest ? `${latest.status}: ${latest.message}` : null,
    receivedAt: new Date().toISOString(),
  };
}
