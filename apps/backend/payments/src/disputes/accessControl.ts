/**
 * Order/dispute ownership enforcement (Issue #350 — IDOR mitigation).
 *
 * `GET /disputes/:disputeId` evaluated the dispute id without ever checking
 * that the caller was actually a party to the underlying order: any caller
 * who could guess or enumerate a dispute id could read another buyer's or
 * merchant's dispute, evidence, and audit trail.
 *
 * Ownership is verified against the escrow's payment record
 * (`buyerAddress`/`sellerAddress`), the durable source of truth for who the
 * two parties to an order are.
 *
 * The caller's verified identity is expected to arrive via the
 * `X-Requester-Address` header (+ optional `X-Requester-Role`), set by the
 * authenticated gateway in front of this service. A request that doesn't
 * carry the header yet is let through unchanged rather than rejected — this
 * adds enforcement wherever the identity is actually available instead of
 * breaking every caller that hasn't been migrated to send it.
 */

import type { PaymentRecord } from "../escrowCoordinator/types.js";

export type OrderAccessRole = "buyer" | "merchant" | "admin";

/** Matches the issue's `OrderAccessContext` schema. */
export interface OrderAccessContext {
  requesterAddress: string;
  requesterRole: OrderAccessRole;
  orderId: string;
}

export type OrderAccessDenialReason = "NOT_A_PARTY" | "RECORD_NOT_FOUND";

export interface OrderAccessCheckResult {
  ok: boolean;
  reason?: OrderAccessDenialReason;
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Reads the gateway-injected, already-authenticated requester address. */
export function extractRequesterAddress(
  headers: Record<string, string | string[] | undefined>
): string | undefined {
  const value = firstHeaderValue(headers["x-requester-address"]);
  return value || undefined;
}

/** Reads the gateway-injected requester role, if present and recognized. */
export function extractRequesterRole(
  headers: Record<string, string | string[] | undefined>
): OrderAccessRole | undefined {
  const raw = firstHeaderValue(headers["x-requester-role"]);
  return raw === "buyer" || raw === "merchant" || raw === "admin" ? raw : undefined;
}

/**
 * True if `requesterAddress` is one of the two parties to the order
 * described by `paymentRecord` (buyer or seller), or the requester holds
 * the admin role.
 */
export function isPartyToOrder(
  paymentRecord: Pick<PaymentRecord, "buyerAddress" | "sellerAddress"> | null,
  requesterAddress: string,
  requesterRole?: OrderAccessRole
): boolean {
  if (requesterRole === "admin") return true;
  if (!paymentRecord) return false;
  return requesterAddress === paymentRecord.buyerAddress || requesterAddress === paymentRecord.sellerAddress;
}

/**
 * Verify that `requesterAddress` (already authenticated upstream) is a
 * party to the order behind `paymentRecord`.
 *
 * Only call this once a requester address is actually known — a caller
 * with no identity at all should be handled separately by whoever decides
 * whether an identity is required for that route.
 */
export function checkOrderAccess(
  paymentRecord: Pick<PaymentRecord, "buyerAddress" | "sellerAddress"> | null,
  requesterAddress: string,
  requesterRole?: OrderAccessRole
): OrderAccessCheckResult {
  if (!paymentRecord) {
    // We know who's asking but can't resolve the order's parties to check
    // against — fail closed rather than assume access.
    return { ok: false, reason: "RECORD_NOT_FOUND" };
  }
  if (!isPartyToOrder(paymentRecord, requesterAddress, requesterRole)) {
    return { ok: false, reason: "NOT_A_PARTY" };
  }
  return { ok: true };
}
