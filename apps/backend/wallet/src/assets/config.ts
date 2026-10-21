/**
 * Asset service configuration — Issue #108.
 * Centralizes Stellar network resolution and feature flags for the asset
 * management module so every submodule reads from one place.
 */
import { Networks } from "@stellar/stellar-sdk";
import type { StellarNetwork } from "@delegolabs/types";
import { isMockModeEnabled } from "../../stellar/mockHorizon.js";

export interface StellarConfig {
  network: StellarNetwork;
  horizonUrl: string;
  rpcUrl: string;
  networkPassphrase: string;
  mockMode?: boolean;
}

export function getStellarConfig(): StellarConfig {
  const network = (process.env.STELLAR_NETWORK ?? "testnet").toLowerCase() as StellarNetwork;

  // Return mock config early if mock mode is enabled
  if (isMockModeEnabled()) {
    return {
      network: "testnet",
      horizonUrl: "mock://horizon",
      rpcUrl: "mock://soroban-rpc",
      networkPassphrase: Networks.TESTNET,
      mockMode: true,
    };
  }

  let horizonUrl = "https://horizon-testnet.stellar.org";
  let rpcUrl = "https://soroban-testnet.stellar.org";
  let networkPassphrase = Networks.TESTNET;

  if (network === "mainnet") {
    horizonUrl = process.env.STELLAR_HORIZON_URL ?? "https://horizon.stellar.org";
    rpcUrl = process.env.STELLAR_RPC_URL ?? "https://rpc.stellar.org";
    networkPassphrase = Networks.PUBLIC;
  } else if (network === "futurenet") {
    horizonUrl = process.env.STELLAR_HORIZON_URL ?? "https://horizon-futurenet.stellar.org";
    rpcUrl = process.env.STELLAR_RPC_URL ?? "https://rpc-futurenet.stellar.org";
    networkPassphrase = Networks.FUTURENET;
  }

  return { network, horizonUrl, rpcUrl, networkPassphrase, mockMode: false };
}

export interface AssetServiceConfig {
  /** TTL for cached SEP-1 metadata (seconds). */
  metadataCacheTtlSeconds: number;
  /** Interval between real-time balance poll cycles (seconds). */
  balancePollIntervalSeconds: number;
  /** TTL for the redis portfolio cache (seconds). Keeps the portfolio API < 200ms. */
  portfolioCacheSeconds: number;
  /** Master switch for spam asset filtering. */
  spamFilterEnabled: boolean;
  /** Filter assets with no public SEP-1 metadata when true. */
  spamFilterUnlisted: boolean;
  /** Always-allowed assets: "XLM" or "CODE:ISSUER". */
  spamAllowlist: string[];
  /** Always-filtered assets: "CODE:ISSUER". */
  spamBlocklist: string[];
  /** Max balances reported before the spam filter kicks in on the portfolio. */
  maxBalances: number;
}

export function readAssetServiceConfig(): AssetServiceConfig {
  const toList = (raw: string | undefined): string[] =>
    (raw ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

  return {
    metadataCacheTtlSeconds: parseInt(process.env.ASSET_METADATA_CACHE_TTL_SECONDS ?? "3600", 10),
    balancePollIntervalSeconds: parseInt(process.env.ASSET_BALANCE_POLL_INTERVAL_SECONDS ?? "30", 10),
    portfolioCacheSeconds: parseInt(process.env.ASSET_PORTFOLIO_CACHE_SECONDS ?? "5", 10),
    spamFilterEnabled: process.env.ASSET_SPAM_FILTER_ENABLED !== "false",
    spamFilterUnlisted: process.env.ASSET_SPAM_FILTER_UNLISTED === "true",
    spamAllowlist: toList(process.env.ASSET_SPAM_ALLOWLIST),
    spamBlocklist: toList(process.env.ASSET_SPAM_BLOCKLIST),
    maxBalances: parseInt(process.env.ASSET_MAX_BALANCES ?? "500", 10),
  };
}