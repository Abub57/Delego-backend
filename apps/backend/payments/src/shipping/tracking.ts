/**
 * Carrier tracking helpers shared by the shipping detector and its store
 * (Issue #295).
 *
 * Everything here is pure: given a shipment's tracking history it answers "what
 * did the carrier last say", "when did anything last move", and "how many
 * business days is that ago". Business-day maths deliberately ignores weekends
 * only — there is no holiday calendar in the platform, so a threshold can be
 * reached a day or so late around public holidays.
 */

import type {
  InTransitShipment,
  ShipmentTrackingStatus,
  ShipmentTrackingUpdate,
} from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Terminal carrier states: the parcel is done, one way or another. */
export const TERMINAL_TRACKING_STATUSES: readonly ShipmentTrackingStatus[] = [
  "delivered",
  "returned",
];

/** The most recent carrier event, or `null` when the carrier has reported nothing. */
export function latestTrackingUpdate(shipment: InTransitShipment): ShipmentTrackingUpdate | null {
  let latest: ShipmentTrackingUpdate | null = null;
  let latestAt = Number.NEGATIVE_INFINITY;

  for (const event of shipment.trackingEvents) {
    const at = Date.parse(event.occurredAt);
    if (!Number.isFinite(at)) continue;
    if (at >= latestAt) {
      latest = event;
      latestAt = at;
    }
  }

  return latest;
}

/** Current carrier status, defaulting to `in_transit` before any update lands. */
export function currentTrackingStatus(shipment: InTransitShipment): ShipmentTrackingStatus {
  return latestTrackingUpdate(shipment)?.status ?? "in_transit";
}

/**
 * When the carrier last reported anything. Falls back to the hand-off time, so a
 * parcel that was collected and then never scanned still measures from shipping.
 */
export function lastMovementTimestamp(shipment: InTransitShipment): string {
  return latestTrackingUpdate(shipment)?.occurredAt ?? shipment.shippedAt;
}

/**
 * Adds `days` business days (skipping Saturday/Sunday) to `date`, preserving the
 * time of day. Negative values walk backwards.
 */
export function addBusinessDays(date: Date, days: number): Date {
  const result = new Date(date.getTime());
  let remaining = Math.trunc(days);

  while (remaining > 0) {
    result.setUTCDate(result.getUTCDate() + 1);
    if (isBusinessDay(result)) remaining -= 1;
  }
  while (remaining < 0) {
    result.setUTCDate(result.getUTCDate() - 1);
    if (isBusinessDay(result)) remaining += 1;
  }

  return result;
}

/**
 * Whole business days elapsed between `from` and `to` (0 when `to` is not
 * later, or either date is unparseable). Only complete 24h steps count, so
 * `Fri 23:00 → Mon 01:00` is one business day rather than two.
 */
export function businessDaysBetween(from: Date, to: Date): number {
  const fromMs = from.getTime();
  const toMs = to.getTime();
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return 0;

  const wholeDays = Math.floor((toMs - fromMs) / DAY_MS);
  const wholeWeeks = Math.floor(wholeDays / 7);

  let businessDays = wholeWeeks * 5;
  const cursor = new Date(fromMs + wholeWeeks * 7 * DAY_MS);
  for (let i = 0; i < wholeDays % 7; i++) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    if (isBusinessDay(cursor)) businessDays += 1;
  }

  return businessDays;
}

function isBusinessDay(date: Date): boolean {
  const day = date.getUTCDay();
  return day !== 0 && day !== 6;
}
