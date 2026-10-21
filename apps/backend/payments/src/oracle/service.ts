/**
 * Issue #369 — Oracle delivery receipt signing service.
 *
 * Orchestrates the full oracle lifecycle:
 *
 *   1. Validate the incoming receipt fields.
 *   2. Build the canonical binary payload (see payload.ts).
 *   3. Sign the payload with the configured HSM-backed Ed25519 key.
 *   4. Return the signed receipt to the caller, OR
 *   5. Submit the signed receipt directly to the Soroban escrow contract.
 *
 * The signature is verifiable against the on-chain oracle public key: the
 * contract reconstructs the same canonical bytes and runs Ed25519 verify.
 */

import { createLogger } from "@delegolabs/utils";
import { getEscrowContractId } from "../../escrow/config.js";
import type { OracleKeySigner, OracleSignResult } from "./keyProvider.js";
import { getOracleSigner } from "./config.js";
import { buildCanonicalDeliveryPayload, canonicalPayloadHash } from "./payload.js";
import type {
  OracleDeliveryReceiptInput,
  OracleSignedDeliveryReceipt,
  OracleSigningError,
  OracleSubmitReceiptResult,
} from "./types.js";

const log = createLogger("payments:oracle:service", process.env.LOG_LEVEL ?? "info");

export interface OracleSignOptions {
  /** When true, submit the signed receipt to the escrow contract after signing. */
  submitToContract?: boolean;
}

/**
 * Sign a delivery receipt and optionally submit it to the escrow contract.
 *
 * @throws {Error} if the receipt fields are invalid.
 * @throws {Error} if the configured signer is unavailable.
 */
export async function signDeliveryReceipt(
  input: OracleDeliveryReceiptInput,
  options: OracleSignOptions = {}
): Promise<OracleSignedDeliveryReceipt | OracleSubmitReceiptResult> {
  const payload = buildCanonicalDeliveryPayload(input);
  const payloadHash = canonicalPayloadHash(payload);

  const signer = getOracleSigner();
  const publicKey = await signer.getPublicKey();
  const signatureBuf = await signer.sign(payload);
  const signature = signatureBuf.toString("hex");

  const signedAt = new Date().toISOString();
  const receipt: OracleSignedDeliveryReceipt = {
    escrowId: input.escrowId,
    trackingNumber: input.trackingNumber,
    carrier: input.carrier,
    deliveredAt: input.deliveredAt,
    oraclePublicKey: publicKey,
    signature,
    signedPayloadHash: payloadHash,
    signedAt,
  };

  log.info("Oracle signed delivery receipt", {
    escrowId: input.escrowId.toString(),
    trackingNumber: input.trackingNumber,
    carrier: input.carrier,
    provider: signer.provider,
    keyId: signer.keyId,
    signedPayloadHash: payloadHash,
  });

  if (options.submitToContract) {
    return submitSignedReceipt(receipt, signer);
  }
  return receipt;
}

/**
 * Verify a receipt signature locally against the receipt's oraclePublicKey.
 * Useful before trusting a receipt that arrived out-of-band.
 */
export async function verifyDeliveryReceipt(
  receipt: OracleSignedDeliveryReceipt
): Promise<boolean> {
  const input: OracleDeliveryReceiptInput = {
    escrowId: receipt.escrowId,
    trackingNumber: receipt.trackingNumber,
    carrier: receipt.carrier,
    deliveredAt: receipt.deliveredAt,
    oraclePublicKey: receipt.oraclePublicKey,
  };
  const payload = buildCanonicalDeliveryPayload(input);
  const actualHash = canonicalPayloadHash(payload);
  if (actualHash !== receipt.signedPayloadHash) {
    log.warn("Receipt payload hash mismatch — receipt is tampered", {
      escrowId: receipt.escrowId.toString(),
      expected: receipt.signedPayloadHash,
      actual: actualHash,
    });
    return false;
  }
  const signature = Buffer.from(receipt.signature, "hex");
  if (signature.length !== 64) {
    log.warn("Receipt signature is not 64 bytes", {
      escrowId: receipt.escrowId.toString(),
      length: signature.length,
    });
    return false;
  }
  const { createVerify, createPublicKey } = await import("node:crypto");
  let key: ReturnType<typeof createPublicKey>;
  try {
    key = createPublicKey({
      key: Buffer.from(receipt.oraclePublicKey, "hex"),
      format: "der",
      type: "spki",
    });
  } catch (err) {
    log.warn("Failed to parse oracle public key", {
      escrowId: receipt.escrowId.toString(),
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
  const verify = createVerify("sha256");
  verify.update(payload);
  verify.end();
  return verify.verify(key, signature);
}

/**
 * Submit a signed receipt to the Soroban escrow contract.
 *
 * The contract method is `confirm_delivery_oracle`, which expects the
 * canonical payload bytes and the Ed25519 signature. The contract verifies
 * the signature against its registered oracle public key before releasing.
 */
async function submitSignedReceipt(
  receipt: OracleSignedDeliveryReceipt,
  signer: OracleKeySigner
): Promise<OracleSubmitReceiptResult> {
  const contractId = getEscrowContractId();
  const payload = buildCanonicalDeliveryPayload({
    escrowId: receipt.escrowId,
    trackingNumber: receipt.trackingNumber,
    carrier: receipt.carrier,
    deliveredAt: receipt.deliveredAt,
    oraclePublicKey: receipt.oraclePublicKey,
  });
  const signature = Buffer.from(receipt.signature, "hex");

  // Defer the contract-client import so the oracle service can be used
  // standalone (e.g. for key management) without a configured wallet.
  const { submitContractInvocation } = await import("../escrowCoordinator/contractClient.js");

  const tx = await submitContractInvocation({
    sourceAddress: process.env.ORACLE_CALLER_ADDRESS ?? process.env.ESCROW_AUTO_RELEASE_CALLER_ADDRESS ?? "",
    contractId,
    method: "confirm_delivery_oracle",
    args: [
      receipt.escrowId.toString(),
      receipt.trackingNumber,
      receipt.carrier,
      receipt.deliveredAt.toString(),
      receipt.oraclePublicKey,
      receipt.signature,
    ],
    memo: `Oracle delivery receipt for escrow ${receipt.escrowId.toString()}`,
  });

  const status = tx.success ? "released" : "failed";
  return {
    receipt,
    txHash: tx.hash,
    ledger: tx.ledger,
    status,
  };
}

/** Build a typed {@link OracleSigningError} from an unknown error. */
export function toOracleSigningError(err: unknown): OracleSigningError {
  const message = err instanceof Error ? err.message : "Unknown oracle signing error";
  return new OracleSigningError(message);
}
