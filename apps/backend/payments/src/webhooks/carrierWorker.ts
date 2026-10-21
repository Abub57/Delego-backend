/**
 * Carrier tracking event processor (Issue #291).
 *
 * Consumes normalized events from the `carrier-tracking-events` BullMQ queue.
 * The default processor is intentionally side-effect-light (structured log) —
 * persistence / notification fan-out can be added without changing the
 * webhook route or queue contract.
 */

import { createLogger } from "@delegolabs/utils";
import { registerCarrierEventProcessor, type CarrierEventProcessor } from "./carrierQueue.js";
import type { NormalizedCarrierEvent } from "./carrierWebhook.js";

const log = createLogger("payments:webhooks:carrier-worker", process.env.LOG_LEVEL ?? "info");

/** Default async processor: logs the normalized tracking update. */
export const processCarrierEvent: CarrierEventProcessor = async (
  event: NormalizedCarrierEvent
): Promise<void> => {
  log.info("Carrier tracking update", {
    eventId: event.eventId,
    provider: event.provider,
    trackingCode: event.trackingCode,
    carrier: event.carrier,
    status: event.status,
    statusDetail: event.statusDetail,
    estDeliveryDate: event.estDeliveryDate,
    latestMessage: event.latestMessage,
  });
};

let started = false;

/**
 * Registers the default processor with the queue backend. Idempotent —
 * safe to call at service startup and from tests.
 */
export function startCarrierTrackingWorker(
  processor: CarrierEventProcessor = processCarrierEvent
): { stop(): void } {
  registerCarrierEventProcessor(processor);
  started = true;
  log.info("Carrier tracking worker registered", { queue: "carrier-tracking-events" });
  return {
    stop: () => {
      started = false;
    },
  };
}

export function isCarrierTrackingWorkerStarted(): boolean {
  return started;
}

/** Test helper: reset worker registration state. */
export function _resetCarrierWorkerForTesting(): void {
  started = false;
}
