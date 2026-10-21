/**
 * Carrier shipment tracking ingestion (Issue #295 scope).
 *
 * Merchants register a tracking number for an order; the shipment is held in
 * an in-memory registry keyed by order id and can be read back by the
 * `/api/v1/merchant/orders/:orderId/shipment` route. Malformed carrier
 * tracking codes are rejected before registration.
 */

import { createLogger } from "@delegolabs/utils";

const log = createLogger("payments:shipping:service", process.env.LOG_LEVEL ?? "info");

/** Carriers the tracking ingester understands. */
export type ShippingCarrier = "fedex" | "ups" | "usps" | "dhl";

/** Request to register a merchant-submitted tracking number. */
export interface RegisterShipmentDTO {
  orderId: string;
  carrier: ShippingCarrier;
  trackingNumber: string;
}

/** Successful registration result. */
export interface RegisterShipmentResponse {
  orderId: string;
  carrier: ShippingCarrier;
  trackingNumber: string;
  status: "registered";
  registeredAt: string;
}

/** Failure reason returned when a shipment cannot be registered. */
export interface RegisterShipmentError {
  code: "INVALID_TRACKING_NUMBER";
  message: string;
  details?: Record<string, unknown>;
}

export type RegisterShipmentResult =
  | { ok: true; response: RegisterShipmentResponse }
  | { ok: false; error: RegisterShipmentError };

/** Per-carrier tracking number shape. */
const TRACKING_NUMBER_PATTERNS: Record<ShippingCarrier, RegExp> = {
  ups: /^1Z[0-9A-Z]{16}$/,
  fedex: /^\d{12}$|^\d{15}$/,
  usps: /^\d{20,22}$/,
  dhl: /^\d{10}$/,
};

// In-memory registry keyed by order id. A production deployment would persist
// this alongside the order record and register a carrier webhook.
const shipments = new Map<string, RegisterShipmentResponse>();

/** Returns whether `trackingNumber` matches the expected shape for `carrier`. */
function isValidTrackingNumber(carrier: ShippingCarrier, trackingNumber: string): boolean {
  return TRACKING_NUMBER_PATTERNS[carrier].test(trackingNumber);
}

/**
 * Register a tracking number for an order.
 *
 * @returns the stored registration, or an `INVALID_TRACKING_NUMBER` error when
 *          the tracking code does not match the carrier's format.
 */
export async function registerShipment(dto: RegisterShipmentDTO): Promise<RegisterShipmentResult> {
  const trackingNumber = dto.trackingNumber.trim().toUpperCase();
  const { carrier, orderId } = dto;

  if (!isValidTrackingNumber(carrier, trackingNumber)) {
    return {
      ok: false,
      error: {
        code: "INVALID_TRACKING_NUMBER",
        message: `Tracking number is not a valid ${carrier} code`,
        details: { carrier, trackingNumber },
      },
    };
  }

  const response: RegisterShipmentResponse = {
    orderId,
    carrier,
    trackingNumber,
    status: "registered",
    registeredAt: new Date().toISOString(),
  };
  shipments.set(orderId, response);

  log.info("Shipment registered", { orderId, carrier, trackingNumber });

  return { ok: true, response };
}

/** Read the registration for an order, or `null` when none exists. */
export function getShipment(orderId: string): RegisterShipmentResponse | null {
  return shipments.get(orderId) ?? null;
}
