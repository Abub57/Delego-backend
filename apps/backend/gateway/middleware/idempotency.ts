/**
 * Idempotency-Key middleware for mutating REST endpoints (Issue #380).
 *
 * Clients retrying after a network timeout cannot know whether the original
 * request reached the server. For mutating endpoints (POST/PUT/PATCH/DELETE)
 * a blind retry risks duplicate side effects (double payouts, double orders).
 *
 * Contract:
 *  - Requests carrying an `Idempotency-Key` header are recorded in Redis.
 *  - The first execution claims the key (`in_progress`), runs the handler,
 *    and upgrades the record to `completed` once the response is written.
 *  - Retries of a `completed` record receive the stored response verbatim
 *    (same status code and body) with an `Idempotency-Replayed: true` header.
 *  - A concurrent duplicate while the first execution is still running gets
 *    `409 IDEMPOTENCY_KEY_IN_PROGRESS` so the client can retry with backoff.
 *  - `5xx` responses are NOT cached: the claim is released so the retry can
 *    actually re-execute the failed operation.
 *  - Redis failures fail open (request proceeds uncached) — availability
 *    takes precedence over deduplication.
 *
 * Keys are scoped per `method + path + key`, so the same client-generated
 * key used against two different endpoints never collides.
 *
 * Issue #380
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { json } from "@delegolabs/utils";
import { getRedisClient } from "../src/rateLimit/redisClient.js";

/** Responses are replayed from cache for 24 hours (issue #380 requirement). */
const DEFAULT_TTL_SECONDS = 24 * 60 * 60;

/**
 * In-flight claims expire quickly so a crashed handler cannot block retries
 * of the same operation for the full 24-hour window.
 */
const DEFAULT_CLAIM_TTL_SECONDS = 300;

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const MAX_KEY_LENGTH = 255;

export interface IdempotencyRecord {
  key: string;
  status: "in_progress" | "completed";
  responseCode: number;
  responseBody: unknown;
}

/** Minimal Redis surface used by the middleware (subset of ioredis). */
export interface IdempotencyRedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode?: string, ttl?: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

export interface IdempotencyOptions {
  /** Overrides the shared gateway Redis client (used by tests). */
  redisClient?: IdempotencyRedisClient;
  /** How long completed responses are replayable. Default: 24 hours. */
  ttlSeconds?: number;
  /** How long an in-progress claim lives if a handler crashes. Default: 5 minutes. */
  claimTtlSeconds?: number;
}

function getHeader(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function getScopedKey(req: IncomingMessage, key: string): string {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const method = (req.method ?? "GET").toUpperCase();
  return `idempotency:${method}:${url.pathname}:${key}`;
}

function safeParseBody(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

export function idempotencyMiddleware(options: IdempotencyOptions = {}) {
  return async (
    req: IncomingMessage,
    res: ServerResponse,
    next: (err?: any) => void,
  ): Promise<void> => {
    const method = (req.method ?? "GET").toUpperCase();

    // Only mutating endpoints can produce duplicate side effects on retry.
    if (!MUTATING_METHODS.has(method)) {
      next();
      return;
    }

    const headerKey = getHeader(req, "idempotency-key");
    if (!headerKey || headerKey.trim() === "") {
      // No idempotency contract with this client — behave transparently.
      next();
      return;
    }

    const key = headerKey.trim();
    if (key.length > MAX_KEY_LENGTH) {
      json(res, 400, {
        data: null,
        error: {
          code: "INVALID_IDEMPOTENCY_KEY",
          message: `Idempotency-Key header must be at most ${MAX_KEY_LENGTH} characters.`,
        },
      });
      return;
    }

    const redis =
      options.redisClient ?? (getRedisClient() as unknown as IdempotencyRedisClient);
    const ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    const claimTtlSeconds = options.claimTtlSeconds ?? DEFAULT_CLAIM_TTL_SECONDS;
    const storageKey = getScopedKey(req, key);

    // ------------------------------------------------------------------
    // 1. Replay / conflict check
    // ------------------------------------------------------------------
    let existing: IdempotencyRecord | null = null;
    try {
      const raw = await redis.get(storageKey);
      existing = raw ? (JSON.parse(raw) as IdempotencyRecord) : null;
    } catch {
      // Redis unavailable → fail open rather than block all writes.
      next();
      return;
    }

    if (existing) {
      if (existing.status === "completed") {
        res.setHeader("Idempotency-Replayed", "true");
        json(res, existing.responseCode, existing.responseBody);
        return;
      }

      res.setHeader("Retry-After", "1");
      json(res, 409, {
        data: null,
        error: {
          code: "IDEMPOTENCY_KEY_IN_PROGRESS",
          message:
            "A request with this Idempotency-Key is still in progress. Retry with backoff.",
        },
      });
      return;
    }

    // ------------------------------------------------------------------
    // 2. Claim the key as in_progress
    // ------------------------------------------------------------------
    const claim: IdempotencyRecord = {
      key,
      status: "in_progress",
      responseCode: 0,
      responseBody: null,
    };

    try {
      await redis.set(storageKey, JSON.stringify(claim), "EX", claimTtlSeconds);
    } catch {
      next();
      return;
    }

    // ------------------------------------------------------------------
    // 3. Capture the response the route handler will write, then upgrade
    //    the record to `completed` so future retries replay it.
    // ------------------------------------------------------------------
    const originalWriteHead = res.writeHead.bind(res);
    const originalEnd = res.end.bind(res);
    let capturedStatus = 0;
    let capturedBody: string | undefined;
    let settled = false;

    (res as unknown as { writeHead: (...args: unknown[]) => ServerResponse }).writeHead = (
      ...args: unknown[]
    ) => {
      const status = args[0];
      if (typeof status === "number") {
        capturedStatus = status;
      }
      return originalWriteHead(...(args as Parameters<ServerResponse["writeHead"]>));
    };

    (res as unknown as { end: (...args: unknown[]) => ServerResponse }).end = (
      ...args: unknown[]
    ) => {
      const [body] = args;
      if (capturedStatus === 0) {
        capturedStatus = res.statusCode;
      }
      if (typeof body === "string") {
        capturedBody = body;
      } else if (body !== undefined && body !== null) {
        capturedBody = String(body);
      }

      const result = originalEnd(...(args as Parameters<ServerResponse["end"]>));

      if (!settled) {
        settled = true;
        const status = capturedStatus || 0;
        const record: IdempotencyRecord = {
          key,
          status: "completed",
          responseCode: status,
          responseBody:
            capturedBody !== undefined ? safeParseBody(capturedBody) : null,
        };

        if (status >= 500) {
          // Server-side failure: release the claim so a retry re-executes.
          void Promise.resolve(redis.del(storageKey)).catch(() => undefined);
        } else {
          void Promise.resolve(
            redis.set(storageKey, JSON.stringify(record), "EX", ttlSeconds),
          ).catch(() => undefined);
        }
      }

      return result;
    };

    next();
  };
}
