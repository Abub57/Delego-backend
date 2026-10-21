/**
 * Courier webhook normalizer (Issue #577).
 *
 * POST /api/v1/courier/webhooks/:carrier  (fedex | ups | dhl)
 *
 * 1. Reads the raw request bytes (the HMAC is computed over the bytes the
 *    carrier sent, never over re-serialised JSON).
 * 2. Verifies an HMAC-SHA256 signature from a per-carrier header against a
 *    per-carrier secret. Missing, malformed or wrong signatures, and carriers
 *    with no configured secret, are rejected with 401.
 * 3. Normalizes the payload with the shared CarrierWebhookNormalizer parsers
 *    and adds `out_for_delivery`, the location and `rawEventId`.
 * 4. Publishes one entry to the `events:shipment:status` Redis stream.
 *
 * This route only publishes. It does not write shipment status itself;
 * consumers of the stream do.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { CarrierWebhookNormalizer, createLogger, json, route } from "@delegolabs/utils";
import type { Route, RouteHandler } from "@delegolabs/utils";
import { getRedisClient } from "../src/rateLimit/redisClient.js";
import { getCapturedBody } from "./webhookBody.js";

const log = createLogger("gateway:courier-webhooks", process.env.LOG_LEVEL ?? "info");

export const SHIPMENT_STATUS_STREAM = "events:shipment:status";

/** Approximate cap on the stream length (XADD MAXLEN ~). */
const STREAM_MAX_LENGTH = 50000;

/** Maximum accepted request body, matching the gateway's /api/v1 JSON limit. */
const BODY_LIMIT_BYTES = 100 * 1024;

export const SUPPORTED_CARRIERS = ["fedex", "ups", "dhl"] as const;
export type SupportedCarrier = (typeof SUPPORTED_CARRIERS)[number];

export interface WebhookNormalizationResult {
  carrier: SupportedCarrier;
  trackingNumber: string;
  normalizedStatus: "in_transit" | "out_for_delivery" | "delivered" | "exception";
  locationCity?: string;
  locationCountry?: string;
  timestamp: string;
  rawEventId: string;
}

/** Request header that carries each carrier's HMAC-SHA256 signature. */
export const SIGNATURE_HEADERS: Record<SupportedCarrier, string> = {
  fedex: "x-fedex-signature",
  ups: "x-ups-signature",
  dhl: "x-dhl-signature",
};

/** Carrier status codes that mean "out for delivery" (the shared parsers fold these into in_transit). */
const OUT_FOR_DELIVERY_CODES: Record<SupportedCarrier, ReadonlySet<string>> = {
  fedex: new Set(["OD", "OUT_FOR_DELIVERY"]),
  ups: new Set(["O", "OUT_FOR_DELIVERY"]),
  dhl: new Set(["OUT_FOR_DELIVERY"]),
};

/** The slice of an ioredis client this route needs. */
export interface StreamPublisher {
  xadd(key: string, ...args: string[]): Promise<unknown>;
}

export interface CourierWebhookOptions {
  /** Redis client used for XADD. Defaults to the shared gateway client. */
  redis?: StreamPublisher;
  /** HMAC secrets per carrier. Defaults to the FEDEX/UPS/DHL_WEBHOOK_SECRET env vars. */
  secrets?: Partial<Record<SupportedCarrier, string | undefined>>;
  /** Clock, injectable for tests. */
  now?: () => Date;
}

class BodyTooLargeError extends Error {
  constructor() {
    super("Request body too large");
    this.name = "BodyTooLargeError";
  }
}

function isSupportedCarrier(value: string | undefined): value is SupportedCarrier {
  return value !== undefined && (SUPPORTED_CARRIERS as readonly string[]).includes(value);
}

function secretsFromEnv(): Partial<Record<SupportedCarrier, string | undefined>> {
  return {
    fedex: process.env.FEDEX_WEBHOOK_SECRET,
    ups: process.env.UPS_WEBHOOK_SECRET,
    dhl: process.env.DHL_WEBHOOK_SECRET,
  };
}

function fail(res: ServerResponse, status: number, code: string, message: string): void {
  json(res, status, { data: null, error: { code, message } });
}

