/**
 * Stellar Trustline Verification & Pre-Flight Checks — Issue #594.
 *
 * Verifies destination address trustlines for non-native Stellar assets
 * (e.g., USDC, EURC) prior to initiating payouts or batch transfers.
 * Prevents failed transaction fees and blockchain error logs.
 */
import { Horizon } from "@stellar/stellar-sdk";
import { createLogger } from "@delegolabs/utils";
import { getStellarConfig } from "../assets/config.js";

const log = createLogger("wallet:stellar:trustlines", process.env.LOG_LEVEL ?? "info");

export interface TrustlineCheckResult {
  account: string;
  assetCode: string;
  assetIssuer: string;
  trustlineEstablished: boolean;
  authorized: boolean;
  currentBalance: string;
  creditLimit: string;
}

export interface TrustlineCheckOptions {
  server?: Horizon.Server | { loadAccount: (account: string) => Promise<any> };
  horizonUrl?: string;
}

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

export interface PayoutBatchItem {
  id: string;
  merchantAddress: string;
  assetCode: string;
  assetIssuer: string;
  amount: string;
  escrowId?: string;
  metadata?: Record<string, unknown>;
}

export interface PayoutPreflightValidationResult {
  validItems: PayoutBatchItem[];
  pausedItems: Array<{
    item: PayoutBatchItem;
    reason: "MISSING_TRUSTLINE" | "UNAUTHORIZED_TRUSTLINE";
    checkResult: TrustlineCheckResult;
    instructions: TrustlineSetupInstructions;
  }>;
}

export interface TrustlinePreflightWorkerDeps {
  server?: Horizon.Server | { loadAccount: (account: string) => Promise<any> };
  notifyMerchant?: (notification: {
    merchantAddress: string;
    assetCode: string;
    assetIssuer: string;
    instructions: TrustlineSetupInstructions;
    checkResult: TrustlineCheckResult;
    item: PayoutBatchItem;
  }) => Promise<void>;
  onPausePayout?: (item: PayoutBatchItem, reason: string) => Promise<void>;
}

/**
 * Checks if a Stellar destination account has established and authorized a trustline
 * for a specific credit asset (e.g. USDC, EURC).
 */
export async function checkTrustline(
  account: string,
  assetCode: string,
  assetIssuer: string,
  options: TrustlineCheckOptions = {}
): Promise<TrustlineCheckResult> {
  if (!account) {
    throw new Error("Destination account address is required for trustline check");
  }
  if (!assetCode) {
    throw new Error("Asset code is required for trustline check");
  }

  // Native XLM does not require a trustline
  if (assetCode.toUpperCase() === "XLM" || assetCode.toLowerCase() === "native") {
    return {
      account,
      assetCode: "XLM",
      assetIssuer: "",
      trustlineEstablished: true,
      authorized: true,
      currentBalance: "0",
      creditLimit: "unlimited",
    };
  }

  if (!assetIssuer) {
    throw new Error(`Asset issuer is required for non-native asset ${assetCode}`);
  }

  const server =
    options.server ??
    new Horizon.Server(options.horizonUrl ?? getStellarConfig().horizonUrl);

  try {
    const accountRecord = await server.loadAccount(account);
    const balances = accountRecord.balances ?? [];

    const trustlineBalance = balances.find((b: any) => {
      const codeMatches =
        b.asset_code && b.asset_code.toUpperCase() === assetCode.toUpperCase();
      const issuerMatches = b.asset_issuer === assetIssuer;
      return codeMatches && issuerMatches;
    });

    if (!trustlineBalance) {
      log.info("Trustline not found on account", {
        account,
        assetCode,
        assetIssuer,
      });
      return {
        account,
        assetCode,
        assetIssuer,
        trustlineEstablished: false,
        authorized: false,
        currentBalance: "0",
        creditLimit: "0",
      };
    }

    const isAuthorized = trustlineBalance.is_authorized !== false;
    const currentBalance = trustlineBalance.balance ? trustlineBalance.balance.toString() : "0";
    const creditLimit = trustlineBalance.limit ? trustlineBalance.limit.toString() : "0";

    return {
      account,
      assetCode,
      assetIssuer,
      trustlineEstablished: true,
      authorized: isAuthorized,
      currentBalance,
      creditLimit,
    };
  } catch (err: any) {
    // If account doesn't exist on Horizon (404), trustline is not established
    log.warn("Horizon error during trustline check", {
      account,
      assetCode,
      assetIssuer,
      error: err?.message,
    });

    return {
      account,
      assetCode,
      assetIssuer,
      trustlineEstablished: false,
      authorized: false,
      currentBalance: "0",
      creditLimit: "0",
    };
  }
}

