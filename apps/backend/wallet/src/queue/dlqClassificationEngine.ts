/**
 * DLQ Triage Classification Engine
 * Issue #363
 */

import type { DlqTriagePolicy, TriageDecision, DlqTriageJobData } from "@delegolabs/types";

export interface ErrorClassificationResult {
  category: "transient" | "permanent";
  decision: TriageDecision;
  reason: string;
  matchedPattern?: string;
  retryDelayMs?: number;
}

export const DEFAULT_TRANSIENT_PATTERNS = [
  "etimedout",
  "econnreset",
  "econnrefused",
  "enotfound",
  "ehostunreach",
  "enetunreach",
  "eai_again",
  "getaddrinfo",
  "timeout",
  "timed out",
  "network",
  "fetch failed",
  "socket hang up",
  "rate limit",
  "too many requests",
  "429",
  "500",
  "502",
  "503",
  "504",
  "service unavailable",
  "temporarily unavailable",
  "gateway timeout",
  "bad gateway",
  "tx_bad_seq",
  "bad_seq",
  "sequence conflict",
  "status untracked",
  "transaction timeout",
  "getaddrinfo",
  "eai_again",
];

export const DEFAULT_PERMANENT_PATTERNS = [
  "malformed",
  "invalid xdr",
  "bad xdr",
  "auth failure",
  "unauthorized",
  "forbidden",
  "access denied",
  "invalid auth",
  "decryption failed",
  "invalid signature",
  "simulation failed",
  "transaction failed",
  "insufficient balance",
  "account not found",
  "trustline missing",
  "invalid address",
  "invalid amount",
  "unsupported asset",
];

/**
 * Calculates exponential backoff with optional jitter.
 * delay = min(baseDelayMs * (multiplier ^ retryCount), maxDelayMs) + jitter
 */
export function calculateExponentialBackoff(
  retryCount: number,
  options?: {
    baseDelayMs?: number;
    multiplier?: number;
    maxDelayMs?: number;
    addJitter?: boolean;
  }
): number {
  const baseDelayMs = options?.baseDelayMs ?? 2000;
  const multiplier = options?.multiplier ?? 2;
  const maxDelayMs = options?.maxDelayMs ?? 120000; // max 2 minutes
  const addJitter = options?.addJitter ?? false;

  const rawDelay = Math.min(baseDelayMs * Math.pow(multiplier, Math.max(0, retryCount)), maxDelayMs);
  if (addJitter) {
    const jitter = Math.random() * (baseDelayMs * 0.5);
    return Math.min(Math.round(rawDelay + jitter), maxDelayMs);
  }
  return Math.round(rawDelay);
}

/**
 * Classifies an error and determines the triage decision based on policy and retry counts.
 */
export function classifyErrorAndDecide(
  job: DlqTriageJobData,
  policy: DlqTriagePolicy,
  options?: {
    baseDelayMs?: number;
    multiplier?: number;
    maxDelayMs?: number;
  }
): ErrorClassificationResult {
  const message = `${job.errorMessage} ${job.errorCode ?? ""} ${job.errorStack ?? ""}`.toLowerCase();
  const patterns = policy.transientErrorPatterns.length > 0 ? policy.transientErrorPatterns : DEFAULT_TRANSIENT_PATTERNS;

  // Check permanent explicit patterns first
  const matchedPermanent = DEFAULT_PERMANENT_PATTERNS.find((p) => message.includes(p.toLowerCase()));
  if (matchedPermanent) {
    return {
      category: "permanent",
      decision: "quarantine",
      reason: `Permanent error detected matching '${matchedPermanent}'`,
      matchedPattern: matchedPermanent,
    };
  }

  // Check transient patterns
  const matchedTransient = patterns.find((p) => message.includes(p.toLowerCase()));
  if (matchedTransient) {
    if (job.retryCount >= policy.maxAutomaticRetries) {
      return {
        category: "transient",
        decision: "quarantine",
        reason: `Transient error exceeded max automatic retries (${policy.maxAutomaticRetries}): ${job.errorMessage}`,
        matchedPattern: matchedTransient,
      };
    }

    const retryDelayMs = calculateExponentialBackoff(job.retryCount, options);
    const decision: TriageDecision = retryDelayMs <= 0 || job.retryCount === 0 ? "retry_now" : "schedule_retry";

    return {
      category: "transient",
      decision,
      reason: `Transient error matching '${matchedTransient}' - retry ${job.retryCount + 1}/${policy.maxAutomaticRetries}`,
      matchedPattern: matchedTransient,
      retryDelayMs,
    };
  }

  // If unknown, default to quarantine with permanent category
  return {
    category: "permanent",
    decision: "quarantine",
    reason: `Unclassified error treated as permanent: ${job.errorMessage}`,
  };
}
