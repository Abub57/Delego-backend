/** Delayed Soroban release after a verified delivery and its dispute grace period. */
import { Queue, Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import { createLogger } from "@delegolabs/utils";
import { escrowCoordinator } from "../escrowCoordinator/index.js";
import { getDisputeStore } from "../disputes/disputeStore.js";
import { executeAutoRelease } from "../autoRelease/service.js";
import type { DeliveryProof } from "../autoRelease/types.js";

const log = createLogger("payments:auto-release:worker", process.env.LOG_LEVEL ?? "info");
export const AUTO_RELEASE_TRIGGER_QUEUE = "escrow-auto-release-trigger";

/** The webhook signature accompanies proof that was verified before enqueueing. */
export interface SignedDeliveryProof {
  proof: DeliveryProof;
  signature: string;
  confirmedBy: string;
}

export interface AutoReleaseJobData {
  escrowId: string;
  orderId: string;
  signedProof: SignedDeliveryProof;
  /** Absolute Unix time in milliseconds. */
  graceExpiresAt: number;
}

let queue: Queue<AutoReleaseJobData> | undefined;
let worker: Worker<AutoReleaseJobData> | undefined;

function connection(): Redis {
  return new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
    maxRetriesPerRequest: null,
  });
}

/** Enqueue only after the delivery webhook has authenticated and validated the proof. */
export async function enqueueAutoRelease(job: AutoReleaseJobData): Promise<{ jobId: string; scheduledFor: string }> {
  if (!job.escrowId || !job.orderId || !job.signedProof?.signature || !job.signedProof.confirmedBy ||
      !Number.isSafeInteger(job.graceExpiresAt) || job.graceExpiresAt < 0) {
    throw new Error("Invalid verified auto-release job");
  }

  queue ??= new Queue<AutoReleaseJobData>(AUTO_RELEASE_TRIGGER_QUEUE, { connection: connection() });
  const delay = Math.max(0, job.graceExpiresAt - Date.now());
  const queued = await queue.add("release", job, {
    delay,
    jobId: `release-${job.escrowId}-${job.graceExpiresAt}`,
    attempts: 3,
    backoff: { type: "exponential", delay: 2_000 },
  });
  return { jobId: String(queued.id), scheduledFor: new Date(job.graceExpiresAt).toISOString() };
}

/** Returns without submitting a transaction if any dispute is active. */
export async function processAutoRelease(job: AutoReleaseJobData): Promise<void> {
  if (Date.now() < job.graceExpiresAt) {
    throw new Error(`Grace period has not expired for escrow ${job.escrowId}`);
  }

  const disputes = await getDisputeStore().findByEscrowId(job.escrowId);
  if (disputes.some((dispute) => dispute.status !== "resolved")) {
    log.info("Auto-release cancelled due to dispute", { escrowId: job.escrowId });
    return;
  }

  const status = await escrowCoordinator.getEscrowStatus(job.escrowId);
  if (status.status === "disputed") {
    log.info("Auto-release cancelled due to on-chain dispute", { escrowId: job.escrowId });
    return;
  }
  if (status.status !== "funded") {
    log.info("Auto-release skipped for non-funded escrow", { escrowId: job.escrowId, status: status.status });
    return;
  }

  const result = await executeAutoRelease({
    escrowId: job.escrowId,
    orderId: job.orderId,
    confirmedBy: job.signedProof.confirmedBy,
  });
  if (!result.success) {
    throw new Error(result.error ?? `Auto-release failed for escrow ${job.escrowId}`);
  }
}

/** Start the BullMQ consumer once when the payments service starts. */
export function startAutoReleaseWorker(): void {
  if (worker) return;
  worker = new Worker<AutoReleaseJobData>(
    AUTO_RELEASE_TRIGGER_QUEUE,
    async (job: Job<AutoReleaseJobData>) => processAutoRelease(job.data),
    { connection: connection() }
  );
  worker.on("failed", (job, error) => {
    log.error("Auto-release job failed", { jobId: job?.id, error: error.message });
  });
  worker.on("error", (error) => {
    log.error("Auto-release worker connection failed", { error: error.message });
  });
}

export async function stopAutoReleaseWorker(): Promise<void> {
  await Promise.all([worker?.close(), queue?.close()]);
  worker = undefined;
  queue = undefined;
}