/**
 * Alias for checkTrustline.
 */
export const verifyTrustline = checkTrustline;

/**
 * Validates whether a trustline check result is eligible for payout.
 */
export function isTrustlineValidForPayout(result: TrustlineCheckResult): boolean {
  return result.trustlineEstablished && result.authorized;
}

/**
 * Generates setup instructions for merchants missing trustlines or authorization.
 */
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

/**
 * Background pre-flight validator worker for batch payout transfers.
 * Validates trustlines for all batch recipients, pauses invalid payouts,
 * and notifies merchants with actionable setup instructions.
 */
export class TrustlinePreflightWorker {
  private server?: Horizon.Server | { loadAccount: (account: string) => Promise<any> };
  private notifyMerchant?: (notification: {
    merchantAddress: string;
    assetCode: string;
    assetIssuer: string;
    instructions: TrustlineSetupInstructions;
    checkResult: TrustlineCheckResult;
    item: PayoutBatchItem;
  }) => Promise<void>;
  private onPausePayout?: (item: PayoutBatchItem, reason: string) => Promise<void>;

  constructor(deps: TrustlinePreflightWorkerDeps = {}) {
    this.server = deps.server;
    this.notifyMerchant = deps.notifyMerchant;
    this.onPausePayout = deps.onPausePayout;
  }

  /**
   * Validates a batch of payout items prior to transaction submission.
   */
  async validateBatch(items: PayoutBatchItem[]): Promise<PayoutPreflightValidationResult> {
    const validItems: PayoutBatchItem[] = [];
    const pausedItems: PayoutPreflightValidationResult["pausedItems"] = [];

    for (const item of items) {
      // Non-native assets must be checked
      if (item.assetCode && item.assetCode.toUpperCase() !== "XLM") {
        const checkResult = await checkTrustline(
          item.merchantAddress,
          item.assetCode,
          item.assetIssuer,
          { server: this.server }
        );

        if (!checkResult.trustlineEstablished || !checkResult.authorized) {
          const reason = !checkResult.trustlineEstablished
            ? "MISSING_TRUSTLINE"
            : "UNAUTHORIZED_TRUSTLINE";

          const instructions = generateTrustlineSetupInstructions(
            item.merchantAddress,
            item.assetCode,
            item.assetIssuer
          );

          if (this.onPausePayout) {
            await this.onPausePayout(item, reason);
          }

          if (this.notifyMerchant) {
            await this.notifyMerchant({
              merchantAddress: item.merchantAddress,
              assetCode: item.assetCode,
              assetIssuer: item.assetIssuer,
              instructions,
              checkResult,
              item,
            });
          }

          pausedItems.push({
            item,
            reason,
            checkResult,
            instructions,
          });
          continue;
        }
      }

      validItems.push(item);
    }

    return { validItems, pausedItems };
  }
}

/**
 * Factory for TrustlinePreflightWorker.
 */
export function createTrustlinePreflightWorker(
  deps: TrustlinePreflightWorkerDeps = {}
): TrustlinePreflightWorker {
  return new TrustlinePreflightWorker(deps);
}
