/**
 * Proof-of-Delivery Hash Anchor (Issue #298).
 *
 * Computes a SHA-256 digest over the delivery receipt data (tracking number +
 * carrier code) and anchors it permanently on the Stellar ledger by passing
 * the hash as an argument to the Soroban escrow contract's
 * `release_with_proof` method.
 *
 * The 32-byte hash is stored as a `BytesN<32>` contract argument so it can
 * be independently verified by any party with access to the original receipt
 * fields: `SHA-256(trackingNumber + ":" + carrierCode)`.
 */

import { createHash } from "node:crypto";
import { createLogger } from "@delegolabs/utils";
import { submitContractInvocation } from "../escrowCoordinator/contractClient.js";
import {
  getAutoReleaseCallerAddress,
  getEscrowContractId,
} from "../../escrow/config.js";
import type { DeliveryProof } from "../autoRelease/types.js";

const log = createLogger(
  "payments:oracle:anchor",
  process.env.LOG_LEVEL ?? "info"
);

/** On-chain proof anchor returned after a successful `release_with_proof` call. */
export interface OnChainProofAnchor {
  /** Numeric string matching the Soroban escrow record's `escrow_id`. */
  escrowId: string;
  /** Lowercase hex-encoded SHA-256 digest (64 characters, 32 bytes). */
  proofHashSha256: string;
  /** Carrier code extracted from the delivery proof. */
  carrierCode: string;
}

/** Result of anchoring a proof and releasing the escrow on-chain. */
export interface AnchorProofResult {
  anchor: OnChainProofAnchor;
  txHash: string;
  ledger: number;
  status: "released" | "failed";
}

/**
 * Computes `SHA-256(trackingNumber + ":" + carrierCode)`.
 *
 * The colon separator is a stable, unambiguous delimiter — neither tracking
 * numbers nor carrier codes contain colons in standard formats.  Using a
 * canonical separator prevents a pre-image collision where a different pair
 * of values could produce the same concatenated byte sequence.
 *
 * Both fields are trimmed and lower-cased before hashing so the digest is
 * insensitive to leading/trailing whitespace and capitalisation differences
 * in carrier receipts.
 *
 * @returns A 32-byte `Buffer` (digest in raw binary, suitable for Soroban
 *          `BytesN<32>` encoding via `nativeToScVal`).
 */
export function computeDeliveryProofHash(
  trackingNumber: string,
  carrierCode: string
): Buffer {
  const canonical = `${trackingNumber.trim().toLowerCase()}:${carrierCode.trim().toLowerCase()}`;
  return createHash("sha256").update(canonical, "utf8").digest();
}

/**
 * Derives the pre-image fields from a {@link DeliveryProof}, validates that
 * both required fields are present, and returns the canonical normalised
 * values used for hashing.
 *
 * Throws if either `trackingNumber` or `carrier` is absent — the on-chain
 * anchor is only meaningful when both receipt fields can be verified.
 */
function extractReceiptFields(proof: DeliveryProof): {
  trackingNumber: string;
  carrierCode: string;
} {
  if (!proof.trackingNumber || proof.trackingNumber.trim() === "") {
    throw new Error(
      "DeliveryProof.trackingNumber is required for proof-of-delivery hash anchoring"
    );
  }
  if (!proof.carrier || proof.carrier.trim() === "") {
    throw new Error(
      "DeliveryProof.carrier is required for proof-of-delivery hash anchoring"
    );
  }
  return {
    trackingNumber: proof.trackingNumber.trim(),
    carrierCode: proof.carrier.trim(),
  };
}

/**
 * Anchors a proof-of-delivery hash on the Stellar ledger by invoking the
 * Soroban escrow contract's `release_with_proof` method.
 *
 * The contract receives three positional arguments:
 *   1. `escrow_id`  — `u64` numeric escrow identifier.
 *   2. `caller`     — `Address` of the platform's auto-release account.
 *   3. `proof_hash` — `BytesN<32>` SHA-256 digest of the receipt data.
 *
 * On success the escrow is simultaneously released and the hash is written
 * to contract storage, making it permanently verifiable on the ledger.
 *
 * @param escrowId  - Numeric string identifying the on-chain escrow record.
 * @param proof     - Delivery proof from the webhook payload.
 * @returns         - {@link AnchorProofResult} with the tx hash and anchor metadata.
 */
export async function anchorDeliveryProof(
  escrowId: string,
  proof: DeliveryProof
): Promise<AnchorProofResult> {
  const { trackingNumber, carrierCode } = extractReceiptFields(proof);

  const proofHashBytes = computeDeliveryProofHash(trackingNumber, carrierCode);
  const proofHashSha256 = proofHashBytes.toString("hex");

  const contractId = getEscrowContractId();
  const callerAddress = getAutoReleaseCallerAddress();

  // Soroban `u64` escrow IDs are passed as plain JS numbers; nativeToScVal in
  // submitContractInvocation handles the encoding.
  const escrowIdNum = Number(escrowId);
  if (!Number.isInteger(escrowIdNum) || escrowIdNum < 0) {
    throw new Error(`Invalid escrow ID: ${escrowId}`);
  }

  log.info("Anchoring delivery proof on-chain", {
    escrowId,
    proofHashSha256,
    carrierCode,
    contractId,
  });

  const tx = await submitContractInvocation({
    sourceAddress: callerAddress,
    contractId,
    method: "release_with_proof",
    // Args match the Soroban contract signature:
    //   release_with_proof(escrow_id: u64, caller: Address, proof_hash: BytesN<32>)
    args: [escrowIdNum, callerAddress, proofHashBytes],
    memo: `Proof-of-delivery anchor for escrow ${escrowId}`,
  });

  const anchor: OnChainProofAnchor = {
    escrowId,
    proofHashSha256,
    carrierCode,
  };

  if (!tx.success) {
    log.error("release_with_proof transaction failed on-chain", {
      escrowId,
      proofHashSha256,
      txHash: tx.hash,
    });
    return { anchor, txHash: tx.hash, ledger: tx.ledger, status: "failed" };
  }

  log.info("Delivery proof anchored and escrow released", {
    escrowId,
    proofHashSha256,
    carrierCode,
    txHash: tx.hash,
    ledger: tx.ledger,
  });

  return { anchor, txHash: tx.hash, ledger: tx.ledger, status: "released" };
}
