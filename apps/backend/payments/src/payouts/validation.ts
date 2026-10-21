import { type ValidationResult, requireString, requireStellarAddress } from "../validation.js";
import type { InitiatePayoutRequest } from "./types.js";

/**
 * Validates an initiate payout request
 */
export function validateInitiatePayoutRequest(
  body: Record<string, unknown>
): ValidationResult<InitiatePayoutRequest> {
  const escrowId = requireString(body, "escrowId");
  if (!escrowId.ok) return escrowId;

  const merchantAddress = requireStellarAddress(body, "merchantAddress");
  if (!merchantAddress.ok) return merchantAddress;

  const sourceAddress = requireStellarAddress(body, "sourceAddress");
  if (!sourceAddress.ok) return sourceAddress;

  return {
    ok: true,
    value: {
      escrowId: escrowId.value.trim(),
      merchantAddress: merchantAddress.value.trim(),
      sourceAddress: sourceAddress.value.trim(),
    },
  };
}
