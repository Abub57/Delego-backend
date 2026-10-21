import { EventEmitter, once } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { correlationMiddleware, fetchWithCorrelation } from "./correlation.js";
import { json, route, startHttpServer } from "./http.js";
import { getLogContext, runWithLogContext } from "./logger.js";

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

describe("shared correlation context", () => {
  it("uses the incoming ID in the response and logger context", () => {
    const res = makeResponse();
    let contextId: string | undefined;

    correlationMiddleware(makeRequest("trace-123"), res, () => {
      contextId = getLogContext().correlationId;
    });

    expect(res.headers["x-correlation-id"]).toBe("trace-123");
    expect(contextId).toBe("trace-123");
  });

  it("generates a UUID when the incoming ID is missing", () => {
    const res = makeResponse();
    correlationMiddleware(makeRequest(), res, () => {});

    expect(res.headers["x-correlation-id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("installs correlation context for every shared HTTP server", async () => {
    const server = startHttpServer({
      port: 0,
      host: "127.0.0.1",
      serviceName: "correlation-test",
      routes: [route("GET", "/trace", (_req, res) => json(res, 200, getLogContext()))],
    });

    try {
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Test server did not bind a TCP port");

      const response = await fetch(`http://127.0.0.1:${address.port}/trace`);
      const responseId = response.headers.get("X-Correlation-ID");
      expect(responseId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
      expect(await response.json()).toEqual({ correlationId: responseId });
    } finally {
      const closed = once(server, "close");
      server.close();
      await closed;
    }
  });

  it("propagates the active ID to downstream requests while preserving other headers", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("ok"));

    await runWithLogContext({ correlationId: "trace-456" }, () =>
      fetchWithCorrelation("http://downstream.test", {
        headers: { "X-Existing": "preserved", "X-Correlation-ID": "caller-value" },
      }, fetchImpl),
    );

    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get("X-Correlation-ID")).toBe("trace-456");
    expect(headers.get("X-Existing")).toBe("preserved");
  });
});