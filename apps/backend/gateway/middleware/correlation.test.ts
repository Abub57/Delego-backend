import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "@delegolabs/utils";
import { callDownstreamService } from "../src/serviceClient.js";
import { resetAllCircuitBreakers } from "../src/circuitBreaker.js";
import { correlationMiddleware } from "./correlation.js";

function makeRequest(correlationId?: string): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage;
  req.headers = correlationId ? { "x-correlation-id": correlationId } : {};
  return req;
}

function makeResponse(): ServerResponse & { headers: Record<string, string> } {
  const headers: Record<string, string> = {};
  return {
    headers,
    setHeader(name: string, value: string | number | readonly string[]) {
      headers[name.toLowerCase()] = String(value);
      return this;
    },
  } as unknown as ServerResponse & { headers: Record<string, string> };
}

describe("correlationMiddleware", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetAllCircuitBreakers();
  });

  it("reuses the incoming ID for response headers, outbound requests, and structured logs", async () => {
    const correlationId = "trace-123";
    const req = makeRequest(correlationId);
    const res = makeResponse();
    const logger = createLogger("gateway:test");
    const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
    const mockFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: "ok" })));
    vi.stubGlobal("fetch", mockFetch);

    await new Promise<void>((resolve, reject) => {
      correlationMiddleware(req, res, () => {
        void (async () => {
          try {
            logger.info("request handled");
            await callDownstreamService("orchestrator", {
              path: "/resource",
              headers: { "X-Correlation-ID": "caller-value", "X-Existing": "preserved" },
            });
            resolve();
          } catch (error) {
            reject(error);
          }
        })();
      });
    });

    expect(res.headers["x-correlation-id"]).toBe(correlationId);
    const requestInit = mockFetch.mock.calls[0][1] as RequestInit;
    expect(new Headers(requestInit.headers).get("X-Correlation-ID")).toBe(correlationId);
    expect(new Headers(requestInit.headers).get("X-Existing")).toBe("preserved");
    expect(JSON.parse(stdout.mock.calls[0][0] as string)).toMatchObject({ correlationId });

  });

  it("generates a UUID when no incoming correlation ID is supplied", () => {
    const res = makeResponse();
    correlationMiddleware(makeRequest(), res, () => {});

    expect(res.headers["x-correlation-id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });
});