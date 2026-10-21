import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    timingSafeEqual: vi.fn(actual.timingSafeEqual),
  };
});

import { timingSafeEqual } from "node:crypto";
import { requireServiceAuth, SERVICE_AUTH_HEADER } from "./serviceAuth.js";

function makeReq(token?: string): IncomingMessage & EventEmitter {
  const req = new EventEmitter() as IncomingMessage & EventEmitter;
  req.headers = token === undefined ? {} : { [SERVICE_AUTH_HEADER]: token };
  return req;
}

function makeRes(): ServerResponse & { statusCode: number; headers: Record<string, string>; body: string } {
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: "",
    writeHead(status: number, headers?: Record<string, string>) {
      this.statusCode = status;
      if (headers) Object.assign(this.headers, headers);
    },
    setHeader(name: string, value: string) {
      this.headers[name] = value;
    },
    end(chunk?: string | Buffer) {
      this.body = chunk?.toString() ?? "";
    },
  } as unknown as ServerResponse & { statusCode: number; headers: Record<string, string>; body: string };
  return res;
}

describe("requireServiceAuth", () => {
  const environmentBeforeTests = new Map<string, string | undefined>();
  const testEnvironmentKeys = [
    "ORCHESTRATOR_PAYMENTS_SERVICE_TOKEN",
    "MISSING_SERVICE_AUTH_TEST_TOKEN",
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of testEnvironmentKeys) {
      if (!environmentBeforeTests.has(key)) {
        environmentBeforeTests.set(key, process.env[key]);
      }
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const [key, value] of environmentBeforeTests) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("accepts a valid service token", () => {
    const req = makeReq("payments-wallet-secret");
    const res = makeRes();
    const next = vi.fn();

    requireServiceAuth({ expectedToken: "payments-wallet-secret" })(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(0);
  });

  it("rejects a missing request token with 401", () => {
    const req = makeReq();
    const res = makeRes();
    const next = vi.fn();

    requireServiceAuth({ expectedToken: "payments-wallet-secret" })(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects an invalid request token with 401", () => {
    const req = makeReq("wrong-token");
    const res = makeRes();
    const next = vi.fn();

    requireServiceAuth({ expectedToken: "payments-wallet-secret" })(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("safely rejects a request token with a different length", () => {
    const req = makeReq("short");
    const res = makeRes();
    const next = vi.fn();

    requireServiceAuth({ expectedToken: "payments-wallet-secret" })(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
    expect(timingSafeEqual).toHaveBeenCalledOnce();
  });

  it("fails closed with 503 when expected-token configuration is missing", () => {
    const req = makeReq("");
    const res = makeRes();
    const next = vi.fn();

    requireServiceAuth({ envVar: "MISSING_SERVICE_AUTH_TEST_TOKEN" })(req, res, next);

    expect(res.statusCode).toBe(503);
    expect(next).not.toHaveBeenCalled();
  });

  it("fails closed with 503 when the configured environment value is empty", () => {
    process.env.MISSING_SERVICE_AUTH_TEST_TOKEN = "";
    const req = makeReq(" ");
    const res = makeRes();
    const next = vi.fn();

    requireServiceAuth({ envVar: "MISSING_SERVICE_AUTH_TEST_TOKEN" })(req, res, next);

    expect(res.statusCode).toBe(503);
    expect(next).not.toHaveBeenCalled();
  });

  it("fails closed with 503 when the expected token is whitespace-only", () => {
    const req = makeReq("   ");
    const res = makeRes();
    const next = vi.fn();

    requireServiceAuth({ expectedToken: "   " })(req, res, next);

    expect(res.statusCode).toBe(503);
    expect(next).not.toHaveBeenCalled();
  });

  it("uses timingSafeEqual to compare token digests", () => {
    const req = makeReq("payments-wallet-secret");
    const res = makeRes();
    const next = vi.fn();

    requireServiceAuth({ expectedToken: "payments-wallet-secret" })(req, res, next);

    expect(timingSafeEqual).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledOnce();
  });

  it("loads the expected token from the explicitly configured environment variable", () => {
    process.env.ORCHESTRATOR_PAYMENTS_SERVICE_TOKEN = "orch-payments-secret";
    const req = makeReq("orch-payments-secret");
    const res = makeRes();
    const next = vi.fn();

    requireServiceAuth({ envVar: "ORCHESTRATOR_PAYMENTS_SERVICE_TOKEN" })(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    delete process.env.ORCHESTRATOR_PAYMENTS_SERVICE_TOKEN;
  });
});
