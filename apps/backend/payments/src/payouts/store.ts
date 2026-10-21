import { createLogger } from "@delegolabs/utils";
import { randomUUID } from "node:crypto";
import type { InitiatePayoutResponse, PayoutRecord, PayoutCalculation } from "./types.js";

const log = createLogger("payments:payouts-store", process.env.LOG_LEVEL ?? "info");

// In-memory store for development/testing
// In production, this should use PostgreSQL with a merchant_payouts table
const payoutStore = new Map<string, PayoutRecord>();

/**
 * Creates a new payout record
 */
export async function createPayoutRecord(
  calculation: PayoutCalculation,
  transactionHash: string | null,
  ledger: number | null,
  status: PayoutRecord["status"] = "confirmed",
  pausedReason?: string
): Promise<PayoutRecord> {
  const payoutId = randomUUID();
  const record: PayoutRecord = {
    id: payoutId,
    payoutId,
    escrowId: calculation.escrowId,
    orderId: calculation.escrowId, // Assuming escrowId == orderId for now
    merchantAddress: calculation.merchantAddress,
    grossAmountStroops: calculation.grossAmountStroops.toString(),
    platformFeeStroops: calculation.platformFeeStroops.toString(),
    netMerchantPayoutStroops: calculation.netMerchantPayoutStroops.toString(),
    transactionHash,
    ledger,
    status,
    pausedReason: pausedReason ?? null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  payoutStore.set(payoutId, record);
  log.info("Payout record created", {
    payoutId,
    escrowId: calculation.escrowId,
    transactionHash,
    status,
  });

  return record;
}

/**
 * Gets a payout record by ID
 */
export async function getPayoutRecordById(payoutId: string): Promise<PayoutRecord | undefined> {
  return payoutStore.get(payoutId);
}

/**
 * Gets a payout record by transaction hash
 */
export async function getPayoutRecordByTransactionHash(transactionHash: string): Promise<PayoutRecord | undefined> {
  for (const record of payoutStore.values()) {
    if (record.transactionHash === transactionHash) {
      return record;
    }
  }
  return undefined;
}

/**
 * Updates a payout record status
 */
export async function updatePayoutRecordStatus(payoutId: string, status: PayoutRecord["status"], ledger?: number): Promise<PayoutRecord | undefined> {
  const record = payoutStore.get(payoutId);
  if (!record) {
    return undefined;
  }

  record.status = status;
  record.updatedAt = new Date();
  if (ledger !== undefined) {
    record.ledger = ledger;
  }

  payoutStore.set(payoutId, record);
  log.info("Payout record updated", {
    payoutId,
    status,
    ledger,
  });

  return record;
}

/**
 * Converts a payout record to response format
 */
export function toPayoutResponse(
  record: PayoutRecord,
  extras?: Partial<InitiatePayoutResponse>
): InitiatePayoutResponse {
  return {
    payoutId: record.payoutId,
    escrowId: record.escrowId,
    grossAmountStroops: BigInt(record.grossAmountStroops),
    platformFeeStroops: BigInt(record.platformFeeStroops),
    netMerchantPayoutStroops: BigInt(record.netMerchantPayoutStroops),
    transactionHash: record.transactionHash ?? "",
    ledger: record.ledger ?? 0,
    status: record.status,
    paidAt: record.createdAt.toISOString(),
    ...(record.pausedReason ? { pausedReason: record.pausedReason } : {}),
    ...extras,
  };
}

