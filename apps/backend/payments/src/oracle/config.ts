/**
 * Issue #369 — Oracle signer configuration.
 *
 * Reads environment variables and constructs the configured
 * {@link OracleKeySigner}. The provider is selected via
 * `ORACLE_KEY_PROVIDER` (one of `local` | `aws_kms` | `vault`).
 *
 * The oracle public key is registered with the Soroban escrow contract at
 * deploy time; the same key must be resolvable by the signer at runtime.
 */

import { createLogger } from "@delegolabs/utils";
import type { OracleKeyProvider, OracleKeySigner } from "./keyProvider.js";
import { LocalOracleKeySigner } from "./keyProvider.js";
import { AwsKmsOracleKeySigner } from "./awsKmsSigner.js";
import { VaultOracleKeySigner } from "./vaultSigner.js";

const log = createLogger("payments:oracle:config", process.env.LOG_LEVEL ?? "info");

export const DEFAULT_ORACLE_PROVIDER: OracleKeyProvider = "local";

export interface OracleSignerConfig {
  provider: OracleKeyProvider;
  keyId?: string;
  region?: string;
  vaultAddr?: string;
  vaultToken?: string;
  vaultMount?: string;
}

/**
 * Resolve the oracle signer from the environment.
 *
 * Required env vars per provider:
 *   - local:  ORACLE_KEY_ID (optional; a fresh keypair is generated when absent)
 *   - aws_kms: ORACLE_KEY_ID (alias/ARN), AWS_REGION (optional)
 *   - vault:  ORACLE_KEY_ID, VAULT_ADDR, VAULT_TOKEN, VAULT_TRANSIT_MOUNT (optional)
 */
export function getOracleSignerConfig(): OracleSignerConfig {
  const provider = (process.env.ORACLE_KEY_PROVIDER ?? DEFAULT_ORACLE_PROVIDER) as OracleKeyProvider;
  if (provider !== "local" && provider !== "aws_kms" && provider !== "vault") {
    throw new Error(
      `Unsupported ORACLE_KEY_PROVIDER: ${provider}. Expected one of: local, aws_kms, vault`
    );
  }
  return {
    provider,
    keyId: process.env.ORACLE_KEY_ID,
    region: process.env.AWS_REGION,
    vaultAddr: process.env.VAULT_ADDR,
    vaultToken: process.env.VAULT_TOKEN,
    vaultMount: process.env.VAULT_TRANSIT_MOUNT,
  };
}

let cachedSigner: OracleKeySigner | null = null;

/**
 * Build (and cache) the configured oracle signer.
 *
 * The signer is constructed lazily and cached for the lifetime of the
 * process so the HSM client is only initialized once.
 */
export function getOracleSigner(): OracleKeySigner {
  if (cachedSigner) return cachedSigner;

  const config = getOracleSignerConfig();
  log.info("Initializing oracle signer", { provider: config.provider, keyId: config.keyId });

  switch (config.provider) {
    case "local": {
      const keyId = config.keyId ?? `oracle-local-${Date.now().toString(36)}`;
      cachedSigner = new LocalOracleKeySigner(keyId);
      break;
    }
    case "aws_kms": {
      if (!config.keyId) {
        throw new Error("ORACLE_KEY_ID is required for the aws_kms oracle provider");
      }
      cachedSigner = new AwsKmsOracleKeySigner({
        keyId: config.keyId,
        region: config.region,
      });
      break;
    }
    case "vault": {
      if (!config.keyId) {
        throw new Error("ORACLE_KEY_ID is required for the vault oracle provider");
      }
      cachedSigner = new VaultOracleKeySigner({
        keyId: config.keyId,
        addr: config.vaultAddr,
        token: config.vaultToken,
        mount: config.vaultMount,
      });
      break;
    }
    default: {
      throw new Error(`Unsupported oracle provider: ${String(config.provider)}`);
    }
  }

  return cachedSigner;
}

/** Reset the cached signer (used by tests). */
export function resetOracleSigner(): void {
  cachedSigner = null;
}
