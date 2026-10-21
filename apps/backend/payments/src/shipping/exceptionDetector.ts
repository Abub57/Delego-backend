/**
 * Shipping exception & lost package detector (Issue #295).
 *
 * A daily scan over shipped orders that classifies each one as healthy or
 * exceptional, flags what it finds once, and emits a high-priority notification
 * event so the buyer (and merchant) can open a carrier inquiry:
 *
 *   - `stalled_transit`    — no carrier movement for more than
 *                            `stalledMovementBusinessDays` (default 7), or more
 *                            than `etaGraceBusinessDays` (default 10) business
 *                            days past the estimated delivery date.
 *   - `return_to_sender`   — the carrier is sending the parcel back.
 *   - `delivery_failed`    — the carrier reported a failed attempt/exception.
 *
 * Flagging is idempotent per (order, reason): a package that stays stuck is
 * flagged once, not once a day. Movement clears the flag through
 * {@link InMemoryShipmentStore.recordTrackingUpdate}, so a package that stalls a
 * second time alerts again. One bad shipment never aborts the scan — its error is
 * collected in {@link ShippingScanResult.errors} and the scan moves on.
 */

import { createLogger, type Logger } from "@delegolabs/utils";

import {
  businessDaysBetween,
  currentTrackingStatus,
  lastMovementTimestamp,
} from "./tracking.js";
import { notifyShippingAnomaly } from "./notifications.js";
import { getShipmentStore, type ShipmentStore } from "./shipmentStore.js";
import {
  DEFAULT_SHIPPING_DETECTION_CONFIG,
  type InTransitShipment,
  type ShipmentTrackingStatus,
  type ShippingAnomalyReason,
  type ShippingAnomalyRecord,
  type ShippingDetectionConfig,
  type ShippingScanResult,
} from "./types.js";

const log = createLogger("payments:shipping:exceptions", process.env.LOG_LEVEL ?? "info");

/** Carrier states that mean the parcel will not arrive as addressed. */
const RETURN_STATUSES: readonly ShipmentTrackingStatus[] = ["return_to_sender", "returned"];

/** Carrier states that mean the delivery itself failed. */
const FAILED_STATUSES: readonly ShipmentTrackingStatus[] = ["delivery_failed", "exception"];

/** Carrier states that end the shipment, so no inquiry is needed. */
const TERMINAL_STATUSES: readonly ShipmentTrackingStatus[] = ["delivered", "returned"];

export interface ShippingDetectionDeps {
  /** Storage override; defaults to the shared shipment store. */
  store?: ShipmentStore;
  /** Threshold override; defaults to {@link resolveShippingDetectionConfig}. */
  config?: ShippingDetectionConfig;
  /** Notification sink override; defaults to {@link notifyShippingAnomaly}. */
  notify?: (record: ShippingAnomalyRecord, shipment: InTransitShipment) => Promise<void>;
  /** Logger override. */
  logger?: Logger;
}

/**
 * Classifies one in-transit shipment.
 *
 * @returns the anomaly to flag, or `null` when the shipment is healthy (or
 *          already in a terminal state).
 */
export function classifyAnomaly(
  shipment: InTransitShipment,
  now: Date = new Date(),
  config: ShippingDetectionConfig = DEFAULT_SHIPPING_DETECTION_CONFIG
): ShippingAnomalyRecord | null {
  const status = currentTrackingStatus(shipment);
  if (TERMINAL_STATUSES.includes(status)) return null;

  const lastMovement = lastMovementTimestamp(shipment);
  const build = (flagReason: ShippingAnomalyReason): ShippingAnomalyRecord => ({
    orderId: shipment.orderId,
    carrier: shipment.carrier,
    trackingNumber: shipment.trackingNumber,
    daysInTransit: businessDaysBetween(new Date(shipment.shippedAt), now),
    lastUpdateTimestamp: lastMovement,
    flagReason,
  });

  // Most specific, most actionable reason first: a return or a failed attempt
  // tells the buyer exactly what to do, while "stalled" is an inference.
  if (RETURN_STATUSES.includes(status)) return build("return_to_sender");
  if (FAILED_STATUSES.includes(status)) return build("delivery_failed");

  const stalledFor = businessDaysBetween(new Date(lastMovement), now);
  if (stalledFor > config.stalledMovementBusinessDays) return build("stalled_transit");

  const estimatedDelivery = new Date(shipment.estimatedDeliveryAt);
  const pastEta = businessDaysBetween(estimatedDelivery, now);
  if (estimatedDelivery.getTime() < now.getTime() && pastEta > config.etaGraceBusinessDays) {
    return build("stalled_transit");
  }

  return null;
}

