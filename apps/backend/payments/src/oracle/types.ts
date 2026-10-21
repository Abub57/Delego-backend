/**
 * Issue #369 — Automated Oracle Delivery Receipt Signing
 *
 * Domain types for the oracle service that signs cryptographic delivery
 * receipts using an Ed25519 key recognized by the Soroban escrow contract.
 *
 * The receipt schema below is the contract between the carrier's delivery
 * confirmation event and the oracle: once the oracle signs a receipt, the
 * signature is verifiable against the on-chain oracle public key registered
 * in the escrow contract.
 */

/** Fields the oracle signs. Excludes `signature`, which is the output. */
export interface OracleDeliveryReceiptInput {
  escrowId: bigint;
  trackingNumber: string;
  carrier: string;
  deliveredAt: number;
  oraclePublicKey: string;
}

/** Signed delivery receipt returned by the oracle. */
export interface OracleSignedDeliveryReceipt {
  escrowId: bigint;
  trackingNumber: string;
  carrier: string;
  deliveredAt: number;
  oraclePublicKey: string;
  signature: string; // Ed25519 hex
  /** Hex-encoded SHA-256 of the canonical binary payload that was signed. */
  signedPayloadHash: string;
  /** ISO-8601 timestamp of when the signature was produced. */
  signedAt: string;
}

/** Result of submitting a signed receipt directly to the escrow contract. */
export interface OracleSubmitReceiptResult {
  receipt: OracleSignedDeliveryReceipt;
  txHash: string;
  ledger: number;
  status: "released" | "failed";
}

/** Provider backing the oracle signing key. */
export type OracleKeyProvider = "local" | "aws_kms" | "vault";

export interface OracleKeyProviderConfig {
  provider: OracleKeyProvider;
  /** KMS key id / alias, Vault transit key name, or ignored for local. */
  keyId?: string;
  /** AWS region (KMS). */
  region?: string;
  /** Vault transit mount (default: transit). */
  mount?: string;
  /** Vault addr. */
  addr?: string;
  /** Vault token. */
  token?: string;
}

/** Error raised when the oracle signer is misconfigured. */
export class OracleSigningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OracleSigningError";
  }
}

/** Error raised when a receipt signature fails on-chain verification. */
export class OracleSignatureVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OracleSignatureVerificationError";
  }
}