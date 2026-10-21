/**
 * Stored-chain verification entrypoint for the tamper-evident audit log
 * (Issue #308).
 *
 * `verifyChain` (`hashChain.ts`) verifies an array of entries the caller
 * already holds in memory; `getChainSegment` (`auditLogStore.ts`) reads a
 * contiguous window of the `audit_log` table. Nothing, however, answered
 * the operational question the issue asks — *"was any historical audit row
 * altered out-of-band?"* — by walking the **whole stored chain** and
 * reporting the answer. This module is that missing piece:
 *
 *   const result = await verifyStoredChain(pool);
 *   if (!result.valid) process.exit(1);
 *
 * It pages through the table by `sequence_num` rather than relying on
 * `getChainSegment`'s 10 000-row default, so tampering past that point is
 * still detected instead of silently passing. Each page's verification is
 * seeded with the previous page's tail `entryHash`, so the chain is
 * verified end-to-end across page boundaries rather than per-page.
 *
 * Only a `to` bound is supported, never a `from` one: `verifyChain` starts
 * from the genesis link (`prevHash === null`), so a window that did not
 * begin at the first row would report a spurious `prevHash mismatch` on its
 * first entry. Verifying from genesis to `to` keeps the result trustworthy.
 */
import type { ChainVerificationResult, Queryable } from "./types.js";
import { getChainSegment } from "./auditLogStore.js";
import { verifyChain } from "./hashChain.js";

/** Rows fetched per query while walking the chain. */
export const DEFAULT_VERIFY_PAGE_SIZE = 10_000;

export interface VerifyStoredChainOptions {
  /** Only verify entries with `occurredAt <= to`. Omit to verify the whole chain. */
  to?: Date;
  /** Rows fetched per query while walking the chain. Defaults to `DEFAULT_VERIFY_PAGE_SIZE`. */
  pageSize?: number;
}

export interface StoredChainVerificationResult extends ChainVerificationResult {
  /** Number of database round-trips (pages) used to walk the chain. */
  pagesChecked: number;
  /** `sequenceNum` of the newest entry reached, or null when the log was empty. */
  lastSequenceNum: number | null;
}

/**
 * Walk the entire stored audit-log hash chain (oldest entry first, in
 * `sequence_num` order) and report whether it is intact.
 *
 * Never throws for a broken chain — a break is a normal, expected result
 * (`valid: false` + `firstBrokenEntryId` + `reason`). It only throws when
 * the database query itself fails, or when `pageSize` is invalid.
 */
export async function verifyStoredChain(
  db: Queryable,
  options: VerifyStoredChainOptions = {}
): Promise<StoredChainVerificationResult> {
  const pageSize = options.pageSize ?? DEFAULT_VERIFY_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new RangeError(`pageSize must be a positive integer, got ${pageSize}`);
  }

  let afterSequenceNum: number | undefined;
  let expectedPrevHash: string | null = null;
  let entriesChecked = 0;
  let pagesChecked = 0;
  let lastSequenceNum: number | null = null;

  for (;;) {
    const page = await getChainSegment(db, {
      to: options.to,
      limit: pageSize,
      afterSequenceNum,
    });
    pagesChecked += 1;

    if (page.length === 0) {
      return {
        valid: true,
        entriesChecked,
        firstBrokenEntryId: null,
        reason: null,
        pagesChecked,
        lastSequenceNum,
      };
    }

    const pageResult = verifyChain(page, expectedPrevHash);
    if (!pageResult.valid) {
      // `pageResult.entriesChecked` counts the entries in this page that
      // verified before the break, so the entry that broke is the next one.
      const brokenIndex = pageResult.entriesChecked;
      return {
        ...pageResult,
        entriesChecked: entriesChecked + pageResult.entriesChecked,
        pagesChecked,
        lastSequenceNum:
          brokenIndex > 0 ? page[brokenIndex - 1].sequenceNum : lastSequenceNum,
      };
    }

    entriesChecked += page.length;
    lastSequenceNum = page[page.length - 1].sequenceNum;
    expectedPrevHash = page[page.length - 1].entryHash;

    // A short page means the table has no more rows for this window.
    if (page.length < pageSize) {
      return {
        valid: true,
        entriesChecked,
        firstBrokenEntryId: null,
        reason: null,
        pagesChecked,
        lastSequenceNum,
      };
    }

    afterSequenceNum = lastSequenceNum;
  }
}

/** Render a `StoredChainVerificationResult` as a human-readable, multi-line report. */
export function formatChainVerificationReport(result: StoredChainVerificationResult): string {
  const entryWord = result.entriesChecked === 1 ? "entry" : "entries";
  const lines: string[] = [];

  if (result.valid) {
    lines.push(
      `Audit log hash chain OK — verified ${result.entriesChecked} ${entryWord} across ${result.pagesChecked} page(s).`
    );
    lines.push(
      result.lastSequenceNum === null
        ? "Nothing to verify — the verification scope contained no audit_log entries."
        : `Newest verified sequence_num: ${result.lastSequenceNum}.`
    );
    return lines.join("\n");
  }

  lines.push(
    `Audit log hash chain BROKEN — ${result.entriesChecked} ${entryWord} verified before the first break.`
  );
  lines.push(`First broken entry id: ${result.firstBrokenEntryId ?? "unknown"}`);
  lines.push(`Reason: ${result.reason ?? "unknown"}`);
  return lines.join("\n");
}
