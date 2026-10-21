/** Escrow lifecycle — matches Soroban EscrowStatus enum and frontend extensions */

export type EscrowStatus =
  | "funded"
  | "released"
  | "disputed"
  | "refunded"
  | "Funded"
  | "Released"
  | "Disputed"
  | "Refunded"
  | "cancelling"
  | "cancelled";

/**
 * Server-issued cancellation grace state for an escrow (#580).
 */
export interface CancellationGrace {
  /** ISO-8601 timestamp of the cancel request. */
  requestedAt: string;
  gracePeriodSeconds: number;
  /** ISO-8601 timestamp — the server-authoritative moment the grace period lapses. */
  graceExpiresAt: string;
  /** ISO-8601 timestamp of "now" as seen by the server when it issued this state. */
  serverTimestamp: string;
  cancelledBy?: string;
}

export interface Escrow {
  /**
   * Optional id for backward compatibility
   */
  id?: string;
  /** Numeric escrow identifier assigned by the contract */
  escrowId: string;
  /** Order identifier the escrow is linked to */
  orderId: string;
  buyerId?: string;
  /** Stellar address of the buyer */
  buyer: string;
  sellerId?: string;
  /** Stellar address of the seller / merchant */
  seller: string;
  /** Token contract address used for the deposit */
  token?: string;
  /** Amount locked in stroops */
  amount: any;
  /** On-chain escrow status */
  status: EscrowStatus;
  /** Absolute ledger number when the buyer may request a refund */
  timeoutLedger?: number;
  /** Current ledger number (provided by backend for countdown calculation) */
  currentLedger?: number;
  /** ISO-8601 timestamp of the deadline as originally set on the contract (#577). */
  originalDeadline?: string;
  /** ISO-8601 timestamp of the current effective deadline, after any extensions. */
  deadline?: string;
  /** Count of extension requests already granted against this escrow. */
  extensionsConsumed?: number;
  /** Contract-enforced cap on the number of extensions allowed. */
  maxExtensions?: number;
  /** Contract-enforced cap on total extension time, in seconds. */
  maxExtensionSeconds?: number;
  /** Present while a cancellation is pending or within its undo window (#580). */
  cancellation?: CancellationGrace | null;
  /** ISO-8601 timestamp or Date when the escrow was created */
  createdAt: Date | string;
  arbiter?: string;
}

export interface EscrowStatusMeta {
  label: string;
  tone: "success" | "pending" | "failed" | "refunded";
  color: string;
  bg: string;
}

/** Labels, tone and colour keys for EscrowStatus badges */
export const ESCROW_STATUS_META: Record<EscrowStatus, EscrowStatusMeta> = {
  funded: {
    label: "Funded",
    tone: "pending",
    color: "#065f46",
    bg: "#d1fae5",
  },
  released: {
    label: "Released",
    tone: "success",
    color: "#1e40af",
    bg: "#dbeafe",
  },
  disputed: {
    label: "Disputed",
    tone: "failed",
    color: "#991b1b",
    bg: "#fee2e2",
  },
  refunded: {
    label: "Refunded",
    tone: "refunded",
    color: "#92400e",
    bg: "#fef3c7",
  },
  Funded: {
    label: "Funded",
    tone: "pending",
    color: "#065f46",
    bg: "#d1fae5",
  },
  Released: {
    label: "Released",
    tone: "success",
    color: "#1e40af",
    bg: "#dbeafe",
  },
  Disputed: {
    label: "Disputed",
    tone: "failed",
    color: "#991b1b",
    bg: "#fee2e2",
  },
  Refunded: {
    label: "Refunded",
    tone: "refunded",
    color: "#92400e",
    bg: "#fef3c7",
  },
  cancelling: {
    label: "Cancelling…",
    tone: "pending",
    color: "#d97706",
    bg: "#fef3c7",
  },
  cancelled: {
    label: "Cancelled",
    tone: "refunded",
    color: "#6b7280",
    bg: "#f3f4f6",
  },
};

export type SagaStep = "reserve_stock" | "submit_soroban_escrow" | "record_order_db" | "complete";

export interface EscrowSagaContext {
  sagaId: string;
  orderId: string;
  status: "executing" | "compensating" | "succeeded" | "failed";
  step: SagaStep;
  payload: Record<string, unknown>;
}
