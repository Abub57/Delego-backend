/**
 * Cryptographic SHA-256 Tamper-Evident Audit Log Chaining
 * Issue #358
 *
 * Implements the hash chain: currentHash = sha256(sequence + actorId + action + targetId + previousHash + timestamp)
 * Each entry's hash is cryptographically chained to the previous entry, making any
 * modification or row deletion detectable.
 */
import { createHash } from "node:crypto";
import { createLogger } from "@delegolabs/utils";
import type {
  AuditLogChainEntry,
  AuditLogChainInput,
  ChainVerificationResult,
  MerkleRootResult,
} from "@delegolabs/types";

const log = createLogger("audit:chain", process.env.LOG_LEVEL ?? "info");

/**
 * Compute the currentHash for an audit log entry using the formula:
 * currentHash = sha256(sequence + actorId + action + targetId + previousHash + timestamp)
 */
export function computeCurrentHash(
  sequence: number,
  actorId: string,
  action: string,
  targetId: string,
  previousHash: string | null,
  timestamp: Date
): string {
  const prev = previousHash ?? "";
  const ts = timestamp.toISOString();
  const payload = `${sequence}${actorId}${action}${targetId}${prev}${ts}`;
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

/**
 * Build a complete AuditLogChainEntry from input, computing the hash.
 */
export function buildEntry(input: AuditLogChainInput, previousHash: string | null): AuditLogChainEntry {
  const timestamp = input.timestamp ?? new Date();
  const currentHash = computeCurrentHash(
    input.sequence,
    input.actorId,
    input.action,
    input.targetId,
    previousHash,
    timestamp
  );

  return {
    sequence: input.sequence,
    actorId: input.actorId,
    action: input.action,
    targetId: input.targetId,
    metadata: input.metadata ?? {},
    previousHash,
    currentHash,
    timestamp,
  };
}

/**
 * Verify the integrity of an audit chain.
 *
 * Returns a ChainVerificationResult indicating whether the chain is valid.
 * If invalid, reports the first broken sequence number and reason.
 *
 * Validation checks:
 * 1. Each entry's currentHash matches computeCurrentHash() of its fields + previousHash
 * 2. Each entry's previousHash matches the previous entry's currentHash
 * 3. The first entry's previousHash is null
 * 4. Sequence numbers are monotonically increasing starting from 1
 */
export function verifyChain(entries: AuditLogChainEntry[]): ChainVerificationResult {
  if (entries.length === 0) {
    return { valid: true, entriesVerified: 0, firstBrokenSequence: null, reason: null };
  }

  let expectedPrevHash: string | null = null;
  let expectedSequence = 1;

  for (const entry of entries) {
    if (entry.sequence !== expectedSequence) {
      return {
        valid: false,
        entriesVerified: expectedSequence - 1,
        firstBrokenSequence: entry.sequence,
        reason: `Sequence gap detected: expected ${expectedSequence}, got ${entry.sequence}`,
      };
    }

    if (entry.previousHash !== expectedPrevHash) {
      return {
        valid: false,
        entriesVerified: expectedSequence - 1,
        firstBrokenSequence: entry.sequence,
        reason: `Previous hash mismatch at sequence ${entry.sequence}: expected ${expectedPrevHash ?? "null"}, got ${entry.previousHash ?? "null"}`,
      };
    }

    const recomputedHash = computeCurrentHash(
      entry.sequence,
      entry.actorId,
      entry.action,
      entry.targetId,
      entry.previousHash,
      entry.timestamp
    );

    if (recomputedHash !== entry.currentHash) {
      return {
        valid: false,
        entriesVerified: expectedSequence - 1,
        firstBrokenSequence: entry.sequence,
        reason: `Hash mismatch at sequence ${entry.sequence}: stored currentHash does not match recomputed hash — entry may have been tampered with`,
      };
    }

    expectedPrevHash = entry.currentHash;
    expectedSequence += 1;
  }

  return { valid: true, entriesVerified: entries.length, firstBrokenSequence: null, reason: null };
}

/**
 * Verify chain integrity on startup and emit a critical alert if any modification
 * or row deletion is detected. Returns true if the chain is valid, false otherwise.
 */
export function verifyChainOnStartup(entries: AuditLogChainEntry[]): boolean {
  const result = verifyChain(entries);

  if (!result.valid) {
    log.error("Audit chain integrity violation detected on startup", {
      entriesVerified: result.entriesVerified,
      firstBrokenSequence: result.firstBrokenSequence,
      reason: result.reason,
    });
    return false;
  }

  log.info("Audit chain integrity verified on startup", {
    entriesVerified: result.entriesVerified,
  });
  return true;
}

/**
 * Compute the Merkle root of the audit chain.
 *
 * Uses a binary Merkle tree: pairs of leaf hashes are concatenated and hashed
 * until a single root hash remains. If the number of leaves is odd, the last
 * leaf is duplicated.
 */
export function computeMerkleRoot(entries: AuditLogChainEntry[]): MerkleRootResult {
  if (entries.length === 0) {
    return { root: concatenateHashes("", ""), leafCount: 0, timestamp: new Date() };
  }

  const leaves = entries.map((entry) => entry.currentHash);
  const root = computeMerkleRootFromLeaves(leaves);

  return { root, leafCount: entries.length, timestamp: new Date() };
}

/** Recursively compute the Merkle root from an array of leaf hashes. */
function computeMerkleRootFromLeaves(leaves: string[]): string {
  if (leaves.length === 1) return leaves[0];

  const pairs: string[] = [];
  for (let i = 0; i < leaves.length; i += 2) {
    const left = leaves[i];
    const right = i + 1 < leaves.length ? leaves[i + 1] : left;
    pairs.push(concatenateHashes(left, right));
  }

  return computeMerkleRootFromLeaves(pairs);
}

/** Concatenate two hashes and produce a SHA-256 digest. */
function concatenateHashes(left: string, right: string): string {
  return createHash("sha256").update(left + right, "utf8").digest("hex");
}

/**
 * Verify a single entry's hash against its content and previous hash.
 * Returns true if the entry is valid.
 */
export function verifyEntry(entry: AuditLogChainEntry, previousEntry: AuditLogChainEntry | null): boolean {
  const expectedPrevHash = previousEntry ? previousEntry.currentHash : null;
  if (entry.previousHash !== expectedPrevHash) return false;

  const expectedHash = computeCurrentHash(
    entry.sequence,
    entry.actorId,
    entry.action,
    entry.targetId,
    entry.previousHash,
    entry.timestamp
  );

  return entry.currentHash === expectedHash;
}
