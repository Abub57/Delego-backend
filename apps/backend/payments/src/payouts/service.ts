import { createLogger } from "@delegolabs/utils";
import { escrowCoordinator } from "../escrowCoordinator/index.js";
import { escrowService } from "../../escrow/index.js";
import { submitContractCall } from "../../escrow/wallet-client.js";
import { findPaymentRecordByEscrowId } from "../escrowCoordinator/paymentRecordStore.js";
import { createPayoutRecord, toPayoutResponse } from "./store.js";
import type { InitiatePayoutRequest, InitiatePayoutResponse, PlatformCommissionConfig, PayoutCalculation } from "./types.js";

const log = createLogger("payments:payouts", process.env.LOG_LEVEL ?? "info");

const DEFAULT_COMMISSION_RATE = 0.01; // 1% default
const MINIMUM_FEE_STROOPS = 1000000n; // 0.1 XLM minimum fee

function getCommissionConfig(): PlatformCommissionConfig {
  const rate = process.env.PLATFORM_COMMISSION_RATE
    ? parseFloat(process.env.PLATFORM_COMMISSION_RATE)
    : DEFAULT_COMMISSION_RATE;
  
  const minimumStroops = process.env.PLATFORM_MINIMUM_FEE_STROOPS
    ? BigInt(process.env.PLATFORM_MINIMUM_FEE_STROOPS)
    : MINIMUM_FEE_STROOPS;

  return { rate, minimumStroops };
}

/**
 * Calculate payout with fees rounded down (favor merchant)
 */
export function calculatePayout(grossAmountStroops: bigint, merchantAddress: string, escrowId: string): PayoutCalculation {
  const config = getCommissionConfig();
  
  // Calculate fee: round down to favor merchant
  const rawFee = grossAmountStroops * BigInt(Math.floor(config.rate * 1000000)) / 1000000n;
  const platformFeeStroops = rawFee < config.minimumStroops ? config.minimumStroops : rawFee;
  
  const netMerchantPayoutStroops = grossAmountStroops - platformFeeStroops;

  return {
    escrowId,
    grossAmountStroops,
    platformFeeStroops,
    netMerchantPayoutStroops,
    merchantAddress,
  };
}

/**
 * Initiate payout for an escrow
 * 1. Calculate platform commission (round down)
 * 2. Submit signed contract release() transaction via Wallet Service
 * 3. Log payout transaction hash in merchant_payouts table
 */
export async function initiatePayout(request: InitiatePayoutRequest): Promise<InitiatePayoutResponse> {
  const { escrowId, merchantAddress, sourceAddress } = request;

  log.info("Initiating payout", {
    escrowId,
    merchantAddress,
    sourceAddress,
  });

  // Get payment record to verify escrow exists and get amount
  const paymentRecord = await findPaymentRecordByEscrowId(escrowId);
  if (!paymentRecord) {
    throw new Error(`Escrow not found: ${escrowId}`);
  }

  if (paymentRecord.status !== "funded") {
    throw new Error(`Escrow ${escrowId} is not in funded status (current: ${paymentRecord.status})`);
  }

  // Calculate payout with fees
  const grossAmount = BigInt(paymentRecord.amountStroops);
  const calculation = calculatePayout(grossAmount, merchantAddress, escrowId);

  log.info("Payout calculation", {
    escrowId,
    grossAmountStroops: calculation.grossAmountStroops.toString(),
    platformFeeStroops: calculation.platformFeeStroops.toString(),
    netMerchantPayoutStroops: calculation.netMerchantPayoutStroops.toString(),
  });

  // Release escrow via wallet service
  // The release() method on escrowService submits the contract call directly
  const escrowReleaseResult = await escrowService.release({
    sourceAddress,
    escrowId,
  });

  if (!escrowReleaseResult.success) {
    log.error("Escrow release failed", {
      escrowId,
      txHash: escrowReleaseResult.txHash,
    });
    throw new Error(`Escrow release failed: ${escrowReleaseResult.txHash}`);
  }

  log.info("Escrow released successfully", {
    escrowId,
    txHash: escrowReleaseResult.txHash,
    ledger: escrowReleaseResult.ledger,
  });

  // Store payout record
  const payoutRecord = await createPayoutRecord(calculation, escrowReleaseResult.txHash, escrowReleaseResult.ledger);

  log.info("Payout record stored", {
    payoutId: payoutRecord.id,
    escrowId,
    transactionHash: escrowReleaseResult.txHash,
  });

  return toPayoutResponse(payoutRecord);
}
