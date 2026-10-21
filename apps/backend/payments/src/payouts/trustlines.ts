/**
 * Stellar Trustline Verification for Payout Orchestrator — Issue #594.
 */
import { Horizon } from "@stellar/stellar-sdk";
import { createLogger } from "@delegolabs/utils";
import type { TrustlineCheckResult } from "@delegolabs/types";
import type { TrustlineSetupInstructions } from "./types.js";

const log = createLogger("payments:trustlines", process.env.LOG_LEVEL ?? "info");

export interface TrustlineCheckOptions {
  server?: Horizon.Server | { loadAccount: (account: string) => Promise<any> };
  horizonUrl?: string;
}

/**
 * Checks destination address trustline on Stellar Horizon.
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

  const horizonUrl =
    options.horizonUrl ??
    process.env.STELLAR_HORIZON_URL ??
    "https://horizon-testnet.stellar.org";
  const server = options.server ?? new Horizon.Server(horizonUrl);

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
    const currentBalance = trustlineBalance.balance
      ? trustlineBalance.balance.toString()
      : "0";
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

export function isTrustlineValidForPayout(result: TrustlineCheckResult): boolean {
  return result.trustlineEstablished && result.authorized;
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
