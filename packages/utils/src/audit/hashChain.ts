/**
 * Hash-chaining for tamper evidence on the audit log (Issue #66).
 *
 * Each entry's `entryHash` is a SHA-256 digest of its own content
 * concatenated with the previous entry's `entryHash` (`prevHash`). That
 * makes the log a hash chain: altering or deleting any historical row
 * (e.g. via direct DB access that bypasses the immutability triggers in
 * `025_audit_log.sql`, or a restored-from-backup row swap) changes what
 * that row's hash *should* be, which breaks the chain from that point
 * forward. `verifyChain` walks a sequence of entries and reports the
 * first break, if any.
 *
 * This is application-level tamper *evidence*, not tamper *prevention* —
 * it can prove the log was altered after the fact, it can't stop a
 * sufficiently privileged actor from altering it. Prevention is the
 * DB trigger in the migration.
 */
import { createHash } from "node:crypto";
import type { AuditLogEntry, AuditOperation, ChainVerificationResult } from "./types.js";

/** The subset of an entry's fields that feed the hash — everything except the hash fields themselves. */
export interface HashableAuditFields {
  tableName: string;
  recordId: string;
  operation: AuditOperation;
  userId: string | null;
  sessionId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  oldValues: Record<string, unknown> | null;
  newValues: Record<string, unknown> | null;
  changedFields: string[];
  occurredAt: Date;
  transactionId: string;
}

/**
 * Deterministically serialize the hashable fields of an entry. Object keys
 * in `oldValues`/`newValues` are sorted so the same logical change always
 * produces the same hash regardless of key insertion order (JSON.stringify
 * on a plain object is otherwise insertion-order-dependent).
 */
function canonicalize(fields: HashableAuditFields): string {
  const sortKeys = (value: Record<string, unknown> | null): Record<string, unknown> | null => {
    if (value === null) return null;
    return Object.keys(value)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = value[key];
        return acc;
      }, {});
  };

  return JSON.stringify({
    tableName: fields.tableName,
    recordId: fields.recordId,
    operation: fields.operation,
    userId: fields.userId,
    sessionId: fields.sessionId,
    ipAddress: fields.ipAddress,
    userAgent: fields.userAgent,
    oldValues: sortKeys(fields.oldValues),
    newValues: sortKeys(fields.newValues),
    changedFields: [...fields.changedFields].sort(),
    occurredAt: fields.occurredAt.toISOString(),
    transactionId: fields.transactionId,
  });
}

/** Compute the SHA-256 hex digest for one entry, chained onto `prevHash` (null for the first entry in the chain). */
export function computeEntryHash(fields: HashableAuditFields, prevHash: string | null): string {
  const payload = `${prevHash ?? ""}:${canonicalize(fields)}`;
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

/**
 * Walk a sequence of entries (already ordered oldest-first) and verify
 * every `entryHash` matches what recomputing it from the row's own fields
 * and the previous row's `entryHash` produces, and that each `prevHash`
 * actually points at the previous entry.
 *
 * The caller is responsible for fetching entries in `sequence_num` order
 * (oldest first) — this function trusts the order it's given.
 *
 * `startPrevHash` lets a caller verify the chain in pages: pass the tail
 * `entryHash` of the previous page so this page's first entry is checked
 * against it instead of against genesis. Defaults to null (a chain that
 * starts at the beginning of the log).
 */
export function verifyChain(
  entries: AuditLogEntry[],
  startPrevHash: string | null = null
): ChainVerificationResult {
  let expectedPrevHash: string | null = startPrevHash;
  let entriesChecked = 0;

  for (const entry of entries) {
    if (entry.prevHash !== expectedPrevHash) {
      return {
        valid: false,
        entriesChecked,
        firstBrokenEntryId: entry.id,
        reason: `prevHash mismatch on entry ${entry.id}: expected ${expectedPrevHash ?? "null"}, got ${entry.prevHash ?? "null"}`,
      };
    }

    const recomputed = computeEntryHash(entry, entry.prevHash);
    if (recomputed !== entry.entryHash) {
      return {
        valid: false,
        entriesChecked,
        firstBrokenEntryId: entry.id,
        reason: `entryHash mismatch on entry ${entry.id}: stored hash does not match recomputed hash — row contents may have been altered`,
      };
    }

    entriesChecked += 1;
    expectedPrevHash = entry.entryHash;
  }

  return { valid: true, entriesChecked, firstBrokenEntryId: null, reason: null };
}
