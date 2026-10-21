/**
 * Classic Stellar transaction submitter — Issue #108.
 *
 * Trustlines and classic asset transfers operate on the classic Stellar
 * protocol (ChangeTrust, Payment, PathPayment, SetTrustLineFlags) and are
 * submitted through Horizon rather than the Soroban RPC queue. This module
 * mirrors the resilient-signing flow used by the Soroban queue: vault-key
 * signing, dynamic fee estimation, sequence handling, and Horizon submission.
 */
import {
  Keypair,
  Horizon,
  TransactionBuilder,
  Memo,
  Asset,
  Operation,
} from "@stellar/stellar-sdk";
import type { xdr } from "@stellar/stellar-sdk";
import { createLogger } from "@delegolabs/utils";
import { vaultService } from "../vault.js";
import { getTransactionFee } from "../dynamicFee.js";
import { getStellarConfig } from "./config.js";
import { normalizeStellarAddress } from "../normalizeStellarAddress.js";
import { validateMemo } from "../../transactions/index.js";
import { createHorizonServer } from "../../stellar/mockHorizon.js";

const log = createLogger("wallet:assets:submitter", process.env.LOG_LEVEL ?? "info");

export interface ClassicSubmitRequest {
  sourceAddress: string;
  operations: xdr.Operation[];
  memo?: string;
}

export interface ClassicSubmitResult {
  hash: string;
  success: boolean;
  ledger?: number;
}

export interface ClassicSubmitter {
  submit(request: ClassicSubmitRequest): Promise<ClassicSubmitResult>;
}

export interface SubmitterDeps {
  server?: Horizon.Server;
  secretProvider?: (publicKey: string) => Promise<string>;
}

function buildMemo(text?: string): Memo {
  const memo = text?.trim();
  if (!memo) return Memo.none();
  const validation = validateMemo(memo);
  if (!validation.valid) {
    throw new Error(`Invalid memo: ${validation.error ?? "unknown reason"}`);
  }
  if (validation.type === "id") return Memo.id(memo);
  if (validation.type === "hash") return Memo.hash(memo);
  if (validation.type === "return") return Memo.return(memo);
  return Memo.text(memo);
}

/**
 * Builds a classic-transaction submitter. Accepts an injected Horizon server
 * and secret provider so unit tests can avoid touching the vault and network.
 */
export function buildSubmitter(deps: SubmitterDeps = {}): ClassicSubmitter {
  const config = getStellarConfig();
  const getSecret = deps.secretProvider ?? ((pk: string) => vaultService.getKey(pk));

  return {
    async submit(request) {
      const { original, normalized, valid } = normalizeStellarAddress(
        request.sourceAddress,
      );
      if (!valid) throw new Error("Invalid Stellar public key address");
      void original;

      if (!request.operations || request.operations.length === 0) {
        throw new Error("At least one operation is required");
      }

      const horizonServer =
        deps.server ?? createHorizonServer(config.horizonUrl);

      const secret = await getSecret(normalized);
      const signer = Keypair.fromSecret(secret);

      const sourceAccount = await horizonServer.loadAccount(normalized);

      const fee = await getTransactionFee(config.horizonUrl);
      let builder = new TransactionBuilder(sourceAccount, {
        fee,
        networkPassphrase: config.networkPassphrase,
      });

      for (const op of request.operations) {
        builder = builder.addOperation(op);
      }

      builder = builder.addMemo(buildMemo(request.memo));
      const tx = builder.setTimeout(30).build();
      tx.sign(signer);

      const response = await horizonServer.submitTransaction(tx);
      const result = response as unknown as {
        hash?: string;
        ledger?: number;
        successful?: boolean;
      };

      const hash = result.hash ?? tx.hash().toString("hex");
      log.info("Classic transaction submitted", {
        hash,
        sourceAddress: normalized,
        operations: request.operations.length,
      });
      return {
        hash,
        success: result.successful ?? true,
        ledger: result.ledger,
      };
    },
  };
}

/** Build a ChangeTrust operation for a credit asset. `limit` is a decimal string. */
export function changeTrustOp(asset: Asset, limit: string): xdr.Operation {
  return Operation.changeTrust({ asset, limit });
}

/** Build a Payment operation. Amount is in stroops. */
export function paymentOp(
  destination: string,
  asset: Asset,
  amountStroops: string,
): xdr.Operation {
  return Operation.payment({
    destination,
    asset,
    amount: amountStroops,
  });
}

/** Build a strict-send path payment operation. */
export function pathPaymentStrictSendOp(
  destination: string,
  sendAsset: Asset,
  sendAmountStroops: string,
  destAsset: Asset,
  destMinStroops: string,
  path: Asset[] = [],
): xdr.Operation {
  return Operation.pathPaymentStrictSend({
    sendAsset,
    sendAmount: sendAmountStroops,
    destination,
    destAsset,
    destMin: destMinStroops,
    path,
  });
}

/** Build a strict-receive path payment operation. */
export function pathPaymentStrictReceiveOp(
  destination: string,
  sendAsset: Asset,
  sendMaxStroops: string,
  destAsset: Asset,
  destAmountStroops: string,
  path: Asset[] = [],
): xdr.Operation {
  return Operation.pathPaymentStrictReceive({
    sendAsset,
    sendMax: sendMaxStroops,
    destination,
    destAsset,
    destAmount: destAmountStroops,
    path,
  });
}

/** Build a SetTrustLineFlags operation (issuer-side authorization). */
export function setTrustLineFlagsOp(params: {
  trustor: string;
  asset: Asset;
  source?: string;
  authorized?: boolean;
  authorizedToMaintainLiabilities?: boolean;
  clawbackEnabled?: boolean;
}): xdr.Operation {
  return Operation.setTrustLineFlags({
    trustor: params.trustor,
    asset: params.asset,
    source: params.source,
    flags: {
      authorized: params.authorized,
      authorizedToMaintainLiabilities: params.authorizedToMaintainLiabilities,
      clawbackEnabled: params.clawbackEnabled,
    },
  });
}