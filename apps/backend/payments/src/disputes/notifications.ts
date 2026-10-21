/**
 * Notification events for the dispute-mediation lifecycle (Issue #46).
 *
 * Published on the shared `payments:events` stream (same transport as the
 * rest of the payment lifecycle events) so the notifications service can
 * alert the buyer and seller on every status transition. Publishing is
 * fire-and-forget: a transport failure is logged but never blocks the
 * mediation flow itself.
 */

import { createLogger } from "@delegolabs/utils";
import { publishPaymentEvent } from "../../events/index.js";
import type { Dispute } from "./types.js";

const log = createLogger("payments:disputes:notifications", process.env.LOG_LEVEL ?? "info");

export type DisputeEventType =
  | "dispute_opened"
  | "dispute_evidence_submitted"
  | "dispute_mediator_assigned"
  | "dispute_merchant_response_submitted"
  | "dispute_status_changed"
  | "dispute_decided"
  | "dispute_resolved"
  | "dispute_sla_breached"
  | "dispute_escalated"
  | "partial_refund_executed";

export interface DisputeEventPayload {
  disputeId: string;
  escrowId: string;
  status?: string;
  mediator?: string;
  actor?: string;
  [key: string]: unknown;
}

async function emit(type: DisputeEventType, orderId: string, payload: DisputeEventPayload): Promise<void> {
  log.info(`Dispute event: ${type}`, payload);
  try {
    await publishPaymentEvent({
      type,
      orderId,
      paymentId: payload.escrowId,
      payload,
      occurredAt: new Date().toISOString(),
    });
  } catch (err) {
    log.error("Failed to publish dispute event", {
      type,
      escrowId: payload.escrowId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Notifies both the buyer and seller of a dispute status change / lifecycle event. */
export async function notifyDisputeParties(
  type: DisputeEventType,
  orderId: string,
  dispute: Pick<Dispute, "id" | "escrowId" | "status" | "mediator">,
  extra: Record<string, unknown> = {}
): Promise<void> {
  await emit(type, orderId, {
    disputeId: dispute.id,
    escrowId: dispute.escrowId,
    status: dispute.status,
    mediator: dispute.mediator,
    ...extra,
  });
}

export async function notifyPartialRefundExecuted(
  orderId: string,
  escrowId: string,
  payload: Record<string, unknown>
): Promise<void> {
  await emit("partial_refund_executed", orderId, { disputeId: "", escrowId, ...payload });
}
