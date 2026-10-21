/**
 * Exponential backoff retry helper for Soroban release calls (Issue #45).
 *
 * Retries a failing async operation up to `maxRetries` additional times
 * (i.e. up to `maxRetries + 1` total attempts), waiting `baseDelayMs * 2^n`
 * between attempts (2s, 4s, 8s for the default 2s base / 3 retries).
 */

import { createLogger } from "@delegolabs/utils";

const log = createLogger("payments:auto-release:retry", process.env.LOG_LEVEL ?? "info");

export interface RetryOptions {
  /** Maximum number of retries after the initial attempt. Default: 3. */
  maxRetries?: number;
  /** Base delay in ms used for the exponential backoff schedule. Default: 2000. */
  baseDelayMs?: number;
  /** Called before each retry sleep, useful for logging/telemetry in callers. */
  onRetry?: (attempt: number, error: unknown, delayMs: number) => void;
  /** Injectable sleep function — tests can pass a no-op to skip real timers. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Predicate deciding whether a thrown error is retryable. When omitted every
   * error is retried (the original, backwards-compatible behaviour). Return
   * `false` to fail fast on deterministic errors such as contract logic
   * rejections — see `isTransientNetworkError` in the escrow coordinator.
   */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
}

export interface RetryResult<T> {
  success: boolean;
  value?: T;
  error?: unknown;
  /** Number of retries actually performed (0 if the first attempt succeeded). */
  retryCount: number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `fn`, retrying on failure with exponential backoff.
 * Never throws — failures after exhausting retries are reported via the
 * returned {@link RetryResult}, so callers can decide how to surface them
 * (e.g. as a `release_failed` domain event).
 */
export async function retryWithBackoff<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions = {}
): Promise<RetryResult<T>> {
  const maxRetries = options.maxRetries ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 2000;
  const sleep = options.sleep ?? defaultSleep;

  let lastError: unknown;
  let retryCount = 0;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const value = await fn(attempt);
      return { success: true, value, retryCount: attempt };
    } catch (err) {
      lastError = err;
      const isLastAttempt = attempt === maxRetries;
      const isRetryable = options.shouldRetry ? options.shouldRetry(err, attempt) : true;
      if (isLastAttempt || !isRetryable) {
        break;
      }

      retryCount = attempt + 1;
      const delayMs = baseDelayMs * 2 ** attempt;
      log.warn("Retryable operation failed, backing off before retry", {
        attempt: attempt + 1,
        maxRetries,
        delayMs,
        error: err instanceof Error ? err.message : String(err),
      });
      options.onRetry?.(attempt + 1, err, delayMs);
      await sleep(delayMs);
    }
  }

  return { success: false, error: lastError, retryCount };
}