/** Reads the request body as raw bytes, rejecting once it exceeds the limit. */
function readRawBody(req: IncomingMessage, limitBytes: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    req.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      size += buffer.length;
      if (size > limitBytes) {
        settled = true;
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(buffer);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on("error", (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name];
  return Array.isArray(raw) ? raw[0] : raw;
}

function stripSignaturePrefix(signature: string): string {
  const trimmed = signature.trim().toLowerCase();
  return trimmed.startsWith("sha256=") ? trimmed.slice("sha256=".length) : trimmed;
}

/**
 * Timing-safe HMAC-SHA256 check over the raw body. Both hex strings are
 * re-hashed to fixed-size digests first, so the comparison never branches on
 * (or throws because of) the length of an attacker-supplied signature.
 */
export function verifySignature(
  body: Buffer,
  signatureHeader: string | undefined,
  secret: string | undefined,
): boolean {
  if (!secret || !signatureHeader) return false;
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  const provided = stripSignaturePrefix(signatureHeader);
  const expectedDigest = createHash("sha256").update(expected).digest();
  const providedDigest = createHash("sha256").update(provided).digest();
  return timingSafeEqual(expectedDigest, providedDigest);
}

// ---------------------------------------------------------------------------
// Payload helpers. The shared parsers return only tracking number and a coarse
// status, so the raw status code, location and event id are read here.
// ---------------------------------------------------------------------------

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function firstObject(value: unknown): JsonObject | undefined {
  return Array.isArray(value) ? asObject(value[0]) : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

interface CarrierDetails {
  statusCode?: string;
  city?: string;
  country?: string;
}

function fedexDetails(payload: JsonObject): CarrierDetails {
  const result = firstObject(payload.trackResults);
  if (result) {
    const latest = asObject(result.latestStatusDetail);
    const location = asObject(latest?.scanLocation);
    return {
      statusCode: text(latest?.code) ?? text(latest?.statusByLocale) ?? text(result.status),
      city: text(location?.city),
      country: text(location?.countryCode),
    };
  }
  const pkg = firstObject(asObject(payload.TrackPackagesResponse)?.packageList);
  if (pkg) {
    return { statusCode: text(pkg.status) ?? text(pkg.statusCode) };
  }
  const location = asObject(payload.scanLocation);
  return {
    statusCode: text(payload.status) ?? text(payload.statusCode) ?? text(payload.eventType),
    city: text(location?.city),
    country: text(location?.countryCode),
  };
}

function upsDetails(payload: JsonObject): CarrierDetails {
  const response = asObject(payload.TrackResponse) ?? asObject(payload.trackResponse) ?? payload;
  const shipment = asObject(response.shipment) ?? asObject(response.Shipment) ?? response;
  const pkg = firstObject(shipment.package);
  if (pkg) {
    const address = asObject(asObject(firstObject(pkg.activity)?.location)?.address);
    return {
      statusCode: text(asObject(pkg.currentStatus)?.code) ?? text(pkg.status),
      city: text(address?.city),
      country: text(address?.countryCode),
    };
  }
  return {
    statusCode:
      text(shipment.statusCode) ??
      text(shipment.status) ??
      text(payload.statusCode) ??
      text(payload.status),
  };
}

function dhlDetails(payload: JsonObject): CarrierDetails {
  const shipment = firstObject(payload.shipments) ?? firstObject(payload.events);
  if (shipment) {
    const status = asObject(shipment.status);
    const address = asObject(asObject(status?.location)?.address);
    return {
      statusCode: text(status?.statusCode) ?? text(shipment.statusCode) ?? text(shipment.status),
      city: text(address?.addressLocality),
      country: text(address?.countryCode),
    };
  }
  return { statusCode: text(payload.status) ?? text(payload.statusCode) };
}

const DETAIL_EXTRACTORS: Record<SupportedCarrier, (payload: JsonObject) => CarrierDetails> = {
  fedex: fedexDetails,
  ups: upsDetails,
  dhl: dhlDetails,
};

function canonicalCode(code: string): string {
  return code.trim().toUpperCase().replace(/[\s-]+/g, "_");
}

/** Carrier event id when the payload has one, otherwise a stable hash of the raw body. */
function rawEventIdFor(payload: JsonObject, body: Buffer): string {
  return (
    text(payload.eventId) ??
    text(payload.event_id) ??
    text(payload.transactionId) ??
    createHash("sha256").update(body).digest("hex")
  );
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export function createCourierWebhookHandler(options: CourierWebhookOptions = {}): RouteHandler {
  const normalizer = new CarrierWebhookNormalizer();
  const now = options.now ?? (() => new Date());

  return async (req, res, params) => {
    const carrier = params.carrier?.toLowerCase();
    if (!isSupportedCarrier(carrier)) {
      fail(res, 404, "UNSUPPORTED_CARRIER", "Unsupported carrier");
      return;
    }

    let body: Buffer;
    try {
      body = getCapturedBody(req) ?? (await readRawBody(req, BODY_LIMIT_BYTES));
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        fail(res, 413, "PAYLOAD_TOO_LARGE", "Request body exceeds the size limit");
        return;
      }
      log.warn("Failed to read courier webhook body", {
        carrier,
        error: err instanceof Error ? err.message : String(err),
      });
      fail(res, 400, "INVALID_PAYLOAD", "Could not read request body");
      return;
    }

    const secret = (options.secrets ?? secretsFromEnv())[carrier];
    if (!secret) {
      log.warn("Courier webhook rejected: no signing secret configured", { carrier });
    }
    if (!verifySignature(body, headerValue(req, SIGNATURE_HEADERS[carrier]), secret)) {
      fail(res, 401, "INVALID_SIGNATURE", "Invalid or missing webhook signature");
      return;
    }

    let payload: JsonObject | undefined;
    try {
      payload = asObject(JSON.parse(body.toString("utf8")));
    } catch {
      payload = undefined;
    }
    if (!payload) {
      fail(res, 400, "INVALID_PAYLOAD", "Request body must be a JSON object");
      return;
    }

    let normalized: ReturnType<CarrierWebhookNormalizer["normalize"]>;
    try {
      normalized = normalizer.normalize(carrier, payload);
    } catch (err) {
      log.warn("Courier webhook payload could not be normalized", {
        carrier,
        error: err instanceof Error ? err.message : String(err),
      });
      fail(res, 400, "INVALID_PAYLOAD", "Payload could not be normalized");
      return;
    }

    const details = DETAIL_EXTRACTORS[carrier](payload);
    const isOutForDelivery =
      normalized.normalizedStatus === "in_transit" &&
      details.statusCode !== undefined &&
      OUT_FOR_DELIVERY_CODES[carrier].has(canonicalCode(details.statusCode));

    const event: WebhookNormalizationResult = {
      carrier,
      trackingNumber: normalized.trackingNumber,
      normalizedStatus: isOutForDelivery ? "out_for_delivery" : normalized.normalizedStatus,
      ...(details.city ? { locationCity: details.city } : {}),
      ...(details.country ? { locationCountry: details.country } : {}),
      timestamp: now().toISOString(),
      rawEventId: rawEventIdFor(payload, body),
    };

    try {
      const redis = options.redis ?? (getRedisClient() as unknown as StreamPublisher);
      await redis.xadd(
        SHIPMENT_STATUS_STREAM,
        "MAXLEN",
        "~",
        String(STREAM_MAX_LENGTH),
        "*",
        "data",
        JSON.stringify(event),
      );
    } catch (err) {
      log.error("Failed to publish shipment status event", {
        carrier,
        rawEventId: event.rawEventId,
        error: err instanceof Error ? err.message : String(err),
      });
      fail(res, 503, "PUBLISH_FAILED", "Event could not be accepted, retry later");
      return;
    }

    json(res, 200, { data: { accepted: true, rawEventId: event.rawEventId }, error: null });
  };
}

export function registerWebhookRoutes(): Route[] {
  return [route("POST", "/api/v1/courier/webhooks/:carrier", createCourierWebhookHandler())];
}
// END routes/webhooks.ts
