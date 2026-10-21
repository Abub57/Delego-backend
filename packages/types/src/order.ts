/** Commerce order lifecycle */

export type OrderStatus =
  | "draft"
  | "pending"
  | "pending_approval"
  | "approved"
  | "rejected"
  | "escrowed"
  | "fulfilled"
  | "settled"
  | "completed"
  | "failed"
  | "canceled"
  | "cancelled"
  | "disputed"
  /** Dual-control (#574): first approval recorded, waiting on a second signer. */
  | "awaiting_countersign";

export interface OrderLineItem {
  name?: string;
  productId?: string;
  price?: number;
  /**
   * Stroop amount as a decimal integer string (#338) — never a `number`,
   * which loses precision for i128 amounts beyond 2^53 - 1.
   */
  unitPriceStroops?: string;
  quantity: number;
}

export type OrderItem = OrderLineItem;

/** A single approve/countersign signature captured for an order (#574). */
export interface ApprovalSignature {
  approverId: string;
  approverAddress?: string;
  /** ISO-8601 timestamp, server-issued. */
  timestamp: string;
}

/**
 * Dual-control approval state for a single order (#574).
 */
export interface DualControlState {
  required: boolean;
  status: "single" | "awaiting_countersign" | "completed";
  delegationOwners?: string[];
  firstApproval?: ApprovalSignature;
  secondApproval?: ApprovalSignature;
}

/**
 * Structured reason recorded when a pending order is rejected (#567).
 */
export type RejectionReasonCode =
  | "too_expensive"
  | "wrong_item"
  | "wrong_merchant"
  | "wrong_time"
  | "other";

export interface Order {
  id: string;
  userId?: string;
  delegationId: string;
  merchantId?: string;
  merchantName?: string;
  amount?: string;
  /**
   * Stroop amount as a decimal integer string (#338) — never a `number`,
   * which loses precision for i128 amounts beyond 2^53 - 1.
   */
  totalStroops?: string;
  currency?: string;
  status: OrderStatus;
  lineItems?: OrderLineItem[];
  items?: OrderLineItem[];
  escrowContractId?: string | null;
  rejectionReason?: RejectionReasonCode | null;
  rejectionNote?: string | null;
  dualControl?: DualControlState;
  approvalNote?: string | null;
  createdAt: Date | string;
  updatedAt?: Date | string;
}

