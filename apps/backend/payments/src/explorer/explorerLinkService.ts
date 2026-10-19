/**
 * Explorer Link Service (Issue #explorer-links)
 *
 * Generates canonical, network-aware Stellar Expert and Horizon explorer
 * URLs for contract deployments, transaction hashes, and smart account
 * addresses to provide seamless ledger auditability in API responses.
 */

import { createLogger } from "@delegolabs/utils";

const log = createLogger("payments:explorer-links", process.env.LOG_LEVEL ?? "info");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type StellarNetwork = "testnet" | "mainnet" | "futurenet";

export interface ExplorerLinkSet {
  network: StellarNetwork;
  txUrl: string;
  accountUrl: string;
  contractUrl: string;
}

/** Base URL configuration for a Stellar network. */
interface NetworkConfig {
  horizonBaseUrl: string;
  expertBaseUrl: string;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const TX_HASH_REGEX = /^[0-9a-fA-F]{64}$/;

/**
 * Validates a Stellar transaction hash format.
 * @throws Error if the hash does not match the expected 64-char hex pattern.
 */
export function validateTxHash(txHash: string): void {
  if (!TX_HASH_REGEX.test(txHash)) {
    throw new Error(
      `Invalid transaction hash: "${txHash}". Expected a 64-character hexadecimal string.`
    );
  }
}

// ---------------------------------------------------------------------------
// Network configurations
// ---------------------------------------------------------------------------

const NETWORK_CONFIGS: Record<StellarNetwork, NetworkConfig> = {
  mainnet: {
    horizonBaseUrl: "https://horizon.stellar.org",
    expertBaseUrl: "https://stellar.expert/explorer/public",
  },
  testnet: {
    horizonBaseUrl: "https://horizon-testnet.stellar.org",
    expertBaseUrl: "https://stellar.expert/explorer/testnet",
  },
  futurenet: {
    horizonBaseUrl: "https://horizon-futurenet.stellar.org",
    expertBaseUrl: "https://stellar.expert/explorer/futurenet",
  },
};

// ---------------------------------------------------------------------------
// ExplorerLinkService
// ---------------------------------------------------------------------------

export class ExplorerLinkService {
  private readonly network: StellarNetwork;
  private readonly config: NetworkConfig;

  constructor(network?: StellarNetwork) {
    this.network = network ?? this.detectNetwork();
    this.config = this.resolveConfig(this.network);
    log.info("ExplorerLinkService initialized", { network: this.network });
  }

  /** Detect the active network from environment variables. */
  private detectNetwork(): StellarNetwork {
    const env = (process.env.STELLAR_NETWORK ?? "testnet").toLowerCase();
    if (env === "mainnet" || env === "public") return "mainnet";
    if (env === "futurenet") return "futurenet";
    return "testnet";
  }

  /** Override network config via environment variables for self-hosted explorers. */
  private resolveConfig(network: StellarNetwork): NetworkConfig {
    const defaults = NETWORK_CONFIGS[network];
    return {
      horizonBaseUrl:
        process.env.HORIZON_BASE_URL ?? defaults.horizonBaseUrl,
      expertBaseUrl:
        process.env.STELLAR_EXPERT_BASE_URL ?? defaults.expertBaseUrl,
    };
  }

  /**
   * Builds a full ExplorerLinkSet for a given transaction, account, and
   * contract address triple. The txHash is validated before use.
   *
   * @param txHash          64-char hex Stellar transaction hash.
   * @param accountAddress  Stellar G-address (account).
   * @param contractAddress Soroban contract address (C-address or account ID).
   */
  buildLinkSet(
    txHash: string,
    accountAddress: string,
    contractAddress: string
  ): ExplorerLinkSet {
    validateTxHash(txHash);

    const { expertBaseUrl } = this.config;

    const linkSet: ExplorerLinkSet = {
      network: this.network,
      txUrl: `${expertBaseUrl}/tx/${txHash}`,
      accountUrl: `${expertBaseUrl}/account/${accountAddress}`,
      contractUrl: `${expertBaseUrl}/contract/${contractAddress}`,
    };

    log.info("Explorer links generated", { network: this.network, txHash });

    return linkSet;
  }

  /**
   * Returns the Horizon REST API URL for a given transaction hash.
   * Useful for programmatic ledger lookups alongside the human-readable
   * explorer URLs.
   */
  horizonTxUrl(txHash: string): string {
    validateTxHash(txHash);
    return `${this.config.horizonBaseUrl}/transactions/${txHash}`;
  }

  /** Returns the Horizon REST API URL for an account. */
  horizonAccountUrl(address: string): string {
    return `${this.config.horizonBaseUrl}/accounts/${address}`;
  }

  /** Returns the active network label. */
  getNetwork(): StellarNetwork {
    return this.network;
  }
}

// ---------------------------------------------------------------------------
// Singleton factory
// ---------------------------------------------------------------------------

let _instance: ExplorerLinkService | null = null;

export function getExplorerLinkService(): ExplorerLinkService {
  if (!_instance) {
    _instance = new ExplorerLinkService();
  }
  return _instance;
}

/** Reset the singleton — useful in tests. */
export function _resetExplorerLinkService(): void {
  _instance = null;
}

// ---------------------------------------------------------------------------
// Convenience helper — inject into order / payment API response objects
// ---------------------------------------------------------------------------

export interface WithExplorerLinks {
  explorerLinks?: ExplorerLinkSet;
}

/**
 * Enriches any order or payment response object with explorer links when
 * a transaction hash is present.
 *
 * @param response        The response object to enrich (mutated in-place).
 * @param txHash          Optional tx hash — links are omitted if absent or invalid.
 * @param accountAddress  Stellar address of the buyer or escrow account.
 * @param contractAddress Contract (escrow) address.
 */
export function injectExplorerLinks<T extends WithExplorerLinks>(
  response: T,
  txHash: string | null | undefined,
  accountAddress: string,
  contractAddress: string
): T {
  if (!txHash) return response;

  try {
    response.explorerLinks = getExplorerLinkService().buildLinkSet(
      txHash,
      accountAddress,
      contractAddress
    );
  } catch (err) {
    // Log and skip — never fail an API response because of a bad URL.
    log.warn("Failed to inject explorer links", {
      txHash,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return response;
}
