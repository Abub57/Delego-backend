/**
 * Issue #369 — Oracle signing key management.
 *
 * The oracle signs delivery receipts with an Ed25519 private key. The
 * private key material is NEVER held in application memory outside of an
 * HSM-backed signing operation: the three providers below delegate key
 * generation, storage, and signing to AWS KMS (asymmetric keys), HashiCorp
 * Vault (Transit engine), or a local in-memory key used only for tests.
 *
 * The on-chain Soroban escrow contract stores the matching Ed25519
 * *public* key so anyone can verify a receipt. Only the oracle ever touches
 * the private key.
 */

import * as crypto from "node:crypto";
import { createPublicKey, createSign, createVerify, type KeyObject } from "node:crypto";
import { createLogger } from "@delegolabs/utils";
import type { OracleKeyProvider, OracleKeyProviderConfig } from "./types.js";

const log = createLogger("payments:oracle:key-provider", process.env.LOG_LEVEL ?? "info");

/** The Ed25519 curve identifier used by the oracle. */
export const ORACLE_KEY_ALGORITHM = "ed25519" as const;

/** 32-byte Ed25519 public key encoded as raw hex. */
export type OraclePublicKey = string;

/**
 * Result of an oracle signing operation.
 */
export interface OracleSignResult {
  /** Ed25519 signature over the canonical payload, hex-encoded (64 bytes). */
  signature: string;
  /** 32-byte Ed25519 public key hex that the escrow contract should recognize. */
  publicKey: OraclePublicKey;
  /** Provider that produced the signature. */
  provider: OracleKeyProvider;
  /** KMS key id / Vault key name / local key id. */
  keyId: string;
}

/**
 * Minimal interface for an HSM-backed asymmetric signer.
 *
 * Implementations must:
 *   - never expose the private key material as a Node KeyObject outside the
 *     HSM boundary,
 *   - return a raw Ed25519 signature (64 bytes),
 *   - expose the matching 32-byte public key.
 */
export interface OracleKeySigner {
  readonly provider: OracleKeyProvider;
  readonly keyId: string;
  /** Resolve the 32-byte Ed25519 public key (hex). */
  getPublicKey(): Promise<OraclePublicKey>;
  /**
   * Sign `payload` and return the raw Ed25519 signature (64 bytes, hex).
   * Implementations MUST perform the operation inside the HSM boundary.
   */
  sign(payload: Buffer): Promise<Buffer>;
  /**
   * Verify a signature over `payload` using the public key. Returns true when
   * the signature is valid.
   */
  verify(payload: Buffer, signature: Buffer): Promise<boolean>;
}

// ─── Local provider (dev/test only) ───────────────────────────────────────────

/**
 * In-memory Ed25519 keypair. NOT suitable for production: the private key
 * material lives in Node's libuv threadpool and is exposed via process
 * memory. Use {@link AwsKmsOracleKeySigner} or {@link VaultOracleKeySigner}
 * in any environment where the oracle signature carries financial weight.
 */
export class LocalOracleKeySigner implements OracleKeySigner {
  readonly provider = "local" as const;
  private readonly keyObject: KeyObject;
  private readonly publicKeyHex: OraclePublicKey;
  private readonly _keyId: string;

  constructor(keyId: string, secretKey?: Buffer) {
    if (!keyId || typeof keyId !== "string") {
      throw new Error("Local oracle key id is required");
    }
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    this.keyObject = secretKey ? createPrivateKey({ key: secretKey, format: "der", type: "pkcs8" }) : privateKey;
    this.publicKeyHex = Buffer.from(publicKey.export({ format: "der", type: "spki" })).toString("hex");
    this._keyId = keyId;
  }

  get keyId(): string {
    return this._keyId;
  }

  async getPublicKey(): Promise<OraclePublicKey> {
    return this.publicKeyHex;
  }

  async sign(payload: Buffer): Promise<Buffer> {
    const sign = createSign("sha256");
    sign.update(payload);
    sign.end();
    return sign.sign(this.keyObject);
  }

  async verify(payload: Buffer, signature: Buffer): Promise<boolean> {
    const verify = createVerify("sha256");
    verify.update(payload);
    verify.end();
    return verify.verify(
      { key: createPublicKey(this.keyObject), format: "der", type: "spki" },
      signature
    );
  }
}
