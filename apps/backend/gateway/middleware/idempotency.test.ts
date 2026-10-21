/**
 * Unit tests for #380 — idempotency-key middleware.
 *
 * Exercises the middleware end-to-end against an in-memory Redis double:
 * first execution claims and completes the key, replays return the cached
 * response, concurrent duplicates get 409, 5xx releases the claim, and
 * Redis outages fail open.
 */

import { describe, it, expect, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  idempotencyMiddleware,
  type IdempotencyRedisClient,
} from "./idempotency.js";

type MockResponse = ServerResponse & {
  statusCode: number;
  body: string;
  headers: Record<string, string | number>;
};

function createMockReq(options: {
  url?: string;
  method?: string;
  idempotencyKey?: string;
} = {}): IncomingMessage {
  const headers: Record<string, string> = {};
  if (options.idempotencyKey) {
    headers["idempotency-key"] = options.idempotencyKey;
  }
  return {
    url: options.url ?? "/api/v1/orders",
    method: options.method ?? "POST",
    headers,
    socket: { remoteAddress: "9.9.9.9" },
  } as unknown as IncomingMessage;
}

function createMockRes(): MockResponse {
  const res = {
    statusCode: 0,
    body: "",
    headersSent: false,
    headers: {} as Record<string, string | number>,
    setHeader(name: string, value: string | number) {
      this.headers[name] = value;
    },
    writeHead(status: number, headers?: Record<string, string>) {
      this.statusCode = status;
      this.headersSent = true;
      if (headers) Object.assign(this.headers, headers);
    },
    end(body?: string) {
      if (body !== undefined) this.body = body;
    },
  };
  return res as unknown as MockResponse;
}

/** In-memory Redis double covering get/set/del with EX support. */
function buildMockRedis(): IdempotencyRedisClient & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    async get(key) {
      return store.get(key) ?? null;
    },
    async set(key, value, _mode?, _ttl?) {
      store.set(key, value);
      return "OK";
    },
    async del(key) {
      store.delete(key);
      return 1;
    },
  };
}

/** Simulates a downstream route handler writing a JSON response. */
function respondWith(
  res: MockResponse,
  status: number,
  body: unknown,
): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

