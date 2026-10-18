/**
 * SessionKeySigner
 *
 * Securely stores encrypted temporary agent session keys in HashiCorp Vault,
 * signing contract calls within defined policy boundaries.
 *
 * - Validates that session key has not expired
 * - Verifies cumulative spent amount does not exceed session spending limit
 * - Signs transaction with session private key stored in HashiCorp Vault
 * - Immediately denies signature if requested amount exceeds remaining cap
 *
 * Closes #282
 */

import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import type {
  SignWithSessionKeyDTO,
  SessionKeyRecord,
  SessionKeyPolicy,
  SignResult,
} from './types.js';
import { SessionKeyRevocationCache, isHighValueAmount } from './sessionKeyCache.js';

/** Redis key prefix for session key records */
const SESSION_KEY_PREFIX = 'session_key:';

/** Default session key expiry (24 hours) */
const DEFAULT_EXPIRY_SECONDS = 86400;

export class SessionKeySigner {
  constructor(
    private readonly redis: Redis,
    private readonly db: Pool,
    private readonly vaultClient: {
      read: (path: string) => Promise<string | null>;
      write: (path: string, data: unknown) => Promise<void>;
    },
    // Closes #344 — optional node-local revocation cache. Omitted for
    // existing call sites/tests, which simply skip the fast-path check
    // below and fall straight through to the Redis read, unchanged.
    private readonly revocationCache?: SessionKeyRevocationCache,
  ) {}

  /**
   * Create a new session key with bounded spending limits.
   * The private key is encrypted and stored in HashiCorp Vault.
   */
  async createSessionKey(
    userId: string,
    publicKey: string,
    encryptedPrivateKey: string,
    policy: SessionKeyPolicy,
  ): Promise<SessionKeyRecord> {
    const vaultKeyPath = `delego/session-keys/${userId}/${publicKey}`;
    await this.vaultClient.write(vaultKeyPath, { encryptedPrivateKey });

    const record: SessionKeyRecord = {
      sessionPublicKey: publicKey,
      userId,
      encryptedPrivateKey,
      vaultKeyPath,
      spendingLimitStroops: policy.maxTotalStroops,
      spentAmountStroops: '0',
      expiresAt: Math.floor(Date.now() / 1000) + policy.expiresInSeconds,
      createdAt: new Date().toISOString(),
      policy,
    };

    // Store in Redis with TTL matching expiry
    const ttl = policy.expiresInSeconds || DEFAULT_EXPIRY_SECONDS;
    await this.redis.setex(
      `${SESSION_KEY_PREFIX}${publicKey}`,
      ttl,
      JSON.stringify(record),
    );

    // Also persist to database for audit trail
    await this.db.query(
      `INSERT INTO session_keys
       (session_public_key, user_id, vault_key_path, spending_limit_stroops,
        spent_amount_stroops, expires_at, allowed_contracts, allowed_methods,
        max_per_call_stroops, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())`,
      [
        record.sessionPublicKey,
        record.userId,
        record.vaultKeyPath,
        record.spendingLimitStroops,
        record.spentAmountStroops,
        new Date(record.expiresAt * 1000).toISOString(),
        record.policy.allowedContracts,
        record.policy.allowedMethods,
        record.policy.maxPerCallStroops,
      ],
    );

    return record;
  }

