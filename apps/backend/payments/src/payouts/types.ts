/** Payout service types */

/**
 * Platform commission configuration
 */
export interface PlatformCommissionConfig {
  rate: number; // e.g. 0.01 for 1%
  minimumStroops: bigint;
}

/**
 * Payout calculation result
 */
export interface PayoutCalculation {
  escrowId: string;
  grossAmountStroops: bigint;
  platformFeeStroops: bigint; // Round down (favor merchant)
  netMerchantPayoutStroops: bigint;
  merchantAddress: string;
}

/**
 * Request to trigger payout
 */
export interface InitiatePayoutRequest {
  escrowId: string;
  merchantAddress: string;
  sourceAddress: string;
}

/**
 * Response from payout initiation
 */
export interface InitiatePayoutResponse {
  payoutId: string;
  escrowId: string;
  grossAmountStroops: bigint;
  platformFeeStroops: bigint;
  netMerchantPayoutStroops: bigint;
  transactionHash: string;
  ledger: number;
  status: "submitted" | "confirmed";
  paidAt: string;
}

/**
 * Payout ledger record stored in PostgreSQL
 */
export interface PayoutRecord {
  id: string;
  payoutId: string;
  escrowId: string;
  orderId: string;
  merchantAddress: string;
  grossAmountStroops: string;
  platformFeeStroops: string;
  netMerchantPayoutStroops: string;
  transactionHash: string | null;
  ledger: number | null;
  status: "pending" | "submitted" | "confirmed" | "failed";
  createdAt: Date;
  updatedAt: Date;
}
