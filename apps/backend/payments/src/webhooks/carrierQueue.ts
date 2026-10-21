/**
 * Carrier tracking event queue (Issue #291).
 *
 * Production backend is BullMQ over Redis. In test / CI (`NODE_ENV=test`,
 * `MOCK_REDIS=true`, or `CI=true`) it falls back to an in-memory list so
 * route tests stay fast, deterministic, and Redis-free — mirroring
 * `autoRelease/releaseQueue.ts`.
 */

import { createRequire } from "node:module";
import { createLogger } from "@delegolabs/utils";
import type { NormalizedCarrierEvent } from "./carrierWebhook.js";

const log = createLogger("payments:webhooks:carrier-queue", process.env.LOG_LEVEL ?? "info");

export const CARRIER_TRACKING_QUEUE_NAME = "carrier-tracking-events";

export interface CarrierEnqueueResult {
  jobId: string;
  backend: "bullmq" | "in-memory";
}

export type CarrierEventProcessor = (event: NormalizedCarrierEvent) => Promise<void>;

function isMockMode(): boolean {
  return (
    process.env.NODE_ENV === "test" ||
    process.env.MOCK_REDIS === "true" ||
    process.env.CI === "true"
  );
}

// ---------------------------------------------------------------------------
// In-memory backend (test / CI)
// ---------------------------------------------------------------------------

const pendingEvents: NormalizedCarrierEvent[] = [];
let globalProcessor: CarrierEventProcessor | null = null;

export function registerCarrierEventProcessor(processor: CarrierEventProcessor): void {
  globalProcessor = processor;
}

/** Test helper: events currently waiting to be processed. */
export function pendingCarrierEventCount(): number {
  return pendingEvents.length;
}

/** Test helper: drain and return pending events. */
export function drainPendingCarrierEvents(): NormalizedCarrierEvent[] {
  return pendingEvents.splice(0, pendingEvents.length);
}

/** Test helper: run pending events through the registered processor. */
export async function runPendingCarrierEvents(): Promise<number> {
  const events = drainPendingCarrierEvents();
  for (const event of events) {
    if (globalProcessor) await globalProcessor(event);
  }
  return events.length;
}

/** Test helper: reset in-memory state between test cases. */
export function resetCarrierQueue(): void {
  pendingEvents.length = 0;
  globalProcessor = null;
  bullQueue = null;
}

// ---------------------------------------------------------------------------
// BullMQ backend (production)
// ---------------------------------------------------------------------------

type BullQueue = {
  add(name: string, data: unknown, opts: { jobId?: string; removeOnComplete?: boolean }): Promise<{ id?: string }>;
};
type BullWorkerCtor = new (
  name: string,
  processor: (job: { id?: string; data: NormalizedCarrierEvent }) => Promise<void>,
  opts: { connection: unknown }
) => unknown;

let bullQueue: BullQueue | null = null;

function getRedisConnection(): unknown {
  const _require = createRequire(import.meta.url);
  const { Redis } = _require("ioredis") as any;
  return new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
    maxRetriesPerRequest: null,
  });
}

function getBullQueue(): BullQueue {
  if (bullQueue) return bullQueue;
  const _require = createRequire(import.meta.url);
  const { Queue, Worker } = _require("bullmq") as { Queue: any; Worker: BullWorkerCtor };
  const connection = getRedisConnection();
  const queue = new Queue(CARRIER_TRACKING_QUEUE_NAME, { connection }) as BullQueue;
  bullQueue = queue;

  // Long-lived worker in the same process (separate worker processes can
  // attach their own consumer to the same queue name).
  // eslint-disable-next-line no-new
  new Worker(
    CARRIER_TRACKING_QUEUE_NAME,
    async (job: { id?: string; data: NormalizedCarrierEvent }) => {
      if (!globalProcessor) {
        log.debug("No carrier event processor registered; skipping", { jobId: job.id });
        return;
      }
      log.info("Processing carrier tracking event", {
        jobId: job.id,
        eventId: job.data.eventId,
        trackingCode: job.data.trackingCode,
      });
      await globalProcessor(job.data);
    },
    { connection }
  );

  return queue;
}

// ---------------------------------------------------------------------------
// Public API — enqueue only (route awaits this, never the processor).
// ---------------------------------------------------------------------------

/**
 * Enqueue a normalized carrier event for asynchronous processing.
 * Uses the event ID as the BullMQ job ID so redelivered webhooks dedupe.
 */
export async function enqueueCarrierEvent(event: NormalizedCarrierEvent): Promise<CarrierEnqueueResult> {
  if (isMockMode()) {
    // Dedupe redeliveries in-memory the same way BullMQ jobId dedupes.
    if (!pendingEvents.some((e) => e.eventId === event.eventId)) {
      pendingEvents.push(event);
    }
    log.debug("Enqueued carrier event (in-memory backend)", {
      eventId: event.eventId,
      trackingCode: event.trackingCode,
    });
    return { jobId: event.eventId, backend: "in-memory" };
  }

  const queue = getBullQueue();
  const job = await queue.add("carrier-tracking", event, {
    jobId: event.eventId,
    removeOnComplete: true,
  });
  log.info("Enqueued carrier event (BullMQ backend)", {
    jobId: job.id,
    eventId: event.eventId,
    trackingCode: event.trackingCode,
  });
  return { jobId: String(job.id ?? event.eventId), backend: "bullmq" };
}