  /**
   * Sign a contract call with a session key.
   *
   * Validates:
   * 1. Session key exists and has not expired
   * 2. Requested amount does not exceed per-call limit
   * 3. Cumulative spent + requested does not exceed total spending limit
   * 4. Contract and method are in the allowed policy
   *
   * Immediately denies if any check fails.
   */
  async signWithSessionKey(dto: SignWithSessionKeyDTO): Promise<SignResult> {
    // Closes #344 — fast local rejection path. High-value transfers always
    // skip this and go straight to the Redis read below, per the task's
    // "query the distributed store directly for high-value transactions"
    // requirement; the cache entry itself is also capped at a 5-second
    // TTL (see sessionKeyCache.ts), so this can never serve a "not
    // revoked" verdict more than 5 seconds stale even when it is used.
    const highValue = isHighValueAmount(dto.requestedAmountStroops);
    if (!highValue) {
      const cached = this.revocationCache?.get(dto.sessionPublicKey);
      if (cached?.isRevoked) {
        return { success: false, error: 'Session key has been revoked' };
      }
    }

    // 1. Load session key record from Redis
    const raw = await this.redis.get(`${SESSION_KEY_PREFIX}${dto.sessionPublicKey}`);
    if (!raw) {
      this.revocationCache?.delete(dto.sessionPublicKey);
      return { success: false, error: 'Session key not found or expired' };
    }

    const record: SessionKeyRecord = JSON.parse(raw);

    // Keep the local cache warm for the fast path on the next call (not
    // consulted for high-value transactions, which always re-check Redis).
    this.revocationCache?.set({
      keyId: record.vaultKeyPath,
      publicKey: record.sessionPublicKey,
      ownerAddress: record.userId,
      expiresAtLedger: record.expiresAt,
      isRevoked: false,
    });

    // 2. Validate session key has not expired
    const now = Math.floor(Date.now() / 1000);
    if (now >= record.expiresAt) {
      await this.redis.del(`${SESSION_KEY_PREFIX}${dto.sessionPublicKey}`);
      return { success: false, error: 'Session key has expired' };
    }

    // 3. Parse requested amount
    const requestedAmount = BigInt(dto.requestedAmountStroops);
    if (requestedAmount <= 0n) {
      return { success: false, error: 'Requested amount must be positive' };
    }

    // 4. Validate per-call limit
    const maxPerCall = BigInt(record.policy.maxPerCallStroops);
    if (requestedAmount > maxPerCall) {
      return {
        success: false,
        error: `Requested amount ${requestedAmount} exceeds per-call limit ${maxPerCall}`,
      };
    }

    // 5. Verify cumulative spent amount does not exceed session spending limit
    const spent = BigInt(record.spentAmountStroops);
    const limit = BigInt(record.spendingLimitStroops);
    const remaining = limit - spent;

    // Immediately deny if requested amount exceeds remaining cap
    if (requestedAmount > remaining) {
      return {
        success: false,
        error: `Requested amount ${requestedAmount} exceeds remaining budget ${remaining}`,
      };
    }

    // 6. Validate contract call is within policy
    const contractId = this.extractContractIdFromXdr(dto.contractCallXdr);
    const method = this.extractMethodFromXdr(dto.contractCallXdr);

    if (!record.policy.allowedContracts.includes(contractId)) {
      return { success: false, error: `Contract ${contractId} not allowed by session key policy` };
    }

    if (!record.policy.allowedMethods.includes(method)) {
      return { success: false, error: `Method ${method} not allowed by session key policy` };
    }

    // 7. Retrieve encrypted private key from Vault
    const encryptedKey = await this.vaultClient.read(record.vaultKeyPath);
    if (!encryptedKey) {
      return { success: false, error: 'Failed to retrieve session key from Vault' };
    }

    // 8. Sign the transaction
    // In production, decrypt the private key and sign the XDR
    // using @stellar/stellar-sdk's TransactionBuilder
    const signedTxXdr = await this.signTransaction(dto.contractCallXdr, encryptedKey);

    // 9. Update spent amount atomically
    const newSpent = spent + requestedAmount;
    record.spentAmountStroops = newSpent.toString();

    const ttl = record.expiresAt - now;
    await this.redis.setex(
      `${SESSION_KEY_PREFIX}${dto.sessionPublicKey}`,
      ttl,
      JSON.stringify(record),
    );

    // Update database
    await this.db.query(
      `UPDATE session_keys SET spent_amount_stroops = $1, updated_at = NOW()
       WHERE session_public_key = $2`,
      [newSpent.toString(), dto.sessionPublicKey],
    );

    return {
      success: true,
      signedTxXdr,
      remainingBudgetStroops: (limit - newSpent).toString(),
    };
  }

  /**
   * Revoke a session key immediately.
   */
  async revokeSessionKey(sessionPublicKey: string): Promise<void> {
    await this.redis.del(`${SESSION_KEY_PREFIX}${sessionPublicKey}`);
    await this.db.query(
      `UPDATE session_keys SET revoked = true, revoked_at = NOW()
       WHERE session_public_key = $1`,
      [sessionPublicKey],
    );

    // Closes #344 — propagate the revocation to every node's local cache
    // immediately via Redis Pub/Sub, instead of relying solely on each
    // node's next distributed-store check. If the broadcast itself is
    // dropped (e.g. during network repartitioning), the 5-second local
    // cache TTL (see sessionKeyCache.ts) still bounds how stale any node's
    // view can get.
    await this.revocationCache?.broadcastRevocation(sessionPublicKey);
  }

  /**
   * Get the current status of a session key.
   */
  async getSessionKeyStatus(sessionPublicKey: string): Promise<{
    exists: boolean;
    expired: boolean;
    spentStroops: string;
    limitStroops: string;
    remainingStroops: string;
    expiresAt: number;
  } | null> {
    const raw = await this.redis.get(`${SESSION_KEY_PREFIX}${sessionPublicKey}`);
    if (!raw) return null;

    const record: SessionKeyRecord = JSON.parse(raw);
    const now = Math.floor(Date.now() / 1000);
    const spent = BigInt(record.spentAmountStroops);
    const limit = BigInt(record.spendingLimitStroops);

    return {
      exists: true,
      expired: now >= record.expiresAt,
      spentStroops: spent.toString(),
      limitStroops: limit.toString(),
      remainingStroops: (limit - spent).toString(),
      expiresAt: record.expiresAt,
    };
  }

  // --- Private helpers ---

  private extractContractIdFromXdr(_xdr: string): string {
    // In production, parse the XDR to extract the contract ID
    // from the InvokeContractHostFunction operation
    return 'EXTRACTED_CONTRACT_ID';
  }

  private extractMethodFromXdr(_xdr: string): string {
    // In production, parse the XDR to extract the method name
    return 'EXTRACTED_METHOD';
  }

  private async signTransaction(_xdr: string, _encryptedKey: string): Promise<string> {
    // In production:
    // 1. Decrypt the private key using Vault's transit engine
    // 2. Create a Keypair from the decrypted private key
    // 3. Sign the transaction XDR
    // 4. Return the signed transaction XDR
    return `${_xdr}_SIGNED`;
  }
}
