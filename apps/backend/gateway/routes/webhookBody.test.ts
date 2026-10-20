/**
 * Unit tests for the courier webhook raw body capture middleware (Issue #577).
 */
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { courierWebhookBodyCapture, getCapturedBody } from "./webhookBody.js";

function makeReq(url: string): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage;
  req.method = "POST";
  req.url = url;
  req.headers = {};
  return req;
}

type MockRes = ServerResponse & { statusCode: number; body: string };

function makeRes(): MockRes {
  const res = {
    statusCode: 0,
    body: "",
    headersSent: false,
    once: vi.fn(),
    writeHead(status: number) {
      this.statusCode = status;
      this.headersSent = true;
      return this;
    },
    end(chunk?: string) {
      if (chunk !== undefined) this.body = chunk;
    },
  };
  return res as unknown as MockRes;
}

describe("courierWebhookBodyCapture", () => {
  it("control: captures the exact bytes for a carrier path and calls next once", () => {
    const req = makeReq("/api/v1/courier/webhooks/fedex");
    const next = vi.fn();
    courierWebhookBodyCapture()(req, makeRes(), next);
    req.emit("data", Buffer.from('{"a":'));
    req.emit("data", Buffer.from("1}"));
    req.emit("end");
    expect(next).toHaveBeenCalledTimes(1);
    expect(getCapturedBody(req)?.toString("utf8")).toBe('{"a":1}');
  });

  it("responds 400 and does not advance when the request errors before end", () => {
    const req = makeReq("/api/v1/courier/webhooks/fedex");
    const res = makeRes();
    const next = vi.fn();
    courierWebhookBodyCapture()(req, res, next);
    req.emit("data", Buffer.from("{"));
    req.emit("error", new Error("aborted"));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe("INVALID_PAYLOAD");
    expect(next).not.toHaveBeenCalled();
  });

  it("does not buffer paths with extra segments after the carrier", () => {
    const req = makeReq("/api/v1/courier/webhooks/fedex/extra");
    const next = vi.fn();
    courierWebhookBodyCapture()(req, makeRes(), next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.listenerCount("data")).toBe(0);
  });
});
// END-OF-FILE-MARKER
