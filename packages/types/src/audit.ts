/**
 * Audit log chaining and Merkle publisher type definitions.
 */

/** One row of the cryptographically chained audit log. */
export interface AuditLogChainEntry {
  /** Optional entry identifier */
  entryId?: string;
  /** Monotonically increasing sequence number. */
  sequence: number;
  /** When the action occurred. */
  timestamp: Date;
  /** The administrative action performed (e.g., "merchant_suspension", "fee_override", "dispute_resolution"). */
  action: string;
  /** SHA-256 payload hash if computed separately. */
  payloadHash?: string;
  /** SHA-256 hex digest of the previous entry's currentHash, or null for the genesis entry. */
  previousHash: string | null;
  /** Cryptographic signature if signed. */
  signature?: string;
  /** The actor (user/service) that performed the action. */
  actorId: string;
  /** The target of the action (e.g., merchant ID, fee schedule ID). */
  targetId: string;
  /** Additional context about the action. */
  metadata: Record<string, unknown>;
  /** Optional payload context. */
  payload?: Record<string, unknown>;
  /** Optional tenant identifier. */
  tenantId?: string;
  /** SHA-256 hex digest of this entry's content chained with previousHash. */
  currentHash: string;
}

/** Fields the caller supplies; sequence, previousHash, currentHash are computed by the chain. */
export interface AuditLogChainInput {
  action: string;
  actorId: string;
  targetId: string;
  metadata?: Record<string, unknown>;
  payload?: Record<string, unknown>;
  tenantId?: string;
  sequence: number;
  timestamp?: Date;
}

/** Result of verifying the entire audit chain. */
export interface ChainVerificationResult {
  valid: boolean;
  entriesVerified: number;
  /** The sequence number of the first broken entry, if any. */
  firstBrokenSequence: number | null;
  reason: string | null;
  /** Broken sequence alias */
  brokenSequence?: bigint | number | null;
  /** Expected hash alias */
  expectedHash?: string;
  /** Actual hash alias */
  actualHash?: string;
}

/** Result of computing a Merkle root from the audit chain. */
export interface MerkleRootResult {
  root: string;
  leafCount: number;
  timestamp: Date;
}

/** Configuration for the periodic Merkle root publisher. */
export interface MerklePublisherConfig {
  /** Stellar secret key for signing transactions. */
  stellarSecretKey: string;
  /** Stellar public key (memo destination) for publishing roots. */
  stellarPublicKey: string;
  /** Interval in milliseconds between Merkle root publications. Default: 1 hour. */
  intervalMs?: number;
  /** Horizon server URL. Default: testnet horizon. */
  horizonUrl?: string;
  /** Horizon server URL alias. */
  stellarHorizonUrl?: string;
  /** Anchor account alias for the destination account. */
  anchorAccount?: string;
  /** Publish interval in ledgers alias. */
  publishIntervalLedgers?: number;
}
