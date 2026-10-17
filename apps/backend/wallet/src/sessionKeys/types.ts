/**
 * Session Key Delegation types.
 * Closes #282
 */

export interface SignWithSessionKeyDTO {
  sessionPublicKey: string;
  contractCallXdr: string;
  requestedAmountStroops: string;
}

export interface SessionKeyRecord {
  sessionPublicKey: string;
  userId: string;
  encryptedPrivateKey: string;
  vaultKeyPath: string;
  spendingLimitStroops: string;
  spentAmountStroops: string;
  expiresAt: number;
  createdAt: string;
  policy: SessionKeyPolicy;
}

export interface SessionKeyPolicy {
  allowedContracts: string[];
  allowedMethods: string[];
  maxPerCallStroops: string;
  maxTotalStroops: string;
  expiresInSeconds: number;
}

export interface SignResult {
  success: boolean;
  signedTxXdr?: string;
  signature?: string;
  remainingBudgetStroops?: string;
  error?: string;
}

/**
 * A node-local, bounded-TTL cache entry for session-key revocation status.
 * Closes #344 — see sessionKeyCache.ts for why the 5-second cap on
 * `cachedAt` staleness exists.
 *
 * Note: session keys in this codebase are currently tracked by a Unix
 * epoch expiry (`SessionKeyRecord.expiresAt`), not a Soroban ledger
 * sequence number. `expiresAtLedger` carries that same epoch-seconds value
 * until ledger-sequence-based expiry tracking is wired in.
 */
export interface SessionKeyCacheEntry {
  keyId: string;
  publicKey: string;
  ownerAddress: string;
  expiresAtLedger: number;
  isRevoked: boolean;
  cachedAt: number;
}
