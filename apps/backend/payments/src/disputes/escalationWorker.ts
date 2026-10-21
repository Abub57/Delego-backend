/**
 * Automated dispute escalation worker (#403).
 *
 * Disputes that remain unresolved past the stall window (72 hours by default)
 * are escalated from the `tier1` queue to a `senior` human arbitrator: the
 * tier is persisted, an audit event is recorded, and the parties / senior
 * arbitrators are notified. Runs every hour by default.
 *
 * Idempotent: once a dispute is at the `senior` tier it is excluded from
 * future scans, so a repeated tick never re-escalates it.
 */

import { createLogger } from "@delegolabs/utils";
import { escrowCoordinator } from "../escrowCoordinator/index.js";
import { recordAuditEvent } from "./auditLog.js";
import { getDisputeStore } from "./disputeStore.js";
import { notifyDisputeParties } from "./notifications.js";
import type { Dispute, DisputeTier } from "./types.js";

const log = createLogger("payments:disputes:escalation", process.env.LOG_LEVEL ?? "info");

/** Default hours a dispute may stay unresolved before escalation to `senior`. */
export const DEFAULT_STALLED_HOURS = 72;

/** Escalation decision for a single stalled dispute. */
export interface DisputeEscalationRule {
  disputeId: string;
  stalledHours: number;
  assignedTier: DisputeTier;
}

export interface DisputeEscalationResult {
  scanned: number;
  escalated: DisputeEscalationRule[];
}

/**
 * Finds disputes stalled longer than `stalledHours` and escalates each to the
 * `senior` tier, recording and notifying the change. Failures on one dispute
 * are logged and skipped so the rest of the batch still runs.
 */
export async function findAndEscalateStalledDisputes(
  now: Date = new Date(),
  stalledHours: number = DEFAULT_STALLED_HOURS
): Promise<DisputeEscalationResult> {
  const store = getDisputeStore();
  const stalled = await store.findStalled(now, stalledHours);

  const escalated: DisputeEscalationRule[] = [];
  for (const dispute of stalled) {
    const rule: DisputeEscalationRule = {
      disputeId: dispute.id,
      stalledHours,
      assignedTier: "senior",
    };

    try {
      const escalatedAt = now.toISOString();
      const updated = await store.update(dispute.id, {
        escalationTier: rule.assignedTier,
        escalationEscalatedAt: escalatedAt,
      });

      await recordAuditEvent({
        disputeId: dispute.id,
        escrowId: dispute.escrowId,
        eventType: "dispute_escalated",
        details: {
          stalledHours,
          assignedTier: rule.assignedTier,
          previousTier: dispute.escalationTier ?? "tier1",
          escalatedAt,
        },
      });

      await notifySeniorArbitrators(updated, rule);

      log.warn("Dispute stalled; escalated to senior arbitrator", {
        disputeId: dispute.id,
        escrowId: dispute.escrowId,
        stalledHours,
        assignedTier: rule.assignedTier,
      });
      escalated.push(rule);
    } catch (err) {
      log.error("Failed to escalate stalled dispute", {
        disputeId: dispute.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { scanned: stalled.length, escalated };
}

async function notifySeniorArbitrators(
  dispute: Dispute,
  rule: DisputeEscalationRule
): Promise<void> {
  const orderId = await safeGetOrderId(dispute.escrowId);
  if (!orderId) return;
  await notifyDisputeParties("dispute_escalated", orderId, dispute, {
    assignedTier: rule.assignedTier,
    stalledHours: rule.stalledHours,
  });
}

async function safeGetOrderId(escrowId: string): Promise<string | null> {
  try {
    const balance = await escrowCoordinator.getRemainingBalance(escrowId);
    return balance.orderId;
  } catch {
    return null;
  }
}

export interface DisputeEscalationWorkerOptions {
  /** Scan interval in ms; defaults to `DISPUTE_ESCALATION_INTERVAL_SECONDS` or 1 hour. */
  intervalMs?: number;
  /** Stall window in hours; defaults to `DISPUTE_STALLED_HOURS` or 72. */
  stalledHours?: number;
  onCycleComplete?: (result: DisputeEscalationResult) => void;
  onError?: (error: Error) => void;
}

/**
 * Starts the periodic stalled-dispute escalation worker. Mirrors the SLA
 * escalation scheduler shape — returns a stop function for graceful shutdown.
 */
export function startDisputeEscalationWorker(
  options: DisputeEscalationWorkerOptions = {}
): () => void {
  const intervalMs =
    options.intervalMs ??
    Number(process.env.DISPUTE_ESCALATION_INTERVAL_SECONDS ?? 3600) * 1000;
  const stalledHours =
    options.stalledHours ?? Number(process.env.DISPUTE_STALLED_HOURS ?? DEFAULT_STALLED_HOURS);

  const runCycle = () => {
    findAndEscalateStalledDisputes(new Date(), stalledHours)
      .then((result) => options.onCycleComplete?.(result))
      .catch((err) => {
        const error = err instanceof Error ? err : new Error(String(err));
        log.error("Unhandled error in dispute escalation worker cycle", {
          error: error.message,
        });
        options.onError?.(error);
      });
  };

  const intervalId = setInterval(runCycle, intervalMs);
  log.info("Dispute escalation worker started", { intervalMs, stalledHours });

  return () => {
    clearInterval(intervalId);
    log.info("Dispute escalation worker stopped");
  };
}
