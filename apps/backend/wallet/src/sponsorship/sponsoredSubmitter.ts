/**
 * Sponsored Fee Submitter
 *
 * Wraps Soroban RPC transaction submission. Given an unsigned (or
 * buyer-signed) transaction XDR, the submitter:
 *
 *   1. Runs `checkEligibility` against the gas tank policy.
 *   2. Attaches the sponsor's signature.
 *   3. Submits via `SorobanRpc.Server.sendTransaction`.
 *   4. Records the spend in the gas tank manager **after** the RPC
 *      acknowledges the transaction.
 *
 * Fee accounting is deliberately post-confirmation: a rejected
 * transaction must not consume the daily budget.
 *
 * Closes #398.
 */

import {
  Keypair,
  TransactionBuilder,
  rpc as SorobanRpc,
  Networks,
} from "@stellar/stellar-sdk";
import { createLogger, type Logger } from "@delegolabs/utils";
import type { GasTankManager } from "./gasTankManager.js";
import { checkEligibility } from "./eligibility.js";
import type {
  SponsoredSubmitRequest,
  SponsoredSubmitResult,
} from "./types.js";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface SponsoredSubmitterOptions {
  manager: GasTankManager;
  /** Soroban RPC URL (e.g. https://soroban-testnet.stellar.org). */
  rpcUrl: string;
  /** Network passphrase. Defaults to testnet. */
  networkPassphrase?: string;
  logger?: Logger;
  /**
   * Injectable RPC sender for tests. When omitted, a real
   * `SorobanRpc.Server` is constructed from `rpcUrl`.
   */
  sendTransaction?: (xdr: string) => Promise<{ hash: string; status: string }>;
  /** Injectable clock for the ledger entry timestamp. */
  now?: () => Date;
}

// ---------------------------------------------------------------------------
// Submitter
// ---------------------------------------------------------------------------

export class SponsoredSubmitter {
  private readonly manager: GasTankManager;
  private readonly rpcUrl: string;
  private readonly networkPassphrase: string;
  private readonly log: Logger;
  private readonly sender: (xdr: string) => Promise<{ hash: string; status: string }>;
  private readonly now: () => Date;

  constructor(options: SponsoredSubmitterOptions) {
    this.manager = options.manager;
    this.rpcUrl = options.rpcUrl;
    this.networkPassphrase = options.networkPassphrase ?? Networks.TESTNET;
    this.log =
      options.logger ??
      createLogger("wallet:sponsoredSubmitter", process.env.LOG_LEVEL ?? "info");
    this.now = options.now ?? (() => new Date());

    if (options.sendTransaction) {
      this.sender = options.sendTransaction;
    } else {
      const server = new SorobanRpc.Server(this.rpcUrl);
      this.sender = async (xdr: string) => {
        const tx = TransactionBuilder.fromXDR(xdr, this.networkPassphrase);
        const res = await server.sendTransaction(tx as any);
        return { hash: res.hash, status: res.status };
      };
    }
  }

  /**
   * Sponsor and submit a Soroban transaction. Returns the tx hash on
   * success, or a denial/submission failure otherwise.
   */
  async submit(request: SponsoredSubmitRequest): Promise<SponsoredSubmitResult> {
    // 1. Eligibility gate (no side effects).
    const decision = await checkEligibility(this.manager, request);
    if (!decision.eligible) {
      this.log.warn("Sponsorship denied", {
        buyerAccount: request.buyerAccount,
        contractId: request.contractId,
        reason: decision.reason,
        detail: decision.detail,
      });
      return {
        success: false,
        reason: decision.reason,
        detail: decision.detail,
      };
    }

    // 2. Attach the sponsor signature.
    let signedXdr: string;
    try {
      const sponsorSecret = (this.manager as any).sponsorSecret as string;
      const sponsorKeypair = Keypair.fromSecret(sponsorSecret);
      const tx = TransactionBuilder.fromXDR(request.txXdr, this.networkPassphrase);
      tx.sign(sponsorKeypair);
      signedXdr = tx.toXDR();
    } catch (err) {
      this.log.error("Failed to sign sponsored transaction", {
        buyerAccount: request.buyerAccount,
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        success: false,
        reason: "SUBMIT_FAILED",
        detail: err instanceof Error ? err.message : String(err),
      };
    }

    // 3. Submit.
    let txHash: string;
    try {
      const res = await this.sender(signedXdr);
      txHash = res.hash;

      // RPC returns either PENDING, DUPLICATE, TRY_AGAIN_LATER, or ERROR.
      // We only *record* the spend for PENDING/DUPLICATE — the latter is a
      // resubmit and has already been charged once.
      if (res.status !== "PENDING" && res.status !== "DUPLICATE") {
        this.log.warn("RPC rejected sponsored submission", {
          buyerAccount: request.buyerAccount,
          contractId: request.contractId,
          status: res.status,
          txHash,
        });
        return {
          success: false,
          reason: "SUBMIT_FAILED",
          detail: `RPC returned status ${res.status}`,
          txHash,
        };
      }
    } catch (err) {
      this.log.error("Sponsored submission failed", {
        buyerAccount: request.buyerAccount,
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        success: false,
        reason: "SUBMIT_FAILED",
        detail: err instanceof Error ? err.message : String(err),
      };
    }

    // 4. Record spend — only after the RPC acknowledged.
    try {
      await this.manager.recordSponsored({
        account: request.buyerAccount,
        contractId: request.contractId,
        feeStroops: request.feeStroops,
        txHash,
        sponsoredAt: this.now().toISOString(),
      });
    } catch (err) {
      // The submission succeeded but accounting failed. This is the worst
      // case: the user got a free tx. Log loudly and return success; the
      // operator can reconcile from the recentLedgers list + RPC.
      this.log.error("Sponsored tx submitted but spend could not be recorded", {
        buyerAccount: request.buyerAccount,
        txHash,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return { success: true, txHash };
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSponsoredSubmitter(
  options: SponsoredSubmitterOptions,
): SponsoredSubmitter {
  return new SponsoredSubmitter(options);
}