describe("idempotencyMiddleware", () => {
  it("calls next() for non-mutating methods even with a key", async () => {
    const redis = buildMockRedis();
    const middleware = idempotencyMiddleware({ redisClient: redis });
    const req = createMockReq({ method: "GET", idempotencyKey: "abc" });
    const res = createMockRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(0);
    expect(redis.store.size).toBe(0);
  });

  it("calls next() when no Idempotency-Key header is present", async () => {
    const redis = buildMockRedis();
    const middleware = idempotencyMiddleware({ redisClient: redis });
    const req = createMockReq({ method: "POST" });
    const res = createMockRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(redis.store.size).toBe(0);
  });

  it("rejects keys longer than 255 characters", async () => {
    const redis = buildMockRedis();
    const middleware = idempotencyMiddleware({ redisClient: redis });
    const req = createMockReq({ method: "POST", idempotencyKey: "k".repeat(256) });
    const res = createMockRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    const parsed = JSON.parse(res.body);
    expect(parsed.error.code).toBe("INVALID_IDEMPOTENCY_KEY");
  });

  it("first execution claims the key, runs the handler, and caches the response", async () => {
    const redis = buildMockRedis();
    const middleware = idempotencyMiddleware({ redisClient: redis });
    const req = createMockReq({ method: "POST", idempotencyKey: "key-1" });
    const res = createMockRes();
    const next = vi.fn(async () => {
      respondWith(res, 201, { data: { id: "order-1" }, error: null });
    });

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(201);

    const [stored] = [...redis.store.values()];
    const record = JSON.parse(stored);
    expect(record.status).toBe("completed");
    expect(record.responseCode).toBe(201);
    expect(record.responseBody).toEqual({ data: { id: "order-1" }, error: null });
  });

  it("replays the cached response for a completed record without calling next()", async () => {
    const redis = buildMockRedis();
    const middleware = idempotencyMiddleware({ redisClient: redis });

    // First request: executes and caches.
    const req1 = createMockReq({ method: "POST", idempotencyKey: "key-replay" });
    const res1 = createMockRes();
    await middleware(req1, res1, vi.fn(async () => {
      respondWith(res1, 201, { data: { id: "order-1" }, error: null });
    }));

    // Retry of the same logical operation.
    const req2 = createMockReq({ method: "POST", idempotencyKey: "key-replay" });
    const res2 = createMockRes();
    const next2 = vi.fn();
    await middleware(req2, res2, next2);

    expect(next2).not.toHaveBeenCalled();
    expect(res2.statusCode).toBe(201);
    expect(JSON.parse(res2.body)).toEqual({ data: { id: "order-1" }, error: null });
    expect(res2.headers["Idempotency-Replayed"]).toBe("true");
  });

  it("returns 409 for a concurrent duplicate while the first is in progress", async () => {
    const redis = buildMockRedis();
    const middleware = idempotencyMiddleware({ redisClient: redis });

    // Simulate a claim written by another in-flight request.
    redis.store.set(
      "idempotency:POST:/api/v1/orders:in-flight",
      JSON.stringify({
        key: "in-flight",
        status: "in_progress",
        responseCode: 0,
        responseBody: null,
      }),
    );

    const req = createMockReq({ method: "POST", idempotencyKey: "in-flight" });
    const res = createMockRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(409);
    const parsed = JSON.parse(res.body);
    expect(parsed.error.code).toBe("IDEMPOTENCY_KEY_IN_PROGRESS");
    expect(res.headers["Retry-After"]).toBe("1");
  });

  it("releases the claim on a 5xx response so a retry can re-execute", async () => {
    const redis = buildMockRedis();
    const middleware = idempotencyMiddleware({ redisClient: redis });

    const req = createMockReq({ method: "POST", idempotencyKey: "key-5xx" });
    const res = createMockRes();
    await middleware(req, res, vi.fn(async () => {
      respondWith(res, 500, { data: null, error: { code: "INTERNAL_ERROR" } });
    }));

    expect(redis.store.size).toBe(0);

    // The retry executes for real instead of replaying the failure.
    const req2 = createMockReq({ method: "POST", idempotencyKey: "key-5xx" });
    const res2 = createMockRes();
    const next2 = vi.fn(async () => {
      respondWith(res2, 201, { data: { ok: true }, error: null });
    });
    await middleware(req2, res2, next2);

    expect(next2).toHaveBeenCalledTimes(1);
    expect(res2.statusCode).toBe(201);
  });

  it("fails open when Redis is unreachable", async () => {
    const brokenRedis: IdempotencyRedisClient = {
      get: vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
      set: vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
      del: vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    };
    const middleware = idempotencyMiddleware({ redisClient: brokenRedis });
    const req = createMockReq({ method: "POST", idempotencyKey: "key-outage" });
    const res = createMockRes();
    const next = vi.fn(async () => {
      respondWith(res, 201, { data: { ok: true }, error: null });
    });

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(201);
  });

  it("scopes keys per method and path", async () => {
    const redis = buildMockRedis();
    const middleware = idempotencyMiddleware({ redisClient: redis });

    const reqA = createMockReq({
      method: "POST",
      url: "/api/v1/orders",
      idempotencyKey: "shared",
    });
    const resA = createMockRes();
    await middleware(reqA, resA, vi.fn(async () => {
      respondWith(resA, 201, { data: { where: "orders" }, error: null });
    }));

    // Same key, different endpoint: must not replay.
    const reqB = createMockReq({
      method: "DELETE",
      url: "/api/v1/orders/42",
      idempotencyKey: "shared",
    });
    const resB = createMockRes();
    const nextB = vi.fn(async () => {
      respondWith(resB, 200, { data: { where: "delete" }, error: null });
    });
    await middleware(reqB, resB, nextB);

    expect(nextB).toHaveBeenCalledTimes(1);
    expect(resB.statusCode).toBe(200);
  });

  it("caches 4xx responses but not 5xx", async () => {
    const redis = buildMockRedis();
    const middleware = idempotencyMiddleware({ redisClient: redis });

    const req = createMockReq({ method: "POST", idempotencyKey: "key-4xx" });
    const res = createMockRes();
    await middleware(req, res, vi.fn(async () => {
      respondWith(res, 422, { data: null, error: { code: "VALIDATION_FAILED" } });
    }));

    expect(redis.store.size).toBe(1);
    const record = JSON.parse([...redis.store.values()][0]);
    expect(record.responseCode).toBe(422);
  });

  it("handles whitespace-only keys as absent", async () => {
    const redis = buildMockRedis();
    const middleware = idempotencyMiddleware({ redisClient: redis });
    const req = createMockReq({ method: "POST", idempotencyKey: "   " });
    const res = createMockRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(redis.store.size).toBe(0);
  });
});
