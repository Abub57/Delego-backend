/**
 * Validation for the shipment registration endpoint.
 */

import { requireString, type ValidationResult } from "../validation.js";
import type { ShippingCarrier } from "./service.js";

const SHIPPING_CARRIERS = new Set<string>(["fedex", "ups", "usps", "dhl"]);

function isShippingCarrier(value: string): value is ShippingCarrier {
  return SHIPPING_CARRIERS.has(value);
}

/**
 * Validate a shipment registration body.
 *
 * Requires a known `carrier` and a non-empty `trackingNumber`. The carrier
 * specific tracking code format is enforced by `registerShipment`.
 */
export function validateRegisterShipment(
  body: Record<string, unknown>
): ValidationResult<{ carrier: ShippingCarrier; trackingNumber: string }> {
  const carrier = requireString(body, "carrier");
  if (!carrier.ok) return carrier;

  const normalizedCarrier = carrier.value.toLowerCase();
  if (!isShippingCarrier(normalizedCarrier)) {
    return {
      ok: false,
      error: {
        code: "VALIDATION_ERROR",
        message: `carrier must be one of: ${[...SHIPPING_CARRIERS].join(", ")}`,
        details: { field: "carrier" },
      },
    };
  }

  const trackingNumber = requireString(body, "trackingNumber");
  if (!trackingNumber.ok) return trackingNumber;

  return {
    ok: true,
    value: { carrier: normalizedCarrier, trackingNumber: trackingNumber.value },
  };
}
