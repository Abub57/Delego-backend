/**
 * Network-aware retry wrapper for escrow contract invocations (Issue #11).
 *
 * The escrow coordinator submits every `deposit` / `release` / `refund` /
 * `dispute` call through {@link submitContractInvocation}, which talks to the
 * wallet service over HTTP. Previously any throw — a transient RPC blip just
 * as much as a deterministic contract rejection — aborted the operation and
 * permanently marked the payment `failed`.
 *
 * This wrapper retries only errors that are recognisably transient network /
 * RPC faults (connection resets, timeouts, 5xx, rate limiting) using the shared
 * {@link retryWithBackoff} helper, and rethrows contract/logic errors on the
 * first attempt so they fail fast. When retries are exhausted it rethrows the
 * last error so callers keep their existing "mark the record failed"
 * semantics.
 */

import type { TransactionRequest, TransactionResult } from "@delegolabs/types";
import { retryWithBackoff, type RetryOptions } from "../autoRelease/retry.js";
import { submitContractInvocation } from "./contractClient.js";

/** Default retry budget: 3 retries (4 attempts total), 2s/4s/8s backoff. */
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 2000;

/**
 * Substrings that identify a transient network / RPC failure rather than a
 * deterministic contract error. Mirrors the wallet service's
 * `RETRYABLE_NETWORK_PATTERNS` classification so both paths agree on what is
 * worth retrying.
 */
const TRANSIENT_NETWORK_PATTERNS = [
  "timeout",
  "timed out",
  "network",
  "econnrefused",
  "econnreset",
  "econnaborted",
  "epipe",
  "enotfound",
  "eai_again",
  "socket hang up",
  "socket closed",
  "connection reset",
  "connection refused",
  "fetch failed",
  "failed to fetch",
  "rate limit",
  "too many requests",
  "429",
  "500",
  "502",
  "503",
  "504",
  "temporarily unavailable",
  "service unavailable",
  "wallet service unavailable",
] as const;

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * Returns `true` when an error looks like a transient network / RPC fault that
 * is safe to retry. Contract logic errors (on-chain reverts, bad arguments,
 * simulation failures) do not match and therefore fail immediately.
 */
export function isTransientNetworkError(err: unknown): boolean {
  const message = errorMessage(err).toLowerCase();
  return TRANSIENT_NETWORK_PATTERNS.some((pattern) => message.includes(pattern));
}

/**
 * Submits a contract invocation, retrying transient network/RPC failures with
 * exponential backoff. Throws the original error when the failure is not
 * retryable or once the retry budget is exhausted, preserving the caller's
 * existing error handling.
 */
export async function submitContractInvocationWithRetry(
  request: TransactionRequest,
  options: RetryOptions = {}
): Promise<TransactionResult> {
  const result = await retryWithBackoff(() => submitContractInvocation(request), {
    maxRetries: DEFAULT_MAX_RETRIES,
    baseDelayMs: DEFAULT_BASE_DELAY_MS,
    ...options,
    // Always network-only, even if a caller supplied their own predicate:
    // deterministic contract errors must never be retried.
    shouldRetry: isTransientNetworkError,
  });

  if (!result.success) {
    throw result.error instanceof Error ? result.error : new Error(String(result.error));
  }
  return result.value as TransactionResult;
}
