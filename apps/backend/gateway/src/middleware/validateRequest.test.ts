/**
 * Unit tests for OpenAPI request validation middleware
 * 
 * Tests validation of path parameters, query parameters, and request bodies
 * against the OpenAPI specification.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { validateRequest } from "./validateRequest.js";

// ─── Test Helpers ───────────────────────────────────────────────────────────

function makeRequest(opts: {
  method: string;
  url: string;
  body?: unknown;
  headers?: Record<string, string>;
}): IncomingMessage {
  const req = new EventEmitter() as unknown as IncomingMessage;
  req.method = opts.method;
  req.url = opts.url;
  req.headers = opts.headers ?? { host: "localhost" };

  // Simulate async body stream
  queueMicrotask(() => {
    if (opts.body !== undefined) {
      const payload = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
      req.emit("data", Buffer.from(payload));
    }
    req.emit("end");
  });

  return req;
}

function makeResponse() {
  const headers: Record<string, any> = {};
  let statusCode = 200;
  let responseBody = "";

  const res = {
    setHeader: (k: string, v: any) => {
      headers[k.toLowerCase()] = v;
    },
    getHeader: (k: string) => headers[k.toLowerCase()],
    writeHead: vi.fn((status: number, hdrs?: Record<string, any>) => {
      statusCode = status;
      if (hdrs) {
        Object.assign(headers, Object.fromEntries(Object.entries(hdrs).map(([k, v]) => [k.toLowerCase(), v])));
      }
    }),
    write: vi.fn((chunk: any) => {
      responseBody += chunk;
      return true;
    }),
    end: vi.fn((chunk?: any) => {
      if (chunk) responseBody += chunk;
    }),
  } as unknown as ServerResponse & { writeHead: any; write: any; end: any };

  Object.defineProperty(res, "statusCode", {
    get: () => statusCode,
    set: (v) => {
      statusCode = v;
    },
  });

  return { res, headers, getStatus: () => statusCode, getBody: () => (responseBody ? JSON.parse(responseBody) : null) };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("validateRequest middleware", () => {
  it("should pass through excluded paths without validation", async () => {
    const middleware = validateRequest();
    const req = makeRequest({ method: "GET", url: "/health" });
    const { res } = makeResponse();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.end).not.toHaveBeenCalled();
  });

  it("should pass through unmatched paths (not in OpenAPI spec)", async () => {
    const middleware = validateRequest();
    const req = makeRequest({ method: "GET", url: "/unknown/path" });
    const { res } = makeResponse();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.end).not.toHaveBeenCalled();
  });

  it("should validate and pass through valid delegation creation request", async () => {
    const middleware = validateRequest();
    const req = makeRequest({
      method: "POST",
      url: "/api/v1/delegations",
      body: {
        agentId: "11111111-1111-1111-1111-111111111111",
        walletId: "22222222-2222-2222-2222-222222222222",
        label: "Test Delegation",
        permissionLevel: "AUTO_APPROVE",
        policy: {
          maxPerTransaction: "100000",
          maxTotal: "500000",
        },
      },
    });
    const { res } = makeResponse();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.end).not.toHaveBeenCalled();
  });

  it("should reject delegation creation with missing required fields", async () => {
    const middleware = validateRequest();
    const req = makeRequest({
      method: "POST",
      url: "/api/v1/delegations",
      body: {
        agentId: "test-agent",
        // Missing: walletId, permissionLevel, policy
      },
    });
    const { res, getStatus, getBody } = makeResponse();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(getStatus()).toBe(400);
    const body = getBody();
    expect(body.error).toBe("Validation Error");
    expect(body.details).toBeInstanceOf(Array);
    expect(body.details.length).toBeGreaterThan(0);
    expect(body.details.some((e: any) => e.field.includes("walletId"))).toBe(true);
  });

  it("should reject invalid path parameter format (non-UUID)", async () => {
    const middleware = validateRequest();
    const req = makeRequest({
      method: "GET",
      url: "/api/v1/delegations/not-a-uuid",
    });
    const { res, getStatus, getBody } = makeResponse();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(getStatus()).toBe(400);
    const body = getBody();
    expect(body.error).toBe("Validation Error");
    expect(body.details.some((e: any) => e.field.startsWith("path."))).toBe(true);
  });

  it("should reject query parameters exceeding maximum value", async () => {
    const middleware = validateRequest();
    const req = makeRequest({
      method: "GET",
      url: "/api/v1/delegations?limit=99999",
    });
    const { res, getStatus, getBody } = makeResponse();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(getStatus()).toBe(400);
    const body = getBody();
    expect(body.error).toBe("Validation Error");
    expect(body.details.some((e: any) => e.field === "query.limit")).toBe(true);
  });

  it("should reject malformed JSON in request body", async () => {
    const middleware = validateRequest();
    const req = makeRequest({
      method: "POST",
      url: "/api/v1/delegations",
      body: "{not valid json",
    });
    const { res, getStatus, getBody } = makeResponse();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(getStatus()).toBe(400);
    const body = getBody();
    expect(body.error).toBe("Validation Error");
    expect(body.details.some((e: any) => e.field === "body")).toBe(true);
  });

  it("should reject invalid email format in registration", async () => {
    const middleware = validateRequest();
    const req = makeRequest({
      method: "POST",
      url: "/api/v1/auth/register",
      body: {
        email: "not-an-email",
        password: "SecurePass123!",
      },
    });
    const { res, getStatus, getBody } = makeResponse();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(getStatus()).toBe(400);
    const body = getBody();
    expect(body.error).toBe("Validation Error");
    expect(body.details.some((e: any) => e.field === "body.email")).toBe(true);
  });

  it("should reject invalid enum value for permissionLevel", async () => {
    const middleware = validateRequest();
    const req = makeRequest({
      method: "POST",
      url: "/api/v1/delegations",
      body: {
        agentId: "11111111-1111-1111-1111-111111111111",
        walletId: "22222222-2222-2222-2222-222222222222",
        permissionLevel: "INVALID_PERMISSION",
        policy: {
          maxPerTransaction: "100000",
          maxTotal: "500000",
        },
      },
    });
    const { res, getStatus, getBody } = makeResponse();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(getStatus()).toBe(400);
    const body = getBody();
    expect(body.error).toBe("Validation Error");
    expect(body.details.some((e: any) => e.field === "body.permissionLevel")).toBe(true);
  });

  it("should provide detailed error information with field paths and expected types", async () => {
    const middleware = validateRequest();
    const req = makeRequest({
      method: "POST",
      url: "/api/v1/delegations",
      body: {
        agentId: "not-a-uuid",
        walletId: 12345, // Should be string UUID
        permissionLevel: "AUTO_APPROVE",
        policy: {
          maxPerTransaction: 100, // Should be string
          maxTotal: "500000",
        },
      },
    });
    const { res, getStatus, getBody } = makeResponse();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(getStatus()).toBe(400);
    const body = getBody();
    expect(body.error).toBe("Validation Error");
    expect(body.details).toBeInstanceOf(Array);
    
    // Check that errors include field paths and expected constraints
    body.details.forEach((detail: any) => {
      expect(detail).toHaveProperty("field");
      expect(detail).toHaveProperty("message");
      expect(typeof detail.field).toBe("string");
      expect(typeof detail.message).toBe("string");
    });
  });

  it("should handle GET requests without bodies correctly", async () => {
    const middleware = validateRequest();
    const req = makeRequest({
      method: "GET",
      url: "/api/v1/status",
    });
    const { res } = makeResponse();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.end).not.toHaveBeenCalled();
  });

  it("should validate valid query parameters correctly", async () => {
    const middleware = validateRequest();
    const req = makeRequest({
      method: "GET",
      url: "/api/v1/delegations?limit=20&sort=desc",
    });
    const { res } = makeResponse();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.end).not.toHaveBeenCalled();
  });
});
