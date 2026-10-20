/**
 * Tests for POST /api/v1/courier/webhooks/:carrier (Issue #577).
 */
import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  SHIPMENT_STATUS_STREAM,
  createCourierWebhookHandler,
  registerWebhookRoutes,
} from "./webhooks.js";

const SECRETS = { fedex: "fedex-secret", ups: "ups-secret", dhl: "dhl-secret" };
const HEADERS = {
  fedex: "x-fedex-signature",
  ups: "x-ups-signature",
  dhl: "x-dhl-signature",
} as const;
type Carrier = keyof typeof SECRETS;
const NOW = new Date("2026-10-20T10:00:00.000Z");

type MockRes = ServerResponse & { statusCode: number; body: string };

const sign = (body: string, secret: string) =>
  createHmac("sha256", secret).update(body, "utf8").digest("hex");

const signed = (carrier: Carrier, body: string) => ({
  [HEADERS[carrier]]: sign(body, SECRETS[carrier]),
});

function makeReq(body: string, headers: Record<string, string>): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage;
  req.method = "POST";
  req.headers = { "content-type": "application/json", ...headers };
  process.nextTick(() => {
    req.emit("data", Buffer.from(body));
    req.emit("end");
  });
  return req;
}

function makeRes(): MockRes {
  const res = {
    statusCode: 0,
    body: "",
    writeHead(status: number) {
      this.statusCode = status;
      return this;
    },
    end(chunk?: string) {
      if (chunk !== undefined) this.body = chunk;
    },
  };
  return res as unknown as MockRes;
}

const xadd = vi.fn();
let secrets: Partial<Record<Carrier, string>>;

async function send(
  carrier: string,
  body: string,
  headers: Record<string, string>,
): Promise<MockRes> {
  const res = makeRes();
  const handler = createCourierWebhookHandler({ redis: { xadd }, secrets, now: () => NOW });
  await handler(makeReq(body, headers), res, { carrier });
  return res;
}

function publishedEvent(): Record<string, unknown> {
  expect(xadd).toHaveBeenCalledTimes(1);
  return JSON.parse(xadd.mock.calls[0][6] as string);
}

beforeEach(() => {
  xadd.mockReset();
  xadd.mockResolvedValue("1-0");
  secrets = { ...SECRETS };
});

describe("signature verification", () => {
  const body = JSON.stringify({ trackingNumber: "794600000001", statusCode: "DL" });

  it("returns 401 and does not publish when the signature header is missing", async () => {
    const res = await send("fedex", body, {});
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error.code).toBe("INVALID_SIGNATURE");
    expect(xadd).not.toHaveBeenCalled();
  });

  it("returns 401 for a signature made with the wrong secret", async () => {
    const res = await send("fedex", body, { [HEADERS.fedex]: sign(body, "wrong") });
    expect(res.statusCode).toBe(401);
    expect(xadd).not.toHaveBeenCalled();
  });

  it("returns 401 when the body was changed after signing", async () => {
    const res = await send("fedex", body.replace("DL", "OD"), signed("fedex", body));
    expect(res.statusCode).toBe(401);
    expect(xadd).not.toHaveBeenCalled();
  });

  it("returns 401 when another carrier's signature header is used", async () => {
    const res = await send("fedex", body, signed("ups", body));
    expect(res.statusCode).toBe(401);
    expect(xadd).not.toHaveBeenCalled();
  });

  it("fails closed with 401 when no secret is configured", async () => {
    secrets = {};
    const res = await send("fedex", body, signed("fedex", body));
    expect(res.statusCode).toBe(401);
    expect(xadd).not.toHaveBeenCalled();
  });

  it("accepts a sha256= prefixed signature", async () => {
    const res = await send("fedex", body, {
      [HEADERS.fedex]: `sha256=${sign(body, SECRETS.fedex)}`,
    });
    expect(res.statusCode).toBe(200);
  });

  it("verifies the raw bytes, not re-serialised JSON", async () => {
    const spaced = '{ "trackingNumber" :  "794600000001",\n "statusCode": "DL" }';
    const res = await send("fedex", spaced, signed("fedex", spaced));
    expect(res.statusCode).toBe(200);
  });
});

describe("routing", () => {
  it("returns 404 for an unsupported carrier", async () => {
    const res = await send("tnt", "{}", {});
    expect(res.statusCode).toBe(404);
    expect(xadd).not.toHaveBeenCalled();
  });

  it("registers only POST /api/v1/courier/webhooks/:carrier", () => {
    const [route, ...rest] = registerWebhookRoutes();
    expect(rest).toHaveLength(0);
    expect(route.method).toBe("POST");
    expect(route.pattern.test("/api/v1/courier/webhooks/fedex")).toBe(true);
    expect(route.pattern.test("/api/v1/courier/webhooks/")).toBe(false);
  });
});

const CASES: Array<[Carrier, Record<string, unknown>, string]> = [
  ["fedex", { trackingNumber: "794600000001", statusCode: "DL" }, "delivered"],
  ["fedex", { trackingNumber: "794600000001", statusCode: "OD" }, "out_for_delivery"],
  ["fedex", { trackingNumber: "794600000001", statusCode: "IT" }, "in_transit"],
  ["fedex", { trackingNumber: "794600000001", statusCode: "DE" }, "exception"],
  ["ups", { trackingNumber: "1Z999AA10123456784", statusCode: "D" }, "delivered"],
  ["ups", { trackingNumber: "1Z999AA10123456784", statusCode: "O" }, "out_for_delivery"],
  ["ups", { trackingNumber: "1Z999AA10123456784", statusCode: "I" }, "in_transit"],
  ["ups", { trackingNumber: "1Z999AA10123456784", statusCode: "X" }, "exception"],
  ["dhl", { trackingNumber: "JD0146000012345", status: "delivered" }, "delivered"],
  ["dhl", { trackingNumber: "JD0146000012345", status: "out-for-delivery" }, "out_for_delivery"],
  ["dhl", { trackingNumber: "JD0146000012345", status: "transit" }, "in_transit"],
  ["dhl", { trackingNumber: "JD0146000012345", status: "failure" }, "exception"],
];

