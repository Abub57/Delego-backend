/** Escrow coordinator service contracts */

export interface FundEscrowParams {
  orderId: string;
  buyerAddress: string;
  sellerAddress: string;
  tokenContractId: string;
  amountStroops: string;
  escrowContractId: string;
  timeoutLedgers: number;
}

export interface FundEscrowResult {
  escrowId: string;
  txHash: string;
  ledger: number;
  status: "funded" | "failed";
}

export interface ReleaseEscrowParams {
  escrowId: string;
  escrowContractId: string;
  callerAddress: string;
}

export interface ReleaseResult {
  txHash: string;
  ledger: number;
  status: "released" | "failed";
  sellerAddress: string;
  amount: string;
}

export interface RefundEscrowParams {
  escrowId: string;
  escrowContractId: string;
  callerAddress: string;
  reason: "cancellation" | "dispute_resolution" | "timeout";
}

export interface RefundResult {
  txHash: string;
  ledger: number;
  status: "refunded" | "failed";
  buyerAddress: string;
  amount: string;
}

export interface DisputeEscrowParams {
  escrowId: string;
  escrowContractId: string;
  callerAddress: string;
}

export interface DisputeResult {
  txHash: string;
  ledger: number;
  status: "disputed" | "failed";
  disputedBy: string;
}

// ---------------------------------------------------------------------------
// Issue #46 — Partial refunds & dispute mediation
// ---------------------------------------------------------------------------

export interface PartialRefundEscrowParams {
  escrowId: string;
  escrowContractId: string;
  callerAddress: string;
  /** Amount to refund to the buyer, in stroops. Must not exceed the remaining escrow balance. */
  amountStroops: string;
  reason: string;
}

export interface PartialRefundResult {
  txHash: string;
  ledger: number;
  status: "partial_refunded" | "failed";
  buyerAddress: string;
  refundedAmount: string;
  remainingAmount: string;
}

export interface PartialReleaseEscrowParams {
  escrowId: string;
  escrowContractId: string;
  callerAddress: string;
  /** Amount to release to the seller, in stroops. Must not exceed the remaining escrow balance. */
  amountStroops: string;
  memo?: string;
}

export interface PartialReleaseResult {
  txHash: string;
  ledger: number;
  status: "partial_released" | "failed";
  sellerAddress: string;
  releasedAmount: string;
  remainingAmount: string;
}

export interface EscrowStatusResult {
  escrowId: string;
  buyer: string;
  seller: string;
  amount: string;
  status: "funded" | "released" | "refunded" | "disputed";
  createdAt: number;
}

export interface EscrowCoordinator {
  fundEscrow(params: FundEscrowParams): Promise<FundEscrowResult>;
  releaseEscrow(params: ReleaseEscrowParams): Promise<ReleaseResult>;
  refundEscrow(params: RefundEscrowParams): Promise<RefundResult>;
  disputeEscrow(params: DisputeEscrowParams): Promise<DisputeResult>;
  partialRefundEscrow(params: PartialRefundEscrowParams): Promise<PartialRefundResult>;
  partialReleaseEscrow(params: PartialReleaseEscrowParams): Promise<PartialReleaseResult>;
  getRemainingBalance(escrowId: string): Promise<RemainingBalance>;
  getEscrowStatus(escrowId: string): Promise<EscrowStatusResult>;
}

export interface RemainingBalance {
  escrowId: string;
  orderId: string;
  buyerAddress: string;
  sellerAddress: string;
  totalAmount: string;
  releasedAmount: string;
  refundedAmount: string;
  remainingAmount: string;
}

/** Raised when a partial refund/release requests more than the escrow has left. */
export class InsufficientEscrowBalanceError extends Error {
  constructor(
    public readonly escrowId: string,
    public readonly remainingAmount: string,
    public readonly requestedAmount: string
  ) {
    super(
      `Escrow ${escrowId} has ${remainingAmount} stroops remaining; requested ${requestedAmount} exceeds the available balance`
    );
    this.name = "InsufficientEscrowBalanceError";
  }
}

export type PaymentRecordStatus =
  | "pending"
  | "funded"
  | "released"
  | "refunded"
  | "disputed"
  | "failed";

export interface PaymentRecord {
  id: string;
  orderId: string;
  escrowId: string | null;
  escrowContractId: string;
  buyerAddress: string;
  sellerAddress: string;
  tokenContractId: string;
  amountStroops: string;
  status: PaymentRecordStatus;
  fundTxHash: string | null;
  releaseTxHash: string | null;
  refundTxHash: string | null;
  disputeTxHash: string | null;
  /** Cumulative amount released to the seller so far (full + partial releases), in stroops. */
  releasedAmountStroops: string;
  /** Cumulative amount refunded to the buyer so far (full + partial refunds), in stroops. */
  refundedAmountStroops: string;
  failureReason: string | null;
  // ── Tax breakdown (migration 046) ────────────────────────────────────────
  /** Pre-tax item total in stroops. Equals amountStroops for pre-046 records. */
  subtotalStroops: string;
  /** VAT / sales tax charged in stroops. "0" for pre-046 records. */
  taxAmountStroops: string;
  /**
   * Applied tax rate in basis points (100 bp = 1 %).
   * 0 for pre-046 records (no tax was recorded).
   */
  taxRateBasisPoints: number;
  /**
   * ISO 3166-2 subdivision code or free-form jurisdiction label (e.g. "US-CA").
   * null for pre-046 records.
   */
  taxJurisdiction: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreatePaymentRecordInput {
  orderId: string;
  escrowContractId: string;
  buyerAddress: string;
  sellerAddress: string;
  tokenContractId: string;
  amountStroops: string;
  // ── Tax breakdown (migration 046, optional on creation) ──────────────────
  /**
   * Pre-tax item subtotal in stroops. When omitted, `amountStroops` is used
   * as the subtotal (backwards-compatible with pre-046 callers).
   */
  subtotalStroops?: string;
  /** VAT / sales tax in stroops. Defaults to "0". */
  taxAmountStroops?: string;
  /** Tax rate in basis points. Defaults to 0. */
  taxRateBasisPoints?: number;
  /** Jurisdiction label (e.g. "US-CA"). Defaults to null. */
  taxJurisdiction?: string | null;
}

// Issue #147 — Escrow funding lock optimization types

export interface FundEscrowWithLockParams extends FundEscrowParams {
  lockConfig?: {
    lockType?: "pessimistic" | "optimistic" | "adaptive";
    stripingFactor?: number;
    lockTimeoutMs?: number;
  };
}

export interface LockMetricsSummary {
  escrowId: string;
  lockType: string;
  acquisitions: number;
  waits: number;
  avgWaitMs: number;
  maxWaitMs: number;
  contentions: number;
  timeouts: number;
  stolenLocks: number;
}

export interface LockOptimizationReport {
  globalContentionRatio: number;
  totalEscrowsTracked: number;
  recommendations: Array<{
    escrowId: string;
    currentLockType: string;
    recommendedLockType: string;
    reason: string;
  }>;
}
