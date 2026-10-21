/**
 * Shipping exception & lost package detection (Issue #295) — shared types.
 *
 * A shipped order is "in transit" until its carrier reports a terminal state.
 * The detector watches those shipments for three failure modes: a package that
 * stops moving, a package the carrier is returning, and a failed delivery
 * attempt. Anything it flags becomes a {@link ShippingAnomalyRecord}.
 */

/** Why a shipment was flagged. */
export type ShippingAnomalyReason =
  | "stalled_transit"
  | "return_to_sender"
  | "delivery_failed";

/**
 * The anomaly handed to the notification layer. Shape comes from the issue spec
 * (shipping exception detector, Issue #295).
 */
export interface ShippingAnomalyRecord {
  orderId: string;
  carrier: string;
  trackingNumber: string;
  /** Whole business days between the shipment date and the scan. */
  daysInTransit: number;
  /** When the carrier last reported anything about this package (ISO-8601). */
  lastUpdateTimestamp: string;
  flagReason: ShippingAnomalyReason;
}

/** Carrier tracking states the detector understands. */
export type ShipmentTrackingStatus =
  | "in_transit"
  | "out_for_delivery"
  | "delivered"
  | "delivery_failed"
  | "exception"
  | "return_to_sender"
  | "returned";

/** One carrier tracking event for a shipment. */
export interface ShipmentTrackingUpdate {
  status: ShipmentTrackingStatus;
  /** ISO-8601 timestamp the carrier reported at. */
  occurredAt: string;
  description?: string;
  location?: string;
}

/**
 * The projection of an order the detector needs: where it is, who is waiting for
 * it, and everything the carrier has said about it so far.
 */
export interface InTransitShipment {
  orderId: string;
  carrier: string;
  trackingNumber: string;
  /** ISO-8601 timestamp the merchant handed the parcel to the carrier. */
  shippedAt: string;
  /** ISO-8601 carrier estimate; the grace window is measured from here. */
  estimatedDeliveryAt: string;
  buyerId?: string;
  merchantId?: string;
  /** Carrier events in any order; the detector sorts by `occurredAt`. */
  trackingEvents: ShipmentTrackingUpdate[];
}

/** Thresholds controlling what counts as an exception. */
export interface ShippingDetectionConfig {
  /**
   * More than this many business days without a carrier update flags
   * `stalled_transit`. Default 7 (issue task: "no movement for > 7 days").
   */
  stalledMovementBusinessDays: number;
  /**
   * More than this many business days past the estimated delivery date flags
   * `stalled_transit` even if the tracking still updates. Default 10 (issue
   * context: "stuck in transit > 10 business days past estimated delivery").
   */
  etaGraceBusinessDays: number;
}

export const DEFAULT_SHIPPING_DETECTION_CONFIG: ShippingDetectionConfig = {
  stalledMovementBusinessDays: 7,
  etaGraceBusinessDays: 10,
};

/** Outcome of one detection scan. */
export interface ShippingScanResult {
  /** Shipments the store reported as in transit and that were classified. */
  scanned: number;
  /** Newly flagged shipments; one notification event is emitted per entry. */
  flagged: ShippingAnomalyRecord[];
  /** Shipments already flagged with the same reason, so nothing was re-sent. */
  duplicates: number;
  /** Per-shipment failures; one bad shipment never aborts the scan. */
  errors: string[];
  startedAt: string;
  durationMs: number;
}