/**
 * Runs one detection scan. Safe to call daily (or more often): each order is
 * flagged once per reason, and only new flags emit a notification.
 */
export async function detectShippingExceptions(
  now: Date = new Date(),
  deps: ShippingDetectionDeps = {}
): Promise<ShippingScanResult> {
  const store = deps.store ?? getShipmentStore();
  const config = deps.config ?? resolveShippingDetectionConfig();
  const notify = deps.notify ?? notifyShippingAnomaly;
  const scanLog = deps.logger ?? log;

  const startedAt = now.toISOString();
  const started = Date.now();
  const flagged: ShippingAnomalyRecord[] = [];
  const errors: string[] = [];
  let duplicates = 0;
  let scanned = 0;

  const shipments = await store.listInTransit();

  for (const shipment of shipments) {
    scanned += 1;
    try {
      const anomaly = classifyAnomaly(shipment, now, config);
      if (!anomaly) continue;

      const isNew = await store.flagAnomaly(anomaly, startedAt);
      if (!isNew) {
        duplicates += 1;
        continue;
      }

      flagged.push(anomaly);
      scanLog.warn("Shipping exception flagged", {
        orderId: anomaly.orderId,
        flagReason: anomaly.flagReason,
        carrier: anomaly.carrier,
        trackingNumber: anomaly.trackingNumber,
        daysInTransit: anomaly.daysInTransit,
        lastUpdateTimestamp: anomaly.lastUpdateTimestamp,
        lastCarrierStatus: currentTrackingStatus(shipment),
        trackingEvents: shipment.trackingEvents.length,
      });

      await notify(anomaly, shipment);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`${shipment.orderId}: ${message}`);
      scanLog.error("Failed to process shipment", {
        orderId: shipment.orderId,
        error: message,
      });
    }
  }

  const result: ShippingScanResult = {
    scanned,
    flagged,
    duplicates,
    errors,
    startedAt,
    durationMs: Date.now() - started,
  };

  scanLog.info("Shipping exception scan complete", {
    scanned: result.scanned,
    flagged: result.flagged.length,
    duplicates: result.duplicates,
    errors: result.errors.length,
    durationMs: result.durationMs,
  });

  return result;
}

/** Reads the detector's thresholds from the environment. */
export function resolveShippingDetectionConfig(
  env: NodeJS.ProcessEnv = process.env
): ShippingDetectionConfig {
  return {
    stalledMovementBusinessDays: readPositiveInt(env, "SHIPPING_STALLED_MOVEMENT_DAYS", 7),
    etaGraceBusinessDays: readPositiveInt(env, "SHIPPING_ETA_GRACE_BUSINESS_DAYS", 10),
  };
}

/**
 * Starts the daily shipping-exception scan (default every 24h; configurable via
 * `SHIPPING_EXCEPTION_SCAN_INTERVAL_SECONDS`). Mirrors the dispute SLA
 * scheduler's shape — an immediate pass plus a fixed interval — and returns a
 * stop function for graceful shutdown.
 */
export function startShippingExceptionScheduler(): () => void {
  const intervalSeconds = Number(process.env.SHIPPING_EXCEPTION_SCAN_INTERVAL_SECONDS ?? 86_400);
  const intervalMs = intervalSeconds * 1000;

  const runScan = (): void => {
    detectShippingExceptions().catch((err) => {
      log.error("Unhandled error in shipping exception scheduler", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  };

  runScan();
  const intervalId = setInterval(runScan, intervalMs);

  log.info("Shipping exception scheduler started", { intervalSeconds });

  return () => {
    clearInterval(intervalId);
    log.info("Shipping exception scheduler stopped");
  };
}

function readPositiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  return parsed;
}
