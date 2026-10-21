import { createLogger } from "@delegolabs/utils";
import type { TrustlineCheckResult } from "@delegolabs/types";
import { escrowService } from "../../escrow/index.js";
import { findPaymentRecordByEscrowId } from "../escrowCoordinator/paymentRecordStore.js";
import { createPayoutRecord, toPayoutResponse } from "./store.js";
import type {
  InitiatePayoutRequest,
  InitiatePayoutResponse,
  PlatformCommissionConfig,
  PayoutCalculation,
  TrustlineSetupInstructions,
} from "./types.js";
import {
  checkTrustline,
  generateTrustlineSetupInstructions,
  isTrustlineValidForPayout,
} from "./trustlines.js";

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
export function calculatePayout(
  grossAmountStroops: bigint,
  merchantAddress: string,
  escrowId: string
): PayoutCalculation {
  const config = getCommissionConfig();

  // Calculate fee: round down to favor merchant
  const rawFee =
    (grossAmountStroops * BigInt(Math.floor(config.rate * 1000000))) / 1000000n;
  const platformFeeStroops =
    rawFee < config.minimumStroops ? config.minimumStroops : rawFee;

  const netMerchantPayoutStroops = grossAmountStroops - platformFeeStroops;

  return {
    escrowId,
    grossAmountStroops,
    platformFeeStroops,
    netMerchantPayoutStroops,
    merchantAddress,
  };
}

export interface PayoutServiceDeps {
  checkTrustlineFn?: (
    account: string,
    assetCode: string,
    assetIssuer: string
  ) => Promise<TrustlineCheckResult>;
  notifyMerchantFn?: (payload: {
    merchantAddress: string;
    assetCode: string;
    assetIssuer: string;
    instructions: TrustlineSetupInstructions;
    checkResult: TrustlineCheckResult;
  }) => Promise<void>;
  escrowReleaseFn?: (params: {
    sourceAddress: string;
    escrowId: string;
  }) => Promise<{ success: boolean; txHash: string; ledger: number }>;
}

/**
 * Default notification dispatcher for missing trustlines.
 */
async function defaultNotifyMerchant(payload: {
  merchantAddress: string;
  assetCode: string;
  assetIssuer: string;
  instructions: TrustlineSetupInstructions;
  checkResult: TrustlineCheckResult;
}): Promise<void> {
  log.warn("Merchant notification: Stellar trustline required", {
    merchantAddress: payload.merchantAddress,
    assetCode: payload.assetCode,
    assetIssuer: payload.assetIssuer,
    instructions: payload.instructions.instructions,
    steps: payload.instructions.steps,
  });
}

/**
 * Initiate payout for an escrow with Pre-Flight Trustline Verification (Issue #594)
 * 1. Calculate platform commission (round down)
 * 2. If non-native asset: verify destination trustline before submitting
 *    - If missing/unauthorized: pause payout, notify merchant, prevent blockchain errors/fees
 * 3. Submit signed contract release() transaction via Wallet Service
 * 4. Log payout transaction hash in merchant_payouts table
 */
export async function initiatePayout(
  request: InitiatePayoutRequest,
  deps: PayoutServiceDeps = {}
): Promise<InitiatePayoutResponse> {
  const { escrowId, merchantAddress, sourceAddress, assetCode, assetIssuer } = request;

  log.info("Initiating payout", {
    escrowId,
    merchantAddress,
    sourceAddress,
    assetCode,
    assetIssuer,
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

  // Pre-flight Trustline Check (Issue #594)
  if (assetCode && assetCode.toUpperCase() !== "XLM") {
    if (!assetIssuer) {
      throw new Error(`Asset issuer must be specified for non-native asset payout (${assetCode})`);
    }

    const checkTrustlineFn = deps.checkTrustlineFn ?? checkTrustline;
    const notifyMerchantFn = deps.notifyMerchantFn ?? defaultNotifyMerchant;

    const checkResult = await checkTrustlineFn(merchantAddress, assetCode, assetIssuer);

    if (!isTrustlineValidForPayout(checkResult)) {
      const pauseReason = !checkResult.trustlineEstablished
        ? "MISSING_TRUSTLINE"
        : "UNAUTHORIZED_TRUSTLINE";

      const instructions = generateTrustlineSetupInstructions(
        merchantAddress,
        assetCode,
        assetIssuer
      );

      log.warn("Pre-flight trustline check failed: pausing payout", {
        escrowId,
        merchantAddress,
        assetCode,
        assetIssuer,
        pauseReason,
      });

      // Pause payout and store record
      const pausedRecord = await createPayoutRecord(
        calculation,
        null,
        null,
        "paused",
        pauseReason
      );

      // Notify merchant with instructions
      await notifyMerchantFn({
        merchantAddress,
        assetCode,
        assetIssuer,
        instructions,
        checkResult,
      });

      // Return paused response without submitting to blockchain
      return toPayoutResponse(pausedRecord, {
        status: "paused",
        pausedReason: pauseReason,
        trustlineCheck: checkResult,
        instructions,
      });
    }
  }

  // Release escrow via wallet service
  const escrowReleaseFn = deps.escrowReleaseFn ?? (async (p) => escrowService.release(p));
  const escrowReleaseResult = await escrowReleaseFn({
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
  const payoutRecord = await createPayoutRecord(
    calculation,
    escrowReleaseResult.txHash,
    escrowReleaseResult.ledger,
    "confirmed"
  );

  log.info("Payout record stored", {
    payoutId: payoutRecord.id,
    escrowId,
    transactionHash: escrowReleaseResult.txHash,
  });

  return toPayoutResponse(payoutRecord);
}
