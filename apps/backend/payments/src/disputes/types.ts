/**
 * Partial Refunds & Dispute Mediation (Issue #46)
 *
 * Domain model for the dispute-mediation state machine, evidence submission,
 * and mediator decisions, plus the partial-refund request contract.
 */

export interface PartialRefundRequest {
  escrowId: string;
  /** Amount to refund to the buyer, in stroops. */
  amount: string;
  reason: string;
  /** Stellar address of the buyer or seller requesting the refund. */
  requestedBy: string;
  /** IPFS hashes or URLs backing the refund request. */
  evidence?: string[];
}

export type DisputeStatus = "open" | "evidence_collection" | "negotiation" | "merchant_responded" | "decided" | "resolved";

/** Arbitration tier a dispute is assigned to; stalled disputes move tier1 → senior. */
export type DisputeTier = "tier1" | "senior";

export type ResolutionType = "full_refund" | "partial_refund" | "release_to_seller" | "split";

export interface DisputeEvidenceEntry {
  party: string;
  description: string;
  files: string[];
  submittedAt: string;
}

/** Evidence submission input — `submittedAt` is stamped by the service. */
export type DisputeEvidenceInput = Omit<DisputeEvidenceEntry, "submittedAt">;

export interface DisputeResolution {
  type: ResolutionType;
  buyerAmount: string;
  sellerAmount: string;
  decidedBy: string;
  decidedAt: string;
}

export interface Dispute {
  id: string;
  escrowId: string;
  initiatedBy: string;
  reason: string;
  evidence: DisputeEvidenceEntry[];
  mediator?: string;
  status: DisputeStatus;
  createdAt: string;
  updatedAt: string;
  slaDeadline: string;
  /** Current arbitration tier; unset is treated as `tier1`. */
  escalationTier?: DisputeTier;
  /** When the dispute was escalated to its current tier. */
  escalationEscalatedAt?: string;
  resolution?: DisputeResolution;
}

export interface MediationDecision {
  disputeId: string;
  decision: ResolutionType;
  buyerAmount: string;
  sellerAmount: string;
  reasoning: string;
  mediator: string;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class DisputeNotFoundError extends Error {
  constructor(public readonly disputeId: string) {
    super(`Dispute ${disputeId} not found`);
    this.name = "DisputeNotFoundError";
  }
}

export class DisputeAlreadyResolvedError extends Error {
  constructor(public readonly disputeId: string) {
    super(`Dispute ${disputeId} is already resolved`);
    this.name = "DisputeAlreadyResolvedError";
  }
}

export class InvalidStateTransitionError extends Error {
  constructor(
    public readonly from: DisputeStatus,
    public readonly to: DisputeStatus
  ) {
    super(`Cannot transition dispute from "${from}" to "${to}"`);
    this.name = "InvalidStateTransitionError";
  }
}

export class InvalidResolutionAmountsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidResolutionAmountsError";
  }
}

export { InsufficientEscrowBalanceError } from "../escrowCoordinator/index.js";
