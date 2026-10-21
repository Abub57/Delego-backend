/**
 * Checkout idempotency pre-handler.
 *
 * Network retries and double-clicked "Place order" buttons submit the same
 * checkout more than once. This guard runs before the checkout handler and
 * either lets exactly one execution proceed or answers the duplicate itself:
 *
 *  - Fingerprint = `Idempotency-Key` header (scoped to the user) when sent,
 *    otherwise SHA-256(wallet + items + nonce) derived from the body.
 *  - The first request takes a Redis `SET NX EX 60` lease (distributed mutex),
 *    marks the record `in_progress`, and runs the handler. The response it
 *    writes is persisted as `completed` *before* the bytes reach the client,
 *    so any retry the client sends after seeing it is guaranteed a replay.
 *  - Duplicates arriving while the first is in flight wait (bounded) for it to
 *    finish and then receive the identical status + body, flagged with
 *    `Idempotency-Replayed: true`. If it doesn't finish in time: 409 + Retry-After.
 *  - 5xx outcomes are discarded so a retry genuinely re-executes.
 *  - Redis outages fail open; the (merchant_id, order_id, product_id) unique
 *    reservation constraint (migration 045) remains the database backstop.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { createLogger } from "@delegolabs/utils";
import {
  computeCheckoutFingerprint,
  computeHeaderKeyFingerprint,
  type CheckoutFingerprintInput,
} from "./fingerprint.js";
import type { IdempotencyStore } from "./store.js";
import type { IdempotencyRecord } from "./types.js";

const log = createLogger("orchestrator:idempotency", process.env.LOG_LEVEL ?? "info");

const MAX_KEY_LENGTH = 255;
const DEFAULT_WAIT_FOR_COMPLETION_MS = 5_000;
const DEFAULT_POLL_INTERVAL_MS = 50;

export interface CheckoutIdempotencyContext extends CheckoutFingerprintInput {
  /** Authenticated user; every fingerprint is namespaced by it. */
  userId: string;
}

/** `proceed`: run the handler. `replied`: the pre-handler already answered. */
export type PreHandlerResult = "proceed" | "replied";

export type CheckoutIdempotencyPreHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  context: CheckoutIdempotencyContext,
) => Promise<PreHandlerResult>;

export interface CheckoutIdempotencyOptions {
  store: IdempotencyStore;
  /** How long a duplicate waits for the in-flight original before 409. */
  waitForCompletionMs?: number;
  pollIntervalMs?: number;
}

interface Lease {
  id: string;
  fingerprint: string;
  requestHash: string;
  token: string;
}

function readHeader(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function reply(
  res: ServerResponse,
  statusCode: number,
  body: string,
  headers: Record<string, string> = {},
): PreHandlerResult {
  res.writeHead(statusCode, { "Content-Type": "application/json", ...headers });
  res.end(body);
  return "replied";
}

function replyError(
  res: ServerResponse,
  statusCode: number,
  code: string,
  message: string,
  headers: Record<string, string> = {},
): PreHandlerResult {
  return reply(res, statusCode, JSON.stringify({ data: null, error: { code, message } }), headers);
}

function replayOrReject(
  res: ServerResponse,
  record: IdempotencyRecord,
  requestHash: string,
): PreHandlerResult {
  // Only reachable with an explicit header key: a derived fingerprint *is* the request hash.
  if (record.requestHash && record.requestHash !== requestHash) {
    return replyError(
      res,
      422,
      "IDEMPOTENCY_KEY_REUSED",
      "This Idempotency-Key was already used for a different checkout request.",
    );
  }
  return reply(res, record.statusCode ?? 200, record.responseBody ?? "", {
    "Idempotency-Replayed": "true",
  });
}

function chunkToString(chunk: unknown): string {
  if (typeof chunk === "string") return chunk;
  if (Buffer.isBuffer(chunk)) return chunk.toString("utf8");
  if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString("utf8");
  return "";
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Intercept the handler's response: persist it as the replayable record, then
 * flush it to the client, then release the lease.
 */
function captureResponse(res: ServerResponse, store: IdempotencyStore, lease: Lease): void {
  const originalWrite = res.write.bind(res) as (...args: unknown[]) => boolean;
  const originalEnd = res.end.bind(res) as (...args: unknown[]) => ServerResponse;
  const written: string[] = [];
  let settled = false;

  (res as unknown as { write: (...args: unknown[]) => boolean }).write = (...args) => {
    written.push(chunkToString(args[0]));
    return originalWrite(...args);
  };

  (res as unknown as { end: (...args: unknown[]) => ServerResponse }).end = (...args) => {
    if (settled) return originalEnd(...args);
    settled = true;

    const finalChunk = typeof args[0] === "function" ? "" : chunkToString(args[0]);
    const body = written.join("") + finalChunk;
    const statusCode = res.statusCode;

    const persist =
      statusCode >= 500
        ? store.discard(lease.id)
        : store.complete(lease.id, lease.fingerprint, lease.requestHash, statusCode, body);

    void persist
      .catch((err: unknown) => {
        log.warn("Failed to persist idempotency record", {
          fingerprint: lease.fingerprint,
          error: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        originalEnd(...args);
        void store.releaseLease(lease.id, lease.token).catch(() => undefined);
      });

    return res;
  };
}

export function createCheckoutIdempotencyPreHandler(
  options: CheckoutIdempotencyOptions,
): CheckoutIdempotencyPreHandler {
  const { store } = options;
  const waitForCompletionMs = options.waitForCompletionMs ?? DEFAULT_WAIT_FOR_COMPLETION_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  return async function checkoutIdempotencyPreHandler(req, res, context) {
    const headerKey = readHeader(req, "idempotency-key")?.trim();
    if (headerKey && headerKey.length > MAX_KEY_LENGTH) {
      return replyError(
        res,
        400,
        "INVALID_IDEMPOTENCY_KEY",
        `Idempotency-Key header must be at most ${MAX_KEY_LENGTH} characters.`,
      );
    }

    const requestHash = computeCheckoutFingerprint(context);
    const fingerprint = headerKey
      ? computeHeaderKeyFingerprint(context.userId, headerKey)
      : requestHash;
    const id = `${context.userId}:${fingerprint}`;
    const deadline = Date.now() + waitForCompletionMs;

    try {
      for (;;) {
        const existing = await store.getRecord(id);
        if (existing?.status === "completed") {
          return replayOrReject(res, existing, requestHash);
        }

        const token = await store.acquireLease(id);
        if (token) {
          // The previous holder may have completed between our read and our lock.
          const raced = await store.getRecord(id);
          if (raced?.status === "completed") {
            await store.releaseLease(id, token).catch(() => undefined);
            return replayOrReject(res, raced, requestHash);
          }

          await store.markInProgress(id, fingerprint, requestHash);
          captureResponse(res, store, { id, fingerprint, requestHash, token });
          return "proceed";
        }

        if (Date.now() >= deadline) {
          return replyError(
            res,
            409,
            "IDEMPOTENCY_REQUEST_IN_PROGRESS",
            "An identical checkout is still being processed. Retry shortly.",
            { "Retry-After": "1" },
          );
        }
        await sleep(pollIntervalMs);
      }
    } catch (err) {
      if (res.headersSent) return "replied";
      log.warn("Idempotency store unavailable; processing checkout without deduplication", {
        fingerprint,
        error: err instanceof Error ? err.message : String(err),
      });
      return "proceed";
    }
  };
}
