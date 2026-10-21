import { describe, expect, it } from "vitest";

import {
  extractCarrierCheckpoint,
  mapCarrierStatus,
  normalizeCarrierTrackingEvent,
  normalizeTrackingEvent,
} from "./normalizer.js";

describe("extractCarrierCheckpoint", () => {
  it("returns null for a missing checkpoint", () => {
    expect(extractCarrierCheckpoint(undefined)).toBeNull();
    expect(extractCarrierCheckpoint(null)).toBeNull();
  });

  it("returns null when every field is blank", () => {
    expect(extractCarrierCheckpoint({ city: null, state: "", timestamp: undefined })).toBeNull();
  });

  it("keeps only the fields that are actually present", () => {
    expect(extractCarrierCheckpoint({ city: "Memphis", timestamp: null })).toEqual({
      city: "Memphis",
    });
  });

  it("falls back to `message` when `statusDetails` is absent (EasyPost shape)", () => {
    expect(extractCarrierCheckpoint({ message: "Arrived at facility" })).toEqual({
      statusDetails: "Arrived at facility",
    });
  });
});

describe("normalizeCarrierTrackingEvent — sparse carrier webhook payloads", () => {
  it("DHL: no checkpoint object at all never throws", () => {
    const event = normalizeCarrierTrackingEvent({
      carrier: "dhl",
      trackingNumber: "DHL-1",
      status: "transit",
    });
    expect(event.checkpoint).toBeNull();
    expect(event.status).toBe("in_transit");
    expect(event.occurredAt).toBeInstanceOf(Date);
  });

  it("FedEx: checkpoint present but every location field missing", () => {
    const event = normalizeCarrierTrackingEvent({
      carrier: "fedex",
      trackingNumber: "FDX-1",
      status: "DL",
      checkpoint: { city: undefined, state: undefined, country: undefined, timestamp: undefined },
    });
    expect(event.checkpoint).toBeNull();
    expect(event.status).toBe("delivered");
  });

  it("UPS: checkpoint has a timestamp but no location — occurredAt parses from it", () => {
    const event = normalizeCarrierTrackingEvent({
      carrier: "ups",
      trackingNumber: "1Z-1",
      status: "i",
      checkpoint: { timestamp: "2026-01-05T10:00:00.000Z" },
    });
    expect(event.checkpoint).toEqual({ timestamp: "2026-01-05T10:00:00.000Z" });
    expect(event.occurredAt.toISOString()).toBe("2026-01-05T10:00:00.000Z");
  });

  it("falls back to the current time when the checkpoint timestamp is unparseable", () => {
    const before = Date.now();
    const event = normalizeCarrierTrackingEvent({
      carrier: "ups",
      trackingNumber: "1Z-2",
      status: "i",
      checkpoint: { timestamp: "not-a-date" },
    });
    expect(event.occurredAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  it("an unrecognized status never throws and defaults to in_transit", () => {
    expect(mapCarrierStatus("dhl", undefined)).toBe("in_transit");
    expect(mapCarrierStatus(undefined as unknown as string, null)).toBe("in_transit");
  });
});

describe("normalizeTrackingEvent (existing status-only path, unaffected)", () => {
  it("still normalizes without a checkpoint argument", () => {
    const payload = normalizeTrackingEvent({
      orderId: "order-1",
      carrier: "fedex",
      trackingNumber: "FDX-2",
      status: "dl",
      deliveredTimestamp: "2026-01-01T00:00:00.000Z",
    });
    expect(payload.state).toBe("delivered");
    expect(payload.deliveredTimestamp).toBe("2026-01-01T00:00:00.000Z");
  });
});
