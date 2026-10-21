/**
 * Escrow Auto-Release on Delivery Confirmation — core service (Issue #45).
 *
 * Orchestrates the full lifecycle triggered by a delivery-confirmation
 * webhook:
 *
 *   1. Pre-condition checks (escrow must be "funded"; disputed escrows are
 *      blocked and require {@link adminOverrideRelease}).
 *   2. Immediate or delayed execution, per the escrow's {@link AutoReleaseConfig}.
 *   3. Pro-rata partial-release accounting when `partialReleaseEnabled`.
 *   4. On-chain release via the Soroban escrow contract, retried with
 *      exponential backoff on failure.
 *   5. Domain events (`release_initiated` / `release_completed` /
 *      `release_failed`) at each stage.
 *
 * Note on partial releases: the on-chain `release` method transfers the
 * escrow's full balance in one call — it has no notion of a partial amount.
 * Interim confirmations (before `requiredConfirmations` is reached) are
 * therefore accounted for pro-rata *off-chain* (no `transactionHash`); only
 * the final confirmation submits the actual on-chain release.
 */

import { createLogger } from "@delegolabs/utils";
import { escrowCoordinator } from "../escrowCoordinator/index.js";
import { getDisputeStore } from "../disputes/disputeStore.js";
import { enqueueAutoRelease } from "../workers/autoRelease.js";
import { getAutoReleaseCallerAddress, getEscrowContractId } from "../../escrow/config.js";
import { getAutoReleaseConfig } from "./configStore.js";
import { recordDeliveryConfirmation } from "./confirmationTracker.js";
import { emitAutoReleaseEvent } from "./events.js";
import { registerReleaseExecutor, scheduleRelease, type ScheduledReleaseJob } from "./releaseQueue.js";
import { retryWithBackoff, type RetryOptions } from "./retry.js";
import {
  EscrowDisputedError,
  EscrowNotReleasableError,
  type AutoReleaseConfig,
  type DeliveryConfirmation,
  type ReleaseResult,
} from "./types.js";

const log = createLogger("payments:auto-release", process.env.LOG_LEVEL ?? "info");

export interface ScheduledReleaseAck {
  escrowId: string;
  orderId: string;
  scheduled: true;
  jobId: string;
  scheduledFor: string;
}

export type AutoReleaseOutcome = ReleaseResult | ScheduledReleaseAck;

function failureResult(escrowId: string, remainingAmount: string, error: string, retryCount = 0): ReleaseResult {
  return {
    escrowId,
    success: false,
    releasedAmount: "0",
    remainingAmount,
    error,
    retryCount,
  };
}

/**
 * Verifies an escrow is eligible for auto-release.
 * Throws {@link EscrowDisputedError} or {@link EscrowNotReleasableError}
 * (never returns a value) so callers can map each to the right HTTP status.
 */
async function assertReleasable(escrowId: string): Promise<{ status: string; amount: string }> {
  const status = await escrowCoordinator.getEscrowStatus(escrowId);

  if (status.status === "disputed") {
    throw new EscrowDisputedError(escrowId);
  }
  if (status.status !== "funded") {
    throw new EscrowNotReleasableError(escrowId, status.status);
  }

  return { status: status.status, amount: status.amount };
}

/**
 * Computes this confirmation's pro-rata share of the escrow amount.
 *
 * When partial release is disabled (or only a single confirmation is
 * required), the full amount is released on the first confirmation.
 */
function computeProRata(
  totalAmount: bigint,
  confirmationCount: number,
  config: AutoReleaseConfig
): { releasedAmount: bigint; remainingAmount: bigint; isFinal: boolean } {
  if (!config.partialReleaseEnabled || config.requiredConfirmations <= 1) {
    return { releasedAmount: totalAmount, remainingAmount: 0n, isFinal: true };
  }

  const required = BigInt(config.requiredConfirmations);
  const perConfirmation = totalAmount / required;
  const isFinal = confirmationCount >= config.requiredConfirmations;

  if (isFinal) {
    // Final confirmation releases whatever remains, absorbing rounding
    // remainder from integer division of prior installments.
    const releasedSoFar = perConfirmation * BigInt(config.requiredConfirmations - 1);
    return { releasedAmount: totalAmount - releasedSoFar, remainingAmount: 0n, isFinal: true };
  }

  const releasedSoFar = perConfirmation * BigInt(confirmationCount);
  return {
    releasedAmount: perConfirmation,
    remainingAmount: totalAmount - releasedSoFar,
    isFinal: false,
  };
}

export interface ExecuteAutoReleaseParams {
  escrowId: string;
  orderId: string;
  confirmedBy: string;
  retryOptions?: RetryOptions;
}

