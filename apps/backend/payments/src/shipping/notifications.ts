/**
 * Notification events for shipping exceptions (Issue #295).
 *
 * Flags are published on the shared `payments:events` stream — the same transport
 * used by the dispute, subscription and auto-release lifecycles — so the
 * notifications service can materialise a buyer-facing in-app notification.
 * Publishing is fire-and-forget: a transport failure is logged and never blocks
 * (or rolls back) the detection scan.
 *
 * The payload mirrors `InAppNotification` (notificationStore.ts) so the consumer
 * can persist it per recipient without reshaping: `category`, `type`, `title`,
 * `message`, `actionUrl`, `actionLabel`, and `metadata` (which carries the
 * `priority` — `in_app_notifications` has no priority column, `metadata` JSONB is
 * the supported place for it).
 */

import { createLogger } from "@delegolabs/utils";
import { publishPaymentEvent } from "../../events/index.js";
import type { InTransitShipment, ShippingAnomalyReason, ShippingAnomalyRecord } from "./types.js";

const log = createLogger("payments:shipping:notifications", process.env.LOG_LEVEL ?? "info");

export const SHIPPING_ANOMALY_EVENT = "shipping_anomaly_detected";

export interface ShippingAnomalyNotification {
  orderId: string;
  carrier: string;
  trackingNumber: string;
  reason: ShippingAnomalyReason;
  daysInTransit: number;
  lastUpdateTimestamp: string;
  /** Always `high`: a shipment that may never arrive must not be buried. */
  priority: "high";
  category: "transaction";
  title: string;
  message: string;
  actionUrl: string;
  actionLabel: string;
  /** Who the notification must reach; the buyer is the primary recipient. */
  recipients: {
    buyerId?: string;
    merchantId?: string;
  };
}

interface ReasonCopy {
  title: string;
  actionLabel: string;
  message: (record: ShippingAnomalyRecord) => string;
}

const REASON_COPY: Record<ShippingAnomalyReason, ReasonCopy> = {
  stalled_transit: {
    title: "Your package may be stuck in transit",
    actionLabel: "Start a carrier inquiry",
    message: (record) =>
      `${record.carrier} has not reported any movement since ${record.lastUpdateTimestamp} ` +
      `(order in transit ${record.daysInTransit} business days). Start an inquiry or request a refund if it stays missing.`,
  },
  return_to_sender: {
    title: "Your package is being returned",
    actionLabel: "Track the return",
    message: (record) =>
      `${record.carrier} is returning the package for order ${record.orderId} to the sender. ` +
      `The escrow release is paused until you confirm a redelivery or refund.`,
  },
  delivery_failed: {
    title: "Delivery attempt failed",
    actionLabel: "Arrange redelivery",
    message: (record) =>
      `${record.carrier} could not complete delivery for order ${record.orderId}. ` +
      `Arrange redelivery or open an inquiry before the package is returned.`,
  },
};

/** Dashboard route the inquiry action points at. */
export function shippingInquiryUrl(orderId: string): string {
  return `/orders/${encodeURIComponent(orderId)}/shipping`;
}

/** Builds the buyer/merchant notification payload for one anomaly. */
export function buildShippingAnomalyNotification(
  record: ShippingAnomalyRecord,
  shipment?: InTransitShipment
): ShippingAnomalyNotification {
  const copy = REASON_COPY[record.flagReason];

  return {
    orderId: record.orderId,
    carrier: record.carrier,
    trackingNumber: record.trackingNumber,
    reason: record.flagReason,
    daysInTransit: record.daysInTransit,
    lastUpdateTimestamp: record.lastUpdateTimestamp,
    priority: "high",
    category: "transaction",
    title: copy.title,
    message: copy.message(record),
    actionUrl: shippingInquiryUrl(record.orderId),
    actionLabel: copy.actionLabel,
    recipients: {
      buyerId: shipment?.buyerId,
      merchantId: shipment?.merchantId,
    },
  };
}

/**
 * Emits the anomaly event. Alerts both parties — the buyer needs to act, and the
 * merchant needs to know the package may be lost — with the buyer as the
 * primary, high-priority recipient.
 */
export async function notifyShippingAnomaly(
  record: ShippingAnomalyRecord,
  shipment?: InTransitShipment
): Promise<void> {
  const notification = buildShippingAnomalyNotification(record, shipment);

  log.warn("Shipping anomaly detected", {
    orderId: record.orderId,
    carrier: record.carrier,
    trackingNumber: record.trackingNumber,
    flagReason: record.flagReason,
    daysInTransit: record.daysInTransit,
    lastUpdateTimestamp: record.lastUpdateTimestamp,
    priority: notification.priority,
  });

  try {
    await publishPaymentEvent<ShippingAnomalyNotification>({
      type: SHIPPING_ANOMALY_EVENT,
      orderId: record.orderId,
      payload: notification,
      occurredAt: new Date().toISOString(),
    });
  } catch (err) {
    log.error("Failed to publish shipping anomaly event", {
      orderId: record.orderId,
      flagReason: record.flagReason,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
