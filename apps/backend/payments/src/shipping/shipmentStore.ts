/**
 * Shipment store for the shipping exception detector (Issue #295).
 *
 * The detector needs two things from storage: every shipment that is still in
 * transit, and a durable record of what has already been flagged — the flag is
 * what stops a daily scan from re-alerting a buyer about the same stuck package
 * every single day.
 *
 * `InMemoryShipmentStore` is the default; swap it for a PostgreSQL/Redis-backed
 * implementation in production via {@link setShipmentStore}. The carrier webhook
 * that receives tracking updates calls {@link InMemoryShipmentStore.recordTrackingUpdate},
 * which also clears a shipment's flag once it starts moving again, so a package
 * that stalls twice alerts twice.
 */

import { TERMINAL_TRACKING_STATUSES, currentTrackingStatus } from "./tracking.js";
import type {
  InTransitShipment,
  ShipmentTrackingUpdate,
  ShippingAnomalyReason,
  ShippingAnomalyRecord,
} from "./types.js";

/** Persisted flag for one shipment. */
export interface ShipmentAnomalyFlag {
  reason: ShippingAnomalyReason;
  detectedAt: string;
}

/** Storage contract the detector depends on. */
export interface ShipmentStore {
  /** Every shipment whose latest carrier status is not terminal. */
  listInTransit(): Promise<InTransitShipment[]>;

  /**
   * Records an anomaly.
   *
   * @returns `true` when this is a new flag (first detection, or the reason
   *          changed since the last flag) and a notification should be sent;
   *          `false` when the same reason is already flagged.
   */
  flagAnomaly(record: ShippingAnomalyRecord, detectedAt: string): Promise<boolean>;

  /** Reads the current flag for an order, if any. */
  getFlag(orderId: string): Promise<ShipmentAnomalyFlag | null>;

  /** Clears the flag once the shipment moves again or reaches a terminal state. */
  clearFlag(orderId: string): Promise<void>;
}

/** In-memory shipment store used by default, in tests, and in local dev. */
export class InMemoryShipmentStore implements ShipmentStore {
  private readonly shipments = new Map<string, InTransitShipment>();
  private readonly flags = new Map<string, ShipmentAnomalyFlag>();

  /** Registers (or replaces) a shipment. */
  upsertShipment(shipment: InTransitShipment): void {
    this.shipments.set(shipment.orderId, {
      ...shipment,
      trackingEvents: [...shipment.trackingEvents],
    });
  }

  /**
   * Appends a carrier tracking event. Movement clears any existing flag — if the
   * package stalls again later, the detector flags it afresh instead of treating
   * it as the stale anomaly it already reported.
   */
  recordTrackingUpdate(orderId: string, update: ShipmentTrackingUpdate): void {
    const shipment = this.shipments.get(orderId);
    if (!shipment) return;

    shipment.trackingEvents = [...shipment.trackingEvents, update];
    if (!TERMINAL_TRACKING_STATUSES.includes(update.status)) {
      this.flags.delete(orderId);
    }
  }

  async listInTransit(): Promise<InTransitShipment[]> {
    return [...this.shipments.values()]
      .filter((shipment) => !TERMINAL_TRACKING_STATUSES.includes(currentTrackingStatus(shipment)))
      .map((shipment) => ({ ...shipment, trackingEvents: [...shipment.trackingEvents] }));
  }

  async flagAnomaly(record: ShippingAnomalyRecord, detectedAt: string): Promise<boolean> {
    const existing = this.flags.get(record.orderId);
    if (existing && existing.reason === record.flagReason) {
      return false;
    }
    this.flags.set(record.orderId, { reason: record.flagReason, detectedAt });
    return true;
  }

  async getFlag(orderId: string): Promise<ShipmentAnomalyFlag | null> {
    return this.flags.get(orderId) ?? null;
  }

  async clearFlag(orderId: string): Promise<void> {
    this.flags.delete(orderId);
  }
}

let store: ShipmentStore = new InMemoryShipmentStore();

/** Current shipment store (in-memory unless {@link setShipmentStore} replaced it). */
export function getShipmentStore(): ShipmentStore {
  return store;
}

/** Swaps the backing store (production wiring, or a test double). */
export function setShipmentStore(next: ShipmentStore): void {
  store = next;
}

/** Resets to a fresh in-memory store and returns it, for tests and local dev. */
export function resetShipmentStore(): InMemoryShipmentStore {
  const next = new InMemoryShipmentStore();
  store = next;
  return next;
}