describe("normalization and publish", () => {
  it.each(CASES)("normalizes %s payload %# to %s", async (carrier, payload, expected) => {
    const body = JSON.stringify(payload);
    const res = await send(carrier, body, signed(carrier, body));
    expect(res.statusCode).toBe(200);
    expect(publishedEvent()).toMatchObject({
      carrier,
      trackingNumber: payload.trackingNumber,
      normalizedStatus: expected,
      timestamp: NOW.toISOString(),
    });
  });

  it("publishes one capped entry to events:shipment:status", async () => {
    const body = JSON.stringify({ trackingNumber: "794600000001", statusCode: "IT" });
    const res = await send("fedex", body, signed("fedex", body));
    expect(SHIPMENT_STATUS_STREAM).toBe("events:shipment:status");
    expect(xadd).toHaveBeenCalledWith(
      "events:shipment:status", "MAXLEN", "~", "50000", "*", "data", expect.any(String),
    );
    expect(JSON.parse(res.body)).toMatchObject({ data: { accepted: true }, error: null });
  });
});

describe("location and event id", () => {
  it("extracts the FedEx scan location", async () => {
    const body = JSON.stringify({
      trackResults: [{
        trackingNumber: "794600000001",
        latestStatusDetail: { code: "IT", scanLocation: { city: "MEMPHIS", countryCode: "US" } },
      }],
    });
    await send("fedex", body, signed("fedex", body));
    expect(publishedEvent()).toMatchObject({ locationCity: "MEMPHIS", locationCountry: "US" });
  });

  it("extracts the UPS activity location", async () => {
    const body = JSON.stringify({
      shipment: { package: [{
        trackingNumber: "1Z999AA10123456784",
        currentStatus: { code: "I" },
        activity: [{ location: { address: { city: "Louisville", countryCode: "US" } } }],
      }] },
    });
    await send("ups", body, signed("ups", body));
    expect(publishedEvent()).toMatchObject({ locationCity: "Louisville", locationCountry: "US" });
  });

  it("extracts the DHL status location", async () => {
    const body = JSON.stringify({
      shipments: [{
        id: "JD0146000012345",
        status: {
          statusCode: "transit",
          location: { address: { addressLocality: "Leipzig", countryCode: "DE" } },
        },
      }],
    });
    await send("dhl", body, signed("dhl", body));
    expect(publishedEvent()).toMatchObject({ locationCity: "Leipzig", locationCountry: "DE" });
  });

  it("omits location fields when the payload has none", async () => {
    const body = JSON.stringify({ trackingNumber: "794600000001", statusCode: "IT" });
    await send("fedex", body, signed("fedex", body));
    const event = publishedEvent();
    expect(event.locationCity).toBeUndefined();
    expect(event.locationCountry).toBeUndefined();
  });

  it("uses the carrier's eventId as rawEventId when present", async () => {
    const body = JSON.stringify({ trackingNumber: "794600000001", statusCode: "IT", eventId: "evt-42" });
    await send("fedex", body, signed("fedex", body));
    expect(publishedEvent().rawEventId).toBe("evt-42");
  });

  it("falls back to a stable body hash so retries share a rawEventId", async () => {
    const body = JSON.stringify({ trackingNumber: "794600000001", statusCode: "IT" });
    await send("fedex", body, signed("fedex", body));
    await send("fedex", body, signed("fedex", body));
    const ids = xadd.mock.calls.map((c) => JSON.parse(c[6] as string).rawEventId);
    expect(ids[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(ids[1]).toBe(ids[0]);
  });
});

describe("failure modes", () => {
  it.each([["not json"], ["[]"], ["42"]])(
    "returns 400 for a validly signed non-object body %j",
    async (body) => {
      const res = await send("fedex", body, signed("fedex", body));
      expect(res.statusCode).toBe(400);
      expect(xadd).not.toHaveBeenCalled();
    },
  );

  it("returns 400 when the payload has no tracking number", async () => {
    const res = await send("fedex", "{}", signed("fedex", "{}"));
    expect(res.statusCode).toBe(400);
    expect(xadd).not.toHaveBeenCalled();
  });

  it("returns 413 for a body over the size limit", async () => {
    const body = JSON.stringify({ trackingNumber: "x", pad: "a".repeat(101 * 1024) });
    const res = await send("fedex", body, signed("fedex", body));
    expect(res.statusCode).toBe(413);
    expect(xadd).not.toHaveBeenCalled();
  });

  it("returns 503 without leaking details when Redis rejects", async () => {
    xadd.mockRejectedValue(new Error("boom: redis down"));
    const body = JSON.stringify({ trackingNumber: "794600000001", statusCode: "IT" });
    const res = await send("fedex", body, signed("fedex", body));
    expect(res.statusCode).toBe(503);
    expect(res.body).not.toContain("boom");
  });
});

describe("latency", () => {
  it("accepts and publishes within 10ms (warm, in-memory Redis)", async () => {
    const body = JSON.stringify({ trackingNumber: "794600000001", statusCode: "IT" });
    await send("fedex", body, signed("fedex", body));
    xadd.mockClear();
    const start = performance.now();
    const res = await send("fedex", body, signed("fedex", body));
    expect(performance.now() - start).toBeLessThan(10);
    expect(res.statusCode).toBe(200);
  });
});
// END routes/webhooks.test.ts
