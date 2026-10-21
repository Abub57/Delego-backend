import { createLogger } from "@delegolabs/utils";
import {
  SagaCoordinator,
  type SagaStep as BaseSagaStep,
  type SagaStore,
} from "../../src/saga/index.js";
import type { TrustlineCheckResult } from "@delegolabs/types";

const log = createLogger("orchestrator:payout:saga", process.env.LOG_LEVEL ?? "info");

export interface TrustlineSetupInstructions {
  account: string;
  assetCode: string;
  assetIssuer: string;
  limit: string;
  recommendedAction: "ESTABLISH_TRUSTLINE" | "REQUEST_AUTHORIZATION";
  instructions: string;
  steps: string[];
  stellarLaboratoryUrl: string;
}

export interface PayoutSagaPayload {
  escrowId: string;
  orderId?: string;
  merchantAddress: string;
  sourceAddress: string;
  assetCode?: string;
  assetIssuer?: string;
  amountStroops?: string;
  trustlineCheck?: TrustlineCheckResult;
  instructions?: TrustlineSetupInstructions;
  pauseReason?: string;
  txHash?: string;
  ledger?: number;
}

export interface PayoutSagaContext extends Record<string, unknown> {
  sagaId: string;
  step: string;
  status: "pending" | "running" | "succeeded" | "failed" | "compensating" | "compensated" | "paused";
  payload: PayoutSagaPayload;
  history?: any[];
}

export interface PayoutSagaServices {
  checkTrustline: (
    account: string,
    assetCode: string,
    assetIssuer: string
  ) => Promise<TrustlineCheckResult>;
  notifyMerchant: (notification: {
    merchantAddress: string;
    assetCode: string;
    assetIssuer: string;
    instructions: TrustlineSetupInstructions;
    checkResult: TrustlineCheckResult;
  }) => Promise<void>;
  releaseEscrow: (params: {
    sourceAddress: string;
    escrowId: string;
  }) => Promise<{ txHash: string; ledger: number; success: boolean }>;
  recordPayoutDb: (context: PayoutSagaContext) => Promise<void>;
}

export function generateTrustlineSetupInstructions(
  account: string,
  assetCode: string,
  assetIssuer: string,
  options: { limit?: string; network?: string } = {}
): TrustlineSetupInstructions {
  const limit = options.limit ?? "9223372036854775807";
  const network = options.network ?? "testnet";
  const labUrl = `https://laboratory.stellar.org/#txbuilder?network=${network}`;

  return {
    account,
    assetCode,
    assetIssuer,
    limit,
    recommendedAction: "ESTABLISH_TRUSTLINE",
    instructions: `Merchant destination address ${account} must establish a ChangeTrust trustline for ${assetCode} (issuer: ${assetIssuer}) before payout funds can be disbursed.`,
    steps: [
      `1. Open your Stellar wallet (Freighter, Albedo, LOBSTR) or the Stellar Laboratory at ${labUrl}.`,
      `2. Navigate to Add Asset / Change Trust.`,
      `3. Enter Asset Code: ${assetCode} and Issuer Account: ${assetIssuer}.`,
      `4. Set Trust Limit to ${limit} (or leave blank for maximum limit).`,
      `5. Sign and submit the ChangeTrust transaction. Once established, payout will resume immediately.`,
    ],
    stellarLaboratoryUrl: labUrl,
  };
}

export const defaultPayoutSagaServices: PayoutSagaServices = {
  checkTrustline: async (account, assetCode, assetIssuer) => ({
    account,
    assetCode,
    assetIssuer,
    trustlineEstablished: true,
    authorized: true,
    currentBalance: "0",
    creditLimit: "unlimited",
  }),
  notifyMerchant: async (notification) => {
    log.warn("Merchant trustline notification sent", notification);
  },
  releaseEscrow: async () => ({
    txHash: `payout_tx_${Date.now()}`,
    ledger: 100000,
    success: true,
  }),
  recordPayoutDb: async () => {},
};

export function createPayoutSagaCoordinator(
  store: SagaStore,
  services: PayoutSagaServices = defaultPayoutSagaServices
): SagaCoordinator<PayoutSagaContext> {
  const preflightTrustlineCheckStep: BaseSagaStep<PayoutSagaContext> = {
    name: "preflight_trustline_check",
    async execute(context) {
      log.info("Executing preflight_trustline_check", { sagaId: context.sagaId });
      const { merchantAddress, assetCode, assetIssuer } = context.payload;

      // Only non-native assets need trustline verification
      if (assetCode && assetCode.toUpperCase() !== "XLM") {
        if (!assetIssuer) {
          throw new Error(`Asset issuer required for non-native asset ${assetCode}`);
        }

        const checkResult = await services.checkTrustline(
          merchantAddress,
          assetCode,
          assetIssuer
        );

        if (!checkResult.trustlineEstablished || !checkResult.authorized) {
          const pauseReason = !checkResult.trustlineEstablished
            ? "MISSING_TRUSTLINE"
            : "UNAUTHORIZED_TRUSTLINE";

          const instructions = generateTrustlineSetupInstructions(
            merchantAddress,
            assetCode,
            assetIssuer
          );

          await services.notifyMerchant({
            merchantAddress,
            assetCode,
            assetIssuer,
            instructions,
            checkResult,
          });

          // Pause workflow: prevent failed transaction fees and blockchain error logs
          return {
            ...context,
            step: "preflight_trustline_check",
            status: "paused",
            payload: {
              ...context.payload,
              trustlineCheck: checkResult,
              instructions,
              pauseReason,
            },
          };
        }

        return {
          ...context,
          step: "preflight_trustline_check",
          payload: {
            ...context.payload,
            trustlineCheck: checkResult,
          },
        };
      }

      return { ...context, step: "preflight_trustline_check" };
    },
    async compensate(context) {
      return context;
    },
  };

  const releaseEscrowStep: BaseSagaStep<PayoutSagaContext> = {
    name: "release_escrow",
    async execute(context) {
      if (context.status === "paused") {
        return context;
      }

      log.info("Executing release_escrow", { sagaId: context.sagaId });
      const { sourceAddress, escrowId } = context.payload;

      const releaseResult = await services.releaseEscrow({
        sourceAddress,
        escrowId,
      });

      return {
        ...context,
        step: "release_escrow",
        payload: {
          ...context.payload,
          txHash: releaseResult.txHash,
          ledger: releaseResult.ledger,
        },
      };
    },
    async compensate(context) {
      return context;
    },
  };

  const recordPayoutStep: BaseSagaStep<PayoutSagaContext> = {
    name: "record_payout",
    async execute(context) {
      if (context.status === "paused") {
        return context;
      }

      log.info("Executing record_payout", { sagaId: context.sagaId });
      await services.recordPayoutDb(context);
      return { ...context, step: "record_payout", status: "succeeded" };
    },
    async compensate(context) {
      return context;
    },
  };

  return new SagaCoordinator<PayoutSagaContext>({
    steps: [preflightTrustlineCheckStep, releaseEscrowStep, recordPayoutStep],
    store,
  });
}
