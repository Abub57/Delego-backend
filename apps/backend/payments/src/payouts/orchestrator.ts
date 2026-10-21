/**
 * Payout Orchestrator & Pre-Flight Validator Worker — Issue #594.
 *
 * Coordinates merchant payouts, enforces Stellar trustline pre-flight checks
 * for non-native assets (USDC, EURC, etc.), pauses transactions when trustlines
 * are missing or unauthorized, and dispatches actionable setup instructions to merchants.
 */
import { createLogger } from "@delegolabs/utils";
import type { TrustlineCheckResult } from "@delegolabs/types";
import {
  checkTrustline,
  generateTrustlineSetupInstructions,
  isTrustlineValidForPayout,
} from "./trustlines.js";
import { calculatePayout } from "./service.js";
import { createPayoutRecord, toPayoutResponse } from "./store.js";
import type {
  InitiatePayoutRequest,
  InitiatePayoutResponse,
  TrustlineSetupInstructions,
} from "./types.js";
import { findPaymentRecordByEscrowId } from "../escrowCoordinator/paymentRecordStore.js";
import { escrowService } from "../../escrow/index.js";

const log = createLogger("payments:payout-orchestrator", process.env.LOG_LEVEL ?? "info");

export interface MerchantNotificationPayload {
  merchantAddress: string;
  assetCode: string;
  assetIssuer: string;
  escrowId: string;
  amountStroops: string;
  instructions: TrustlineSetupInstructions;
  checkResult: TrustlineCheckResult;
}

export interface PayoutOrchestratorDeps {
  checkTrustlineFn?: (
    account: string,
    assetCode: string,
    assetIssuer: string
  ) => Promise<TrustlineCheckResult>;
  notifyMerchantFn?: (payload: MerchantNotificationPayload) => Promise<void>;
  escrowReleaseFn?: (params: {
    sourceAddress: string;
    escrowId: string;
  }) => Promise<{ success: boolean; txHash: string; ledger: number }>;
}

export interface BatchPayoutOrchestrationResult {
  successful: InitiatePayoutResponse[];
  paused: InitiatePayoutResponse[];
  failed: Array<{ request: InitiatePayoutRequest; error: string }>;
}

export class PayoutOrchestrator {
  private checkTrustlineFn: (
    account: string,
    assetCode: string,
    assetIssuer: string
  ) => Promise<TrustlineCheckResult>;
  private notifyMerchantFn: (payload: MerchantNotificationPayload) => Promise<void>;
  private escrowReleaseFn: (params: {
    sourceAddress: string;
    escrowId: string;
  }) => Promise<{ success: boolean; txHash: string; ledger: number }>;

  constructor(deps: PayoutOrchestratorDeps = {}) {
    this.checkTrustlineFn = deps.checkTrustlineFn ?? checkTrustline;
    this.notifyMerchantFn =
      deps.notifyMerchantFn ??
      (async (payload) => {
        log.warn("Merchant notification: Trustline setup required", {
          merchantAddress: payload.merchantAddress,
          assetCode: payload.assetCode,
          assetIssuer: payload.assetIssuer,
          escrowId: payload.escrowId,
          instructions: payload.instructions.instructions,
        });
      });
    this.escrowReleaseFn =
      deps.escrowReleaseFn ??
      (async (params) => {
        return escrowService.release(params);
      });
  }

  /**
   * Orchestrates a single payout with pre-flight trustline verification.
   * If trustline is missing or unauthorized:
   *  1. Pauses the payout without submitting to blockchain.
   *  2. Records paused status in merchant_payouts table.
   *  3. Dispatches setup instructions to the merchant.
   *  4. Prevents network fees and error logs.
   */
  async orchestratePayout(request: InitiatePayoutRequest): Promise<InitiatePayoutResponse> {
    const { escrowId, merchantAddress, sourceAddress, assetCode, assetIssuer } = request;

    log.info("Orchestrating payout", {
      escrowId,
      merchantAddress,
      sourceAddress,
      assetCode,
      assetIssuer,
    });

    // 1. Verify payment record
    const paymentRecord = await findPaymentRecordByEscrowId(escrowId);
    if (!paymentRecord) {
      throw new Error(`Escrow not found: ${escrowId}`);
    }

    if (paymentRecord.status !== "funded") {
      throw new Error(
        `Escrow ${escrowId} is not in funded status (current: ${paymentRecord.status})`
      );
    }

    // 2. Calculate platform fees and net payout
    const grossAmount = BigInt(paymentRecord.amountStroops);
    const calculation = calculatePayout(grossAmount, merchantAddress, escrowId);

    // 3. Pre-flight trustline verification for non-native assets
    if (assetCode && assetCode.toUpperCase() !== "XLM") {
      if (!assetIssuer) {
        throw new Error(
          `Asset issuer must be specified for non-native asset payout (${assetCode})`
        );
      }

      log.info("Running pre-flight trustline check", {
        merchantAddress,
        assetCode,
        assetIssuer,
      });

      const checkResult = await this.checkTrustlineFn(merchantAddress, assetCode, assetIssuer);

      if (!isTrustlineValidForPayout(checkResult)) {
        const pauseReason = !checkResult.trustlineEstablished
          ? "MISSING_TRUSTLINE"
          : "UNAUTHORIZED_TRUSTLINE";

        const instructions = generateTrustlineSetupInstructions(
          merchantAddress,
          assetCode,
          assetIssuer
        );

        log.warn("Pre-flight check failed: pausing payout to prevent failed transaction fees", {
          escrowId,
          merchantAddress,
          pauseReason,
          checkResult,
        });

        // Store payout record with paused status
        const pausedRecord = await createPayoutRecord(
          calculation,
          null,
          null,
          "paused",
          pauseReason
        );

        // Notify merchant with setup instructions
        await this.notifyMerchantFn({
          merchantAddress,
          assetCode,
          assetIssuer,
          escrowId,
          amountStroops: calculation.netMerchantPayoutStroops.toString(),
          instructions,
          checkResult,
        });

        return toPayoutResponse(pausedRecord, {
          status: "paused",
          pausedReason: pauseReason,
          trustlineCheck: checkResult,
          instructions,
        });
      }
    }

    // 4. Submit signed release transaction
    log.info("Trustline check passed: submitting payout release transaction", {
      escrowId,
      merchantAddress,
    });

    const escrowReleaseResult = await this.escrowReleaseFn({
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

    // 5. Store confirmed payout record
    const payoutRecord = await createPayoutRecord(
      calculation,
      escrowReleaseResult.txHash,
      escrowReleaseResult.ledger,
      "confirmed"
    );

    return toPayoutResponse(payoutRecord);
  }

  /**
   * Orchestrates a batch of payout transfers with pre-flight checks.
   */
  async orchestrateBatchPayouts(
    requests: InitiatePayoutRequest[]
  ): Promise<BatchPayoutOrchestrationResult> {
    const successful: InitiatePayoutResponse[] = [];
    const paused: InitiatePayoutResponse[] = [];
    const failed: Array<{ request: InitiatePayoutRequest; error: string }> = [];

    for (const req of requests) {
      try {
        const res = await this.orchestratePayout(req);
        if (res.status === "paused") {
          paused.push(res);
        } else {
          successful.push(res);
        }
      } catch (err: any) {
        failed.push({
          request: req,
          error: err?.message ?? String(err),
        });
      }
    }

    return { successful, paused, failed };
  }
}

export function createPayoutOrchestrator(
  deps: PayoutOrchestratorDeps = {}
): PayoutOrchestrator {
  return new PayoutOrchestrator(deps);
}
