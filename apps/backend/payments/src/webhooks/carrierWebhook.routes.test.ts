import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerRoutes } from "../routes.js";
import type { Route } from "@delegolabs/utils";
import {
  drainPendingCarrierEvents,
  pendingCarrierEventCount,
  resetCarrierQueue,
} from "./carrierQueue.js";

// Issue #291 — POST /api/v1/webhooks/carriers/easypost must verify HMAC,
// respond 200 immediately, and enqueue for async BullMQ processing.

const SECRET = "test-easypost-secret";

type MockResponse = ServerResponse & { statusCode: number; body: string };

function createMockReq(body: string, headers: Record<string, string> = {}): IncomingMessage {
  const req = new EventEmitter() as unknown as IncomingMessage;
  req.headers = { "content-type": "application/json", ...headers };
  process.nextTick(() => {
    req.emit("data", Buffer.from(body));
    req.emit("end");
  });
  return req;
}

function createMockRes(): MockResponse {
  const res = {
    statusCode: 0,
    body: "",
    writeHead(status: number) {
      this.statusCode = status;
    },
    end(body?: string) {
      if (body !== undefined) this.body = body;
    },
  };
  return res as MockResponse;
}

function sign(body: string, secret = SECRET): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

function findRoute(): Route {
  const route = registerRoutes().find(
    (r) => r.method === "POST" && r.pattern.test("/api/v1/webhooks/carriers/easypost")
  );
  if (!route) throw new Error("/api/v1/webhooks/carriers/easypost route not registered");
  return route;
}

function payload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: "evt_123",
    description: "tracker.updated",
    result: {
      tracking_code: "EZ100000000US",
      status: "in_transit",
      status_detail: "Departed facility",
      carrier: "USPS",
      est_delivery_date: "2026-10-05",
      tracking_details: [
        {
          status: "in_transit",
          message: "Departed facility",
          datetime: "2026-09-28T10:00:00Z",
          source: "USPS",
        },
      ],
    },
    ...overrides,
  });
}

describe("POST /api/v1/webhooks/carriers/easypost", () => {
  beforeEach(() => {
    process.env.NODE_ENV = "test";
    process.env.EASYPOST_WEBHOOK_SECRET = SECRET;
    delete process.env.CARRIER_WEBHOOK_SECRET;
    resetCarrierQueue();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.EASYPOST_WEBHOOK_SECRET;
    resetCarrierQueue();
  });

  it("returns 401 without enqueueing when the signature is missing", async () => {
    const route = findRoute();
    const req = createMockReq(payload());
    const res = createMockRes();

    await route.handler(req, res, {});

    expect(res.statusCode).toBe(401);
    expect(pendingCarrierEventCount()).toBe(0);
  });

  it("returns 401 without enqueueing when the signature is invalid", async () => {
    const route = findRoute();
    const req = createMockReq(payload(), { "x-signature": "0".repeat(64) });
    const res = createMockRes();

    await route.handler(req, res, {});

    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error.code).toBe("UNAUTHORIZED");
    expect(pendingCarrierEventCount()).toBe(0);
  });

  it("returns 401 when the payload was tampered after signing", async () => {
    const route = findRoute();
    const original = payload();
    const tampered = payload({
      result: {
        tracking_code: "EZ999999999US",
        status: "delivered",
        status_detail: "Delivered",
        carrier: "USPS",
        est_delivery_date: "2026-09-28",
        tracking_details: [],
      },
    });
    const req = createMockReq(tampered, { "x-hmac-signature": sign(original) });
    const res = createMockRes();

    await route.handler(req, res, {});

    expect(res.statusCode).toBe(401);
    expect(pendingCarrierEventCount()).toBe(0);
  });

  it("returns 503 when no webhook secret is configured", async () => {
    delete process.env.EASYPOST_WEBHOOK_SECRET;
    const route = findRoute();
    const body = payload();
    const req = createMockReq(body, { "x-signature": sign(body) });
    const res = createMockRes();

    await route.handler(req, res, {});

    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).error.code).toBe("CONFIG_ERROR");
  });

  it("accepts the EasyPost HMAC header and enqueues asynchronously with 200", async () => {
    const route = findRoute();
    const body = payload();
    const req = createMockReq(body, { "x-easypost-hmac-sha256": sign(body) });
    const res = createMockRes();

    const startedAt = Date.now();
    await route.handler(req, res, {});
    const elapsedMs = Date.now() - startedAt;

    expect(res.statusCode).toBe(200);
    expect(elapsedMs).toBeLessThan(500);
    const parsed = JSON.parse(res.body);
    expect(parsed.data.received).toBe(true);
    expect(parsed.data.trackingCode).toBe("EZ100000000US");
    expect(pendingCarrierEventCount()).toBe(1);
    const [event] = drainPendingCarrierEvents();
    expect(event.trackingCode).toBe("EZ100000000US");
    expect(event.status).toBe("in_transit");
    expect(event.provider).toBe("easypost");
  });

  it("accepts sha256=<hex> prefixed signatures", async () => {
    const route = findRoute();
    const body = payload();
    const req = createMockReq(body, { "x-hub-signature-256": `sha256=${sign(body)}` });
    const res = createMockRes();

    await route.handler(req, res, {});

    expect(res.statusCode).toBe(200);
    expect(pendingCarrierEventCount()).toBe(1);
  });

  it("dedupes redelivered webhooks with the same event id", async () => {
    const route = findRoute();
    const body = payload();
    for (let i = 0; i < 2; i++) {
      const req = createMockReq(body, { "x-signature": sign(body) });
      const res = createMockRes();
      await route.handler(req, res, {});
      expect(res.statusCode).toBe(200);
    }
    expect(pendingCarrierEventCount()).toBe(1);
  });

  it("returns 400 for invalid JSON after a valid signature over raw bytes", async () => {
    const route = findRoute();
    const body = "{not valid json";
    const req = createMockReq(body, { "x-signature": sign(body) });
    const res = createMockRes();

    await route.handler(req, res, {});

    expect(res.statusCode).toBe(400);
    expect(pendingCarrierEventCount()).toBe(0);
  });

  it("returns 400 when required tracking fields are missing", async () => {
    const route = findRoute();
    const body = JSON.stringify({ id: "evt_123", description: "tracker.updated", result: {} });
    const req = createMockReq(body, { "x-signature": sign(body) });
    const res = createMockRes();

    await route.handler(req, res, {});

    expect(res.statusCode).toBe(400);
    expect(pendingCarrierEventCount()).toBe(0);
  });
});