/**
 * Executes (or accrues) a release for one delivery confirmation. Safe to
 * call directly for immediate releases, or as the callback for a delayed
 * job scheduled by {@link handleDeliveryConfirmation}.
 */
export async function executeAutoRelease(params: ExecuteAutoReleaseParams): Promise<ReleaseResult> {
  const { escrowId, orderId, confirmedBy } = params;

  await emitAutoReleaseEvent("release_initiated", orderId, { escrowId, orderId, confirmedBy });

  let statusCheck: { status: string; amount: string };
  try {
    statusCheck = await assertReleasable(escrowId);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Escrow is not releasable";
    const result = failureResult(escrowId, "0", message);
    await emitAutoReleaseEvent("release_failed", orderId, { escrowId, orderId, confirmedBy, reason: message });
    return result;
  }

  const config = await getAutoReleaseConfig(escrowId);
  const confirmationCount = await recordDeliveryConfirmation(escrowId);
  const totalAmount = BigInt(statusCheck.amount);
  const { releasedAmount, remainingAmount, isFinal } = computeProRata(totalAmount, confirmationCount, config);

  if (!isFinal) {
    const result: ReleaseResult = {
      escrowId,
      success: true,
      releasedAmount: releasedAmount.toString(),
      remainingAmount: remainingAmount.toString(),
      retryCount: 0,
    };
    log.info("Partial delivery confirmation accrued; awaiting further confirmations", {
      escrowId,
      orderId,
      confirmationCount,
      requiredConfirmations: config.requiredConfirmations,
    });
    await emitAutoReleaseEvent("release_completed", orderId, {
      escrowId,
      orderId,
      confirmedBy,
      releasedAmount: result.releasedAmount,
      remainingAmount: result.remainingAmount,
    });
    return result;
  }

  // The mediation record is authoritative even when its on-chain dispute
  // flag failed. Check immediately before the transaction as well as in the
  // delayed worker, so a dispute opened while the job was running still wins.
  const activeDisputes = await getDisputeStore().findByEscrowId(escrowId);
  if (activeDisputes.some((dispute) => dispute.status !== "resolved")) {
    const result = failureResult(escrowId, statusCheck.amount, `Escrow ${escrowId} is disputed`);
    await emitAutoReleaseEvent("release_failed", orderId, {
      escrowId, orderId, confirmedBy, reason: result.error,
    });
    return result;
  }

  const contractId = getEscrowContractId();
  const callerAddress = getAutoReleaseCallerAddress();

  const retryResult = await retryWithBackoff(
    () =>
      escrowCoordinator.releaseEscrow({
        escrowId,
        escrowContractId: contractId,
        callerAddress,
      }),
    params.retryOptions
  );

  if (!retryResult.success || retryResult.value?.status !== "released") {
    const message =
      retryResult.error instanceof Error
        ? retryResult.error.message
        : retryResult.value?.status === "failed"
          ? "Soroban release transaction failed after retries"
          : "Unknown auto-release error";
    const result = failureResult(escrowId, remainingAmount.toString(), message, retryResult.retryCount);
    await emitAutoReleaseEvent("release_failed", orderId, {
      escrowId,
      orderId,
      confirmedBy,
      reason: message,
      retryCount: retryResult.retryCount,
    });
    return result;
  }

  const result: ReleaseResult = {
    escrowId,
    success: true,
    transactionHash: retryResult.value.txHash,
    releasedAmount: releasedAmount.toString(),
    remainingAmount: remainingAmount.toString(),
    retryCount: retryResult.retryCount,
  };
  await emitAutoReleaseEvent("release_completed", orderId, {
    escrowId,
    orderId,
    confirmedBy,
    transactionHash: result.transactionHash,
    releasedAmount: result.releasedAmount,
    remainingAmount: result.remainingAmount,
    retryCount: result.retryCount,
  });
  return result;
}

// Delayed jobs (BullMQ) run in a worker that may not share this process's
// call stack, so the executor is registered once at module load.
registerReleaseExecutor((job: ScheduledReleaseJob) =>
  executeAutoRelease({ escrowId: job.escrowId, orderId: job.orderId, confirmedBy: job.confirmedBy }).then(
    () => undefined
  )
);

/**
 * Handles a validated {@link DeliveryConfirmation}. Performs pre-condition
 * checks synchronously (so bad requests fail fast, before anything is
 * scheduled) and then either executes the release immediately or schedules
 * it per the escrow's `delayMinutes` configuration.
 *
 * Throws {@link EscrowDisputedError} / {@link EscrowNotReleasableError} for
 * pre-condition failures — callers (e.g. the webhook route) should map these
 * to 403/400 responses respectively.
 */
