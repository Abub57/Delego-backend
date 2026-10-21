import { afterEach, describe, expect, it, vi } from "vitest";

import {
  addBusinessDays,
  buildShippingAnomalyNotification,
  businessDaysBetween,
  classifyAnomaly,
  currentTrackingStatus,
  detectShippingExceptions,
  lastMovementTimestamp,
  latestTrackingUpdate,
  notifyShippingAnomaly,
  resetShipmentStore,
  resolveShippingDetectionConfig,
} from "./index.js";
import type { InTransitShipment, ShipmentStore } from "./index.js";

vi.mock("@delegolabs/utils", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const DAY_MS = 86_400_000;
/** Monday, so the weekday arithmetic below is easy to reason about. */
const NOW = new Date("2026-09-28T12:00:00.000Z");

const daysAgo = (days: number): string => new Date(NOW.getTime() - days * DAY_MS).toISOString();
const daysAhead = (days: number): string => new Date(NOW.getTime() + days * DAY_MS).toISOString();

function shipment(overrides: Partial<InTransitShipment> = {}): InTransitShipment {
  return {
    orderId: "order-1",
    carrier: "Stellar Express",
    trackingNumber: "SE-123",
    shippedAt: daysAgo(20),
    estimatedDeliveryAt: daysAhead(5),
    buyerId: "buyer-1",
    merchantId: "merchant-1",
    trackingEvents: [{ status: "in_transit", occurredAt: daysAgo(12) }],
    ...overrides,
  };
}

afterEach(() => {
  resetShipmentStore();
  vi.restoreAllMocks();
});

describe("business day arithmetic", () => {
  it("skips weekends when adding business days", () => {
    // Friday -> Monday
    expect(addBusinessDays(new Date("2026-09-25T09:00:00.000Z"), 1).toISOString()).toBe(
      "2026-09-28T09:00:00.000Z"
    );
    // Monday + 5 business days -> next Monday
    expect(addBusinessDays(new Date("2026-09-21T09:00:00.000Z"), 5).toISOString()).toBe(
      "2026-09-28T09:00:00.000Z"
    );
    // Walks backwards too
    expect(addBusinessDays(new Date("2026-09-28T09:00:00.000Z"), -1).toISOString()).toBe(
      "2026-09-25T09:00:00.000Z"
    );
  });

  it("counts whole business days between two instants", () => {
    expect(businessDaysBetween(new Date("2026-09-28T12:00:00.000Z"), new Date("2026-09-29T12:00:00.000Z"))).toBe(1);
    // Friday -> Monday is one business day
    expect(businessDaysBetween(new Date("2026-09-25T12:00:00.000Z"), new Date("2026-09-28T12:00:00.000Z"))).toBe(1);
    // A full week is five
    expect(businessDaysBetween(new Date("2026-09-21T12:00:00.000Z"), new Date("2026-09-28T12:00:00.000Z"))).toBe(5);
    expect(businessDaysBetween(new Date("2026-09-28T12:00:00.000Z"), new Date("2026-09-28T12:00:00.000Z"))).toBe(0);
    expect(businessDaysBetween(new Date("not-a-date"), NOW)).toBe(0);
  });
});

describe("tracking helpers", () => {
  it("picks the latest event regardless of array order", () => {
    const parcel = shipment({
      trackingEvents: [
        { status: "out_for_delivery", occurredAt: daysAgo(1) },
        { status: "in_transit", occurredAt: daysAgo(9) },
        { status: "in_transit", occurredAt: daysAgo(5) },
      ],
    });

    expect(latestTrackingUpdate(parcel)?.status).toBe("out_for_delivery");
    expect(currentTrackingStatus(parcel)).toBe("out_for_delivery");
    expect(lastMovementTimestamp(parcel)).toBe(daysAgo(1));
  });

  it("falls back to the hand-off time when the carrier reported nothing", () => {
    const parcel = shipment({ trackingEvents: [] });

    expect(latestTrackingUpdate(parcel)).toBeNull();
    expect(currentTrackingStatus(parcel)).toBe("in_transit");
    expect(lastMovementTimestamp(parcel)).toBe(parcel.shippedAt);
  });
});

describe("classifyAnomaly", () => {
  it("leaves a healthy shipment alone", () => {
    const parcel = shipment({
      shippedAt: daysAgo(3),
      estimatedDeliveryAt: daysAhead(5),
      trackingEvents: [{ status: "in_transit", occurredAt: daysAgo(1) }],
    });

    expect(classifyAnomaly(parcel, NOW)).toBeNull();
  });

  it("flags a package with no movement for more than 7 business days", () => {
    const anomaly = classifyAnomaly(shipment(), NOW);

    expect(anomaly).not.toBeNull();
    expect(anomaly?.flagReason).toBe("stalled_transit");
    expect(anomaly?.orderId).toBe("order-1");
    expect(anomaly?.carrier).toBe("Stellar Express");
    expect(anomaly?.trackingNumber).toBe("SE-123");
    expect(anomaly?.lastUpdateTimestamp).toBe(daysAgo(12));
    expect(anomaly?.daysInTransit).toBe(14);
  });

  it("does not flag a package that moved within the window", () => {
    const parcel = shipment({
      trackingEvents: [{ status: "in_transit", occurredAt: daysAgo(5) }],
    });

    expect(classifyAnomaly(parcel, NOW)).toBeNull();
  });

  it("flags a package more than 10 business days past its estimated delivery", () => {
    const parcel = shipment({
      estimatedDeliveryAt: daysAgo(16),
      trackingEvents: [{ status: "in_transit", occurredAt: daysAgo(1) }],
    });

    expect(classifyAnomaly(parcel, NOW)?.flagReason).toBe("stalled_transit");
  });

  it("tolerates an estimated delivery inside the grace window", () => {
    const parcel = shipment({
      estimatedDeliveryAt: daysAgo(12),
      trackingEvents: [{ status: "in_transit", occurredAt: daysAgo(1) }],
    });

    expect(classifyAnomaly(parcel, NOW)).toBeNull();
  });

  it("flags a return to sender and a failed delivery", () => {
    expect(
      classifyAnomaly(
        shipment({ trackingEvents: [{ status: "return_to_sender", occurredAt: daysAgo(1) }] }),
        NOW
      )?.flagReason
    ).toBe("return_to_sender");

    expect(
      classifyAnomaly(
        shipment({ trackingEvents: [{ status: "delivery_failed", occurredAt: daysAgo(1) }] }),
        NOW
      )?.flagReason
    ).toBe("delivery_failed");
  });

  it("prefers the most specific terminal reason", () => {
    const parcel = shipment({
      trackingEvents: [
        { status: "delivery_failed", occurredAt: daysAgo(9) },
        { status: "return_to_sender", occurredAt: daysAgo(1) },
      ],
    });

    expect(classifyAnomaly(parcel, NOW)?.flagReason).toBe("return_to_sender");
  });

  it("ignores shipments that already reached a terminal state", () => {
    expect(
      classifyAnomaly(shipment({ trackingEvents: [{ status: "delivered", occurredAt: daysAgo(1) }] }), NOW)
    ).toBeNull();
  });

  it("measures from the hand-off when the carrier never scanned the parcel", () => {
    const parcel = shipment({ trackingEvents: [] });

    const anomaly = classifyAnomaly(parcel, NOW);

    expect(anomaly?.flagReason).toBe("stalled_transit");
    expect(anomaly?.lastUpdateTimestamp).toBe(parcel.shippedAt);
  });

  it("honours an override threshold", () => {
    const parcel = shipment({
      trackingEvents: [{ status: "in_transit", occurredAt: daysAgo(12) }],
    });

    expect(classifyAnomaly(parcel, NOW, { stalledMovementBusinessDays: 20, etaGraceBusinessDays: 10 })).toBeNull();
  });
});

describe("detectShippingExceptions", () => {
  it("flags a stuck shipment once and notifies the parties", async () => {
    const store = resetShipmentStore();
    store.upsertShipment(shipment());
    const notify = vi.fn().mockResolvedValue(undefined);

    const result = await detectShippingExceptions(NOW, { store, notify });

    expect(result.scanned).toBe(1);
    expect(result.flagged).toHaveLength(1);
    expect(result.flagged[0].flagReason).toBe("stalled_transit");
    expect(result.duplicates).toBe(0);
    expect(result.errors).toEqual([]);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toMatchObject({ orderId: "order-1", flagReason: "stalled_transit" });
    await expect(store.getFlag("order-1")).resolves.toEqual({
      reason: "stalled_transit",
      detectedAt: NOW.toISOString(),
    });
  });

  it("does not re-notify a shipment already flagged for the same reason", async () => {
    const store = resetShipmentStore();
    store.upsertShipment(shipment());
    const notify = vi.fn().mockResolvedValue(undefined);

    const first = await detectShippingExceptions(NOW, { store, notify });
    const second = await detectShippingExceptions(NOW, { store, notify });

    expect(first.flagged).toHaveLength(1);
    expect(second.flagged).toHaveLength(0);
    expect(second.duplicates).toBe(1);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("re-flags a shipment that stalls again after moving", async () => {
    const store = resetShipmentStore();
    store.upsertShipment(shipment());
    const notify = vi.fn().mockResolvedValue(undefined);

    await detectShippingExceptions(NOW, { store, notify });

    // The carrier finally scans the parcel: movement clears the flag.
    store.recordTrackingUpdate("order-1", { status: "in_transit", occurredAt: NOW.toISOString() });
    await expect(store.getFlag("order-1")).resolves.toBeNull();

    const later = new Date(NOW.getTime() + 20 * DAY_MS);
    const again = await detectShippingExceptions(later, { store, notify });

    expect(again.flagged).toHaveLength(1);
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("excludes delivered shipments from the scan", async () => {
    const store = resetShipmentStore();
    store.upsertShipment(
      shipment({ trackingEvents: [{ status: "delivered", occurredAt: daysAgo(1) }] })
    );

    const result = await detectShippingExceptions(NOW, { store });

    expect(result.scanned).toBe(0);
    expect(result.flagged).toEqual([]);
  });

  it("isolates a failing shipment instead of aborting the scan", async () => {
    const stuck = shipment({ orderId: "broken" });
    const healthyStuck = shipment({ orderId: "fine" });
    const store: ShipmentStore = {
      listInTransit: async () => [stuck, healthyStuck],
      flagAnomaly: async (record) => {
        if (record.orderId === "broken") throw new Error("failed to persist flag");
        return true;
      },
      getFlag: async () => null,
      clearFlag: async () => undefined,
    };
    const notify = vi.fn().mockResolvedValue(undefined);

    const result = await detectShippingExceptions(NOW, { store, notify });

    expect(result.scanned).toBe(2);
    expect(result.flagged.map((record) => record.orderId)).toEqual(["fine"]);
    expect(result.errors).toEqual(["broken: failed to persist flag"]);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("uses the injected thresholds", async () => {
    const store = resetShipmentStore();
    store.upsertShipment(shipment());

    const result = await detectShippingExceptions(NOW, {
      store,
      config: { stalledMovementBusinessDays: 30, etaGraceBusinessDays: 30 },
    });

    expect(result.flagged).toEqual([]);
  });
});

describe("shipping anomaly notification", () => {
  const record = {
    orderId: "order-1",
    carrier: "Stellar Express",
    trackingNumber: "SE-123",
    daysInTransit: 14,
    lastUpdateTimestamp: daysAgo(12),
    flagReason: "stalled_transit" as const,
  };

  it("addresses both parties with a high-priority inquiry action", () => {
    const notification = buildShippingAnomalyNotification(record, shipment());

    expect(notification.priority).toBe("high");
    expect(notification.category).toBe("transaction");
    expect(notification.recipients).toEqual({ buyerId: "buyer-1", merchantId: "merchant-1" });
    expect(notification.actionUrl).toBe("/orders/order-1/shipping");
    expect(notification.actionLabel).toBe("Start a carrier inquiry");
    expect(notification.title).toContain("stuck");
    expect(notification.message).toContain("Stellar Express");
  });

  it("writes reason-specific copy for returns and failed deliveries", () => {
    expect(
      buildShippingAnomalyNotification({ ...record, flagReason: "return_to_sender" }).actionLabel
    ).toBe("Track the return");
    expect(
      buildShippingAnomalyNotification({ ...record, flagReason: "delivery_failed" }).title
    ).toContain("Delivery attempt failed");
  });

  it("tolerates a shipment with no party identifiers", () => {
    const notification = buildShippingAnomalyNotification(record);

    expect(notification.recipients.buyerId).toBeUndefined();
    expect(notification.recipients.merchantId).toBeUndefined();
  });

  it("publishes without throwing even though there is no Redis in tests", async () => {
    await expect(notifyShippingAnomaly(record, shipment())).resolves.toBeUndefined();
  });
});

describe("resolveShippingDetectionConfig", () => {
  it("defaults to 7 days without movement and a 10 day ETA grace", () => {
    expect(resolveShippingDetectionConfig({})).toEqual({
      stalledMovementBusinessDays: 7,
      etaGraceBusinessDays: 10,
    });
  });

  it("reads overrides from the environment", () => {
    expect(
      resolveShippingDetectionConfig({
        SHIPPING_STALLED_MOVEMENT_DAYS: "3",
        SHIPPING_ETA_GRACE_BUSINESS_DAYS: "14",
      })
    ).toEqual({ stalledMovementBusinessDays: 3, etaGraceBusinessDays: 14 });
  });

  it("rejects a non-numeric threshold", () => {
    expect(() => resolveShippingDetectionConfig({ SHIPPING_STALLED_MOVEMENT_DAYS: "never" })).toThrow();
  });
});
