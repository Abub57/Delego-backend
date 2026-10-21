/**
 * Stellar / Soroban asset management primitives
 * Issue #108 — comprehensive asset management
 */

export type AssetType =
  | "native"
  | "credit_alphanum4"
  | "credit_alphanum12"
  | "liquidity_pool";

export interface AssetMetadata {
  name: string;
  symbol: string;
  decimals: number;
  logo?: string;
  description?: string;
  website?: string;
}

export interface AssetFlags {
  authRequired: boolean;
  authRevocable: boolean;
  authImmutable: boolean;
}

export interface Asset {
  code: string;
  issuer: string;
  type: AssetType;
  /** Soroban contract ID when the asset is backed by a Stellar Asset Contract. */
  contractId?: string;
  metadata: AssetMetadata;
  flags: AssetFlags;
}

export interface Trustline {
  account: string;
  asset: Asset;
  /** Trustline limit in stroops. */
  limit: string;
  /** Current balance held on the trustline in stroops. */
  balance: string;
  authorized: boolean;
  authorizedToMaintainLiabilities: boolean;
  clawbackEnabled: boolean;
}

export interface AssetBalance {
  asset: Asset;
  /** Total balance in stroops. */
  balance: string;
  /** Spendable balance (total minus buying liabilities) in stroops. */
  available: string;
  /** Locked balance (buying liabilities) in stroops. */
  locked: string;
  trustline?: Trustline;
  /** ISO 8601 timestamp of the last update. */
  lastUpdated: string;
}

export interface Portfolio {
  account: string;
  /** Native XLM balance in stroops. */
  nativeBalance: string;
  assetBalances: AssetBalance[];
  /** Optional US~ value when a price source is configured. */
  totalValueUSD?: string;
  /** ISO 8601 timestamp of the last update. */
  lastUpdated: string;
}

export interface SpamFilterSettings {
  enabled: boolean;
  /** Filter assets with no public SEP-1 metadata / issuer website. */
  filterUnlisted: boolean;
  /** Assets that are always allowed: "XLM" or "CODE:ISSUER". */
  allowlist: string[];
  /** Assets that are always filtered: "CODE:ISSUER". */
  blocklist: string[];
}

/**
 * Canonical reference to a Stellar asset used across the asset API:
 * "XLM" for native, "CODE:ISSUER" for credit assets, "LP:POOL_ID" for pool shares.
 */
export interface AssetReference {
  code: string;
  issuer: string;
  type: AssetType;
}

export interface TrustlineChangeRequest {
  account: string;
  asset: AssetReference;
  /** Limit in stroops. Omit / empty on create when both hold the asset. */
  limit?: string;
}

export interface TrustlineAuthRequest {
  /** Account whose trustline is being (un)authorized — the issuer acts. */
  account: string;
  asset: AssetReference;
  authorized: boolean;
  authorizedToMaintainLiabilities?: boolean;
  clawbackEnabled?: boolean;
}

/**
 * Result of a pre-flight trustline verification check — Issue #594.
 */
export interface TrustlineCheckResult {
  account: string;
  assetCode: string;
  assetIssuer: string;
  trustlineEstablished: boolean;
  authorized: boolean;
  currentBalance: string;
  creditLimit: string;
}


export interface AssetTransferRequest {
  sourceAddress: string;
  destination: string;
  asset: AssetReference;
  /** Amount in stroops (integer) for classic assets. */
  amountStroops: string;
  memo?: string;
  /** Soroban token contract ID — required when sending a SAC asset transfer. */
  contractId?: string;
  /** Microsoft deprecation guard: when set, the amount uses the token decimals. */
  amountWithDecimals?: string;
}

export interface AssetTransferResult {
  hash: string;
  success: boolean;
  ledger?: number;
  /** ISO 8601 timestamp of the submission. */
  submittedAt: string;
}

export interface PathPaymentRequest {
  sourceAddress: string;
  destination: string;
  /** Asset to send, in stroops. */
  sendAsset: AssetReference;
  sendAmountStroops: string;
  /** Asset the destination receives, in stroops. */
  destAsset: AssetReference;
  destMinAmountStroops: string;
  /** Optional intermediate assets for the path. */
  path?: AssetReference[];
  memo?: string;
}

export interface AssetDiscoveryRequest {
  code: string;
  issuer?: string;
  type?: AssetType;
  contractId?: string;
}