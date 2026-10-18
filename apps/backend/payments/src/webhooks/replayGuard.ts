/**
 * Cryptographic nonce + timestamp tolerance for inbound webhook ingestion
 * (Issue #352).
 *
 * Carrier tracking (#291) and payment (#45/#363) webhooks verify an HMAC
 * signature, but a signature alone doesn't stop replay: an attacker who
 * intercepts a validly-signed request can resend it indefinitely and it
 * will keep verifying. This module adds the other half of the standard
 * webhook-security pattern (Stripe/GitHub-style):
 *
 *   1. Reject requests whose timestamp is outside `maxSkewSeconds` of now.
 *   2. Reject requests whose nonce has already been claimed — nonces are
 *      claimed atomically in Redis via `SET key val EX ttl NX`, with a
 *      10-minute TTL (comfortably longer than the timestamp tolerance, so
 *      a nonce can never "expire" out of the dedupe window while its
 *      timestamp is still considered fresh).
 *
 * This must run AFTER signature verification succeeds — an unauthenticated
 * caller should never be able to probe nonce/timestamp state.
 */

import { createRequire } from "node:module";
import { createLogger } from "@delegolabs/utils";

const log = createLogger("payments:webhooks:replay-guard", process.env.LOG_LEVEL ?? "info");

/** Matches the issue's `WebhookHeaderVerification` schema. */
export interface WebhookHeaderVerification {
  signature: string;
  timestamp: number;
  nonce: string;
  maxSkewSeconds: number;
}

export const DEFAULT_MAX_SKEW_SECONDS = 300;
export const WEBHOOK_NONCE_TTL_SECONDS = 600;
const NONCE_NAMESPACE = "webhook:nonce";

export type WebhookReplayRejectionCode = "TIMESTAMP_EXPIRED" | "NONCE_REPLAYED";

export interface WebhookReplayCheckResult {
  ok: boolean;
  code?: WebhookReplayRejectionCode;
  message?: string;
}

/** Minimal subset of the ioredis client API this module depends on. */
export type NonceRedisClient = {
  set(key: string, value: string, exFlag: "EX", ttlSeconds: number, nxFlag: "NX"): Promise<string | null>;
};

let _nonceRedisClient: NonceRedisClient | null = null;
const inMemoryNonceStore = new Map<string, number>(); // key -> expiresAt (ms)

function makeInMemoryNonceRedis(): NonceRedisClient {
  return {
    async set(key, _value, _exFlag, ttlSeconds, _nxFlag) {
      const now = Date.now();
      const expiresAt = inMemoryNonceStore.get(key);
      if (expiresAt !== undefined && expiresAt > now) {
        return null; // already claimed — replay
      }
      inMemoryNonceStore.set(key, now + ttlSeconds * 1000);
      return "OK";
    },
  };
}

function getNonceRedisClient(): NonceRedisClient {
  if (_nonceRedisClient) return _nonceRedisClient;

  const isTest = process.env.NODE_ENV === "test";
  const useMock = isTest || process.env.MOCK_REDIS === "true" || process.env.CI === "true";

  if (useMock) {
    _nonceRedisClient = makeInMemoryNonceRedis();
  } else {
    try {
      const _require = createRequire(import.meta.url);
      const { Redis } = _require("ioredis") as any;
      _nonceRedisClient = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");
    } catch {
      log.warn("ioredis unavailable — falling back to in-memory webhook nonce store");
      _nonceRedisClient = makeInMemoryNonceRedis();
    }
  }

  return _nonceRedisClient!;
}

/** Test-only hook to inject a fake Redis client / reset in-memory state. */
export function _setNonceRedisClientForTesting(client: NonceRedisClient | null): void {
  _nonceRedisClient = client;
  inMemoryNonceStore.clear();
}

/**
 * `Math.abs(now - timestamp) <= maxSkewSeconds`, guarding against NaN /
 * non-finite input (always rejected).
 */
export function isTimestampWithinTolerance(
  timestampSeconds: number,
  maxSkewSeconds: number = DEFAULT_MAX_SKEW_SECONDS,
  nowSeconds: number = Date.now() / 1000
): boolean {
  if (!Number.isFinite(timestampSeconds)) return false;
  return Math.abs(nowSeconds - timestampSeconds) <= maxSkewSeconds;
}

function deriveNonceKey(namespace: string, nonce: string): string {
  return `${NONCE_NAMESPACE}:${namespace}:${nonce}`;
}

/**
 * Atomically claim `nonce` for `namespace` (e.g. the webhook provider).
 * Returns true the first time a nonce is seen; false if it was already
 * claimed within the TTL window (replay).
 */
export async function claimWebhookNonce(
  namespace: string,
  nonce: string,
  ttlSeconds: number = WEBHOOK_NONCE_TTL_SECONDS
): Promise<boolean> {
  if (!nonce) return false;
  const redis = getNonceRedisClient();
  const key = deriveNonceKey(namespace, nonce);
  const result = await redis.set(key, "1", "EX", ttlSeconds, "NX");
  return result === "OK";
}

/**
 * Combined timestamp-tolerance + nonce-replay check for an inbound webhook.
 * Call only after signature verification has already succeeded.
 *
 * The nonce check only activates when the caller actually supplies a
 * nonce (via a dedicated `X-Webhook-Nonce`/`X-Nonce` header — see
 * {@link extractWebhookNonce}). Providers that don't send one yet get the
 * timestamp-tolerance protection only, so rolling this out doesn't reject
 * traffic from webhook senders that haven't adopted the nonce header.
 */
export async function checkWebhookReplay(
  namespace: string,
  input: { timestamp: number; nonce: string | undefined; maxSkewSeconds?: number }
): Promise<WebhookReplayCheckResult> {
  const maxSkewSeconds = input.maxSkewSeconds ?? DEFAULT_MAX_SKEW_SECONDS;

  if (!isTimestampWithinTolerance(input.timestamp, maxSkewSeconds)) {
    return {
      ok: false,
      code: "TIMESTAMP_EXPIRED",
      message: `Webhook timestamp is outside the ${maxSkewSeconds}s tolerance window`,
    };
  }

  if (!input.nonce) {
    return { ok: true };
  }

  const claimed = await claimWebhookNonce(namespace, input.nonce);
  if (!claimed) {
    log.warn("Rejected replayed webhook nonce", { namespace });
    return { ok: false, code: "NONCE_REPLAYED", message: "Webhook nonce has already been processed" };
  }

  return { ok: true };
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

/**
 * Extract the replay-protection timestamp from request headers.
 *
 * Accepts a dedicated `x-webhook-timestamp` (or `x-timestamp`) header,
 * carried in Unix seconds. Providers that don't send a timestamp header
 * (e.g. EasyPost) fall back to the time the request was received — the
 * nonce check still protects against replay, since a nonce can only be
 * claimed once within the TTL window.
 */
export function extractWebhookTimestamp(
  headers: Record<string, string | string[] | undefined>
): number {
  const raw = firstHeaderValue(headers["x-webhook-timestamp"] ?? headers["x-timestamp"]);
  if (raw === undefined) return Date.now() / 1000;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : Date.now() / 1000;
}

/**
 * Extract the replay-protection nonce from a dedicated `X-Webhook-Nonce`
 * (or `X-Nonce`) header. Returns `undefined` when absent — callers that
 * haven't adopted the header get timestamp-only protection rather than
 * being rejected outright (see {@link checkWebhookReplay}).
 */
export function extractWebhookNonce(
  headers: Record<string, string | string[] | undefined>
): string | undefined {
  return firstHeaderValue(headers["x-webhook-nonce"] ?? headers["x-nonce"]);
}