export async function handleDeliveryConfirmation(
  confirmation: DeliveryConfirmation,
  verifiedSignature?: string
): Promise<AutoReleaseOutcome> {
  const { escrowId, orderId, confirmedBy } = confirmation;

  const config = await getAutoReleaseConfig(escrowId);
  if (!config.enabled) {
    return failureResult(escrowId, "0", `Auto-release is disabled for escrow ${escrowId}`);
  }

  // Fail fast on bad escrow state before scheduling any work.
  try {
    await assertReleasable(escrowId);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Escrow is not releasable";
    await emitAutoReleaseEvent("release_failed", orderId, { escrowId, orderId, confirmedBy, reason: message });
    throw err;
  }

  if (config.delayMinutes > 0) {
    if (verifiedSignature) {
      const scheduled = await enqueueAutoRelease({
        escrowId,
        orderId,
        signedProof: {
          proof: confirmation.deliveryProof,
          signature: verifiedSignature,
          confirmedBy,
        },
        graceExpiresAt: Date.now() + config.delayMinutes * 60_000,
      });
      return { escrowId, orderId, scheduled: true, ...scheduled };
    }
    const job: ScheduledReleaseJob = {
      escrowId,
      orderId,
      confirmedBy,
      timestamp: confirmation.timestamp,
    };
    const scheduled = await scheduleRelease(job, config.delayMinutes, (j) =>
      executeAutoRelease({ escrowId: j.escrowId, orderId: j.orderId, confirmedBy: j.confirmedBy }).then(
        () => undefined
      )
    );
    log.info("Auto-release scheduled with delay", {
      escrowId,
      orderId,
      delayMinutes: config.delayMinutes,
      jobId: scheduled.jobId,
    });
    return { escrowId, orderId, scheduled: true, jobId: scheduled.jobId, scheduledFor: scheduled.scheduledFor };
  }

  return executeAutoRelease({ escrowId, orderId, confirmedBy });
}

// ---------------------------------------------------------------------------
// Manual override (Issue #45 — dispute bypass)
// ---------------------------------------------------------------------------

export interface AdminOverrideReleaseParams {
  escrowId: string;
  orderId: string;
  adminId: string;
  reason: string;
  retryOptions?: RetryOptions;
}

/**
 * Manually releases a disputed (or otherwise blocked) escrow, bypassing the
 * automated pre-condition checks. Intended for admin/arbiter tooling once a
 * dispute has been resolved out-of-band — callers are responsible for
 * authorizing the caller as an admin before invoking this.
 */
export async function adminOverrideRelease(params: AdminOverrideReleaseParams): Promise<ReleaseResult> {
  const { escrowId, orderId, adminId, reason } = params;

  log.warn("Admin override release requested", { escrowId, orderId, adminId, reason });

  await emitAutoReleaseEvent("release_initiated", orderId, {
    escrowId,
    orderId,
    confirmedBy: adminId,
    reason: `admin_override: ${reason}`,
  });

  const status = await escrowCoordinator.getEscrowStatus(escrowId);
  const totalAmount = BigInt(status.amount);
  const contractId = getEscrowContractId();
  const callerAddress = getAutoReleaseCallerAddress();

  const retryResult = await retryWithBackoff(
    () =>
      escrowCoordinator.releaseEscrow({
        escrowId,
        escrowContractId: contractId,
        callerAddress,
      }),
    params.retryOptions
  );

  if (!retryResult.success || retryResult.value?.status !== "released") {
    const message =
      retryResult.error instanceof Error
        ? retryResult.error.message
        : "Admin override release failed after retries";
    const result = failureResult(escrowId, totalAmount.toString(), message, retryResult.retryCount);
    await emitAutoReleaseEvent("release_failed", orderId, {
      escrowId,
      orderId,
      confirmedBy: adminId,
      reason: `admin_override: ${message}`,
      retryCount: retryResult.retryCount,
    });
    return result;
  }

  const result: ReleaseResult = {
    escrowId,
    success: true,
    transactionHash: retryResult.value.txHash,
    releasedAmount: totalAmount.toString(),
    remainingAmount: "0",
    retryCount: retryResult.retryCount,
  };
  await emitAutoReleaseEvent("release_completed", orderId, {
    escrowId,
    orderId,
    confirmedBy: adminId,
    transactionHash: result.transactionHash,
    releasedAmount: result.releasedAmount,
    remainingAmount: result.remainingAmount,
    retryCount: result.retryCount,
    reason: `admin_override: ${reason}`,
  });
  return result;
}
