/**
 * Issue #369 — AWS KMS Ed25519 signer.
 *
 * Uses an AWS KMS asymmetric key (KeySpec = ED25519) to sign delivery
 * receipts. The private key never leaves the KMS HSM boundary: only the
 * Sign API is invoked, and only the raw signature + public key are returned.
 *
 * The matching public key is fetched via GetPublicKey so the on-chain
 * Soroban escrow contract can be registered with the same key.
 *
 * This module carries no hard dependency on @aws-sdk/client-kms: the SDK
 * is imported lazily so the rest of the payments service boots without it.
 */

import { createLogger } from "@delegolabs/utils";
import type { OracleKeyProvider, OracleKeySigner, OraclePublicKey } from "./keyProvider.js";

const log = createLogger("payments:oracle:aws-kms", process.env.LOG_LEVEL ?? "info");

type KmsSignerCtor = {
  region?: string;
  /** KMS key id (alias name, alias ARN, key ARN, or key ID). */
  keyId: string;
};

type KmsSdkModule = {
  KMSClient: new (config: { region?: string }) => {
    send(command: unknown): Promise<unknown>;
  };
  GetPublicKeyCommand: new (input: { KeyId: string }) => unknown;
  SignCommand: new (input: {
    KeyId: string;
    Message: Uint8Array;
    SigningAlgorithm: string;
    MessageType: string;
  }) => unknown;
};

let kmsSdkPromise: Promise<KmsSdkModule> | null = null;

function loadKmsSdk(): Promise<KmsSdkModule> {
  if (!kmsSdkPromise) {
    kmsSdkPromise = import("@aws-sdk/client-kms")
      .then((m) => m as unknown as KmsSdkModule)
      .catch(() => {
        throw new Error(
          "AWS KMS oracle signer requires @aws-sdk/client-kms to be installed"
        );
      });
  }
  return kmsSdkPromise;
}

/** AWS SDK v3 Sign response shape (subset we use). */
interface SignResponse {
  Signature?: Uint8Array;
}

/** AWS SDK v3 GetPublicKey response shape (subset we use). */
interface GetPublicKeyResponse {
  PublicKey?: Uint8Array;
}

/**
 * Ed25519 signer backed by AWS KMS asymmetric keys.
 *
 * SigningAlgorithm for Ed25519 keys is `AWS_KMS_SIG_ALG_ED25519` and the
 * message type is `RAW` (the payload is signed as-is, no digest wrapping).
 */
export class AwsKmsOracleKeySigner implements OracleKeySigner {
  readonly provider = "aws_kms" as const;
  private readonly region: string | undefined;
  private readonly keyId: string;
  private readonly _keyId: string;
  private publicKeyCache: OraclePublicKey | null = null;
  private clientPromise: Promise<KmsSdkModule["KMSClient"]> | null = null;

  constructor(config: KmsSignerCtor) {
    if (!config.keyId || typeof config.keyId !== "string" || !config.keyId.trim()) {
      throw new Error("AWS KMS keyId (alias or ARN) is required");
    }
    this.keyId = config.keyId.trim();
    this._keyId = this.keyId;
    this.region = config.region;
  }

  get keyId(): string {
    return this._keyId;
  }

  private async client(): Promise<KmsSdkModule["KMSClient"]> {
    if (!this.clientPromise) {
      const sdk = await loadKmsSdk();
      this.clientPromise = Promise.resolve(
        new sdk.KMSClient({ region: this.region ?? process.env.AWS_REGION ?? "us-east-1" })
      );
    }
    return this.clientPromise;
  }

  async getPublicKey(): Promise<OraclePublicKey> {
    if (this.publicKeyCache) return this.publicKeyCache;
    const c = await this.client();
    const { GetPublicKeyCommand } = await loadKmsSdk();
    const response = (await c.send(new GetPublicKeyCommand({ KeyId: this.keyId }))) as GetPublicKeyResponse;
    const bytes = response?.PublicKey;
    if (!bytes || bytes.length === 0) {
      throw new Error("AWS KMS GetPublicKey returned no public key bytes");
    }
    this.publicKeyCache = Buffer.from(bytes).toString("hex");
    return this.publicKeyCache;
  }

  async sign(payload: Buffer): Promise<Buffer> {
    const c = await this.client();
    const { SignCommand } = await loadKmsSdk();
    const response = (await c.send(
      new SignCommand({
        KeyId: this.keyId,
        Message: new Uint8Array(payload),
        SigningAlgorithm: "AWS_KMS_SIG_ALG_ED25519",
        MessageType: "RAW",
      })
    )) as SignResponse;
    const signature = response?.Signature;
    if (!signature || signature.length === 0) {
      throw new Error("AWS KMS Sign returned an empty signature");
    }
    return Buffer.from(signature);
  }

  async verify(payload: Buffer, signature: Buffer): Promise<boolean> {
    // KMS does not expose a verify API for asymmetric keys; we verify
    // client-side against the fetched public key using Node's crypto.
    const { createVerify, createPublicKey } = await import("node:crypto");
    const pubHex = await this.getPublicKey();
    const der = Buffer.from(pubHex, "hex");
    const key = createPublicKey({ key: der, format: "der", type: "spki" });
    const verify = createVerify("sha256");
    verify.update(payload);
    verify.end();
    return verify.verify(key, signature);
  }
}
