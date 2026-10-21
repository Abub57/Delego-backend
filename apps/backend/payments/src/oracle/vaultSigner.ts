/**
 * Issue #369 — HashiCorp Vault Transit Ed25519 signer.
 *
 * Uses the Vault Transit engine's `sign` endpoint with an Ed25519 key.
 * The private key material never leaves the Vault HSM/appliance: only the
 * sign request is sent over the network and only the raw signature is
 * returned. The matching public key is read from the Transit key metadata.
 *
 * This module carries no hard dependency on the `node-vault` client: it
 * speaks the Vault HTTP API directly via `fetch`.
 */

import { createLogger } from "@delegolabs/utils";
import type { OracleKeyProvider, OracleKeySigner, OraclePublicKey } from "./keyProvider.js";

const log = createLogger("payments:oracle:vault", process.env.LOG_LEVEL ?? "info");

export interface VaultOracleSignerConfig {
  /** Vault transit key name (must be an ed25519 key). */
  keyId: string;
  /** Vault base URL, e.g. https://vault.example.com:8200. */
  addr?: string;
  /** Vault token (or set VAULT_TOKEN). */
  token?: string;
  /** Transit mount path (default: transit). */
  mount?: string;
  /** Optional fetch implementation (for tests). */
  fetchImpl?: typeof fetch;
}

interface VaultSignResponse {
  data?: {
    signature?: string;
    key_version?: number;
  };
}

interface VaultReadKeyResponse {
  data?: {
    type?: string;
    algorithm?: string;
    public_key?: string;
    key_version?: number;
  };
}

/**
 * Ed25519 signer backed by the Vault Transit engine.
 *
 * The Vault key must be created with `type=ed25519` and
 * `exportableSigning_key=false` (default) so the private key never leaves
 * the Vault security boundary.
 */
export class VaultOracleKeySigner implements OracleKeySigner {
  readonly provider = "vault" as const;
  private readonly addr: string;
  private readonly token: string;
  private readonly mount: string;
  private readonly fetchImpl: typeof fetch;
  private readonly _keyId: string;
  private publicKeyCache: OraclePublicKey | null = null;

  constructor(config: VaultOracleSignerConfig) {
    if (!config.keyId || typeof config.keyId !== "string" || !config.keyId.trim()) {
      throw new Error("Vault transit key name is required");
    }
    this._keyId = config.keyId.trim();
    this.addr = (config.addr ?? process.env.VAULT_ADDR ?? "").replace(/\/$/, "");
    this.token = config.token ?? process.env.VAULT_TOKEN ?? "";
    this.mount = config.mount ?? process.env.VAULT_TRANSIT_MOUNT ?? "transit";
    this.fetchImpl = config.fetchImpl ?? fetch;

    if (!this.addr) {
      throw new Error("VAULT_ADDR is required for the Vault oracle signer");
    }
    if (!this.token) {
      throw new Error("VAULT_TOKEN is required for the Vault oracle signer");
    }
  }

  get keyId(): string {
    return this._keyId;
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: Record<string, unknown>): Promise<T> {
    const response = await this.fetchImpl(`${this.addr}${path}`, {
      method,
      headers: {
        "X-Vault-Token": this.token,
        "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const payload = (await response.json().catch(() => ({}))) as T & { errors?: string[] };
    if (!response.ok) {
      const message =
        typeof payload?.errors?.[0] === "string"
          ? payload.errors[0]
          : `Vault request failed with status ${response.status}`;
      throw new Error(`Vault transit error: ${message}`);
    }
    return payload;
  }

  async getPublicKey(): Promise<OraclePublicKey> {
    if (this.publicKeyCache) return this.publicKeyCache;
    const path = `/v1/${this.mount}/keys/${encodeURIComponent(this._keyId)}`;
    const response = await this.request<VaultReadKeyResponse>("GET", path);
    const pub = response?.data?.public_key;
    if (typeof pub !== "string" || !pub) {
      throw new Error("Vault transit key has no public_key — is it an ed25519 key?");
    }
    this.publicKeyCache = pub;
    return this.publicKeyCache;
  }

  async sign(payload: Buffer): Promise<Buffer> {
    const path = `/v1/${this.mount}/sign/${encodeURIComponent(this._keyId)}`;
    const response = await this.request<VaultSignResponse>("POST", path, {
      input: Buffer.from(payload).toString("base64"),
    });
    const signature = response?.data?.signature;
    if (typeof signature !== "string" || !signature) {
      throw new Error("Vault transit sign returned no signature");
    }
    // Vault returns signatures in `vault:v1:<hex>` format — strip the prefix.
    const hex = signature.replace(/^vault:\d+:/, "");
    return Buffer.from(hex, "hex");
  }

  async verify(payload: Buffer, signature: Buffer): Promise<boolean> {
    const { createVerify, createPublicKey } = await import("node:crypto");
    const pubHex = await this.getPublicKey();
    // Vault stores the public key as a PEM or raw hex; try both.
    let key: ReturnType<typeof createPublicKey>;
    try {
      key = createPublicKey({ key: Buffer.from(pubHex, "hex"), format: "der", type: "spki" });
    } catch {
      key = createPublicKey(pubHex);
    }
    const verify = createVerify("sha256");
    verify.update(payload);
    verify.end();
    return verify.verify(key, signature);
  }
}
