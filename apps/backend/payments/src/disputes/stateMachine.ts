/**
 * Dispute state machine (Issue #46).
 *
 * Enforces the lifecycle:
 *
 *   open -> evidence_collection -> negotiation -> merchant_responded -> decided -> resolved
 *
 * Each state may also re-enter itself (e.g. more evidence submitted while
 * already in `evidence_collection`) via {@link isNoOpTransition}, and a
 * mediator may decide straight from `negotiation` (the merchant response is
 * optional), but no state may otherwise move backwards or skip ahead.
 */

import { InvalidStateTransitionError, type DisputeStatus } from "./types.js";

const ORDER: DisputeStatus[] = ["open", "evidence_collection", "negotiation", "merchant_responded", "decided", "resolved"];

const ALLOWED_TRANSITIONS: Record<DisputeStatus, DisputeStatus[]> = {
  open: ["open", "evidence_collection"],
  evidence_collection: ["evidence_collection", "negotiation"],
  negotiation: ["negotiation", "merchant_responded", "decided"],
  merchant_responded: ["merchant_responded", "decided"],
  decided: ["decided", "resolved"],
  resolved: ["resolved"],
};

export function isNoOpTransition(from: DisputeStatus, to: DisputeStatus): boolean {
  return from === to;
}

export function canTransition(from: DisputeStatus, to: DisputeStatus): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Throws {@link InvalidStateTransitionError} unless `from -> to` is a legal transition. */
export function assertTransition(from: DisputeStatus, to: DisputeStatus): void {
  if (!canTransition(from, to)) {
    throw new InvalidStateTransitionError(from, to);
  }
}

/** True once a dispute has reached a terminal state and can no longer change. */
export function isTerminal(status: DisputeStatus): boolean {
  return status === "resolved";
}

/** Ordinal position in the lifecycle, useful for "has this progressed past X" checks. */
export function stageIndex(status: DisputeStatus): number {
  return ORDER.indexOf(status);
}

export interface TransitionStep {
  from: DisputeStatus;
  to: DisputeStatus;
}

/**
 * Plans the sequence of single-hop transitions needed to move a dispute from
 * `from` forward to `to` (inclusive of intermediate stages it hasn't reached
 * yet). Used by actions like mediator assignment that may need to fast-track
 * a dispute through stages it skipped (e.g. straight from `open` into
 * `negotiation`) while still only ever traversing edges the state machine
 * considers legal.
 *
 * Returns an empty array if `from === to`. Throws {@link InvalidStateTransitionError}
 * if `to` is behind `from` in the lifecycle, or if any hop along the way
 * isn't a legal transition.
 */
export function planAdvance(from: DisputeStatus, to: DisputeStatus): TransitionStep[] {
  const fromIndex = stageIndex(from);
  const toIndex = stageIndex(to);
  if (toIndex < fromIndex) {
    throw new InvalidStateTransitionError(from, to);
  }

  const steps: TransitionStep[] = [];
  for (let i = fromIndex; i < toIndex; i++) {
    const step: TransitionStep = { from: ORDER[i], to: ORDER[i + 1] };
    assertTransition(step.from, step.to);
    steps.push(step);
  }
  return steps;
}
