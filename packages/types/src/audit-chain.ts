/**
 * Cryptographic SHA-256 Tamper-Evident Audit Log Chaining
 * Issue #358
 *
 * These types mirror the data model specified in Issue #358 for
 * cryptographically chained audit log entries.
 */

/** One row of the cryptographically chained audit log. */
export interface AuditLogChainEntry {
  /** Monotonically increasing sequence number. */
  sequence: number;
  /** The actor (user/service) that performed the action. */
  actorId: string;
  /** The administrative action performed (e.g., "merchant_suspension", "fee_override", "dispute_resolution"). */
  action: string;
  /** The target of the action (e.g., merchant ID, fee schedule ID). */
  targetId: string;
  /** Additional context about the action. */
  metadata: Record<string, unknown>;
  /** SHA-256 hex digest of the previous entry's currentHash, or null for the genesis entry. */
  previousHash: string | null;
  /** SHA-256 hex digest of this entry's content chained with previousHash. */
  currentHash: string;
  /** When the action occurred. */
  timestamp: Date;
}

/** Fields the caller supplies; sequence, previousHash, currentHash are computed by the chain. */
export interface AuditLogChainInput {
  actorId: string;
  action: string;
  targetId: string;
  metadata?: Record<string, unknown>;
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
}
