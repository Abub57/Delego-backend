/**
 * Gas Tank Subsidization — Types
 *
 * Closes #398.
 *
 * The gas tank sponsors Soroban base resource fees for new buyer agent
 * accounts up to a daily budget. A single `GasSponsorshipPolicy` describes
 * the allowed envelope; the manager and eligibility validator enforce it.
 *
 * Amounts are always strings (stroops) on the wire to avoid JSON
 * bigint-serialization pitfalls — same convention as `sessionKeys` and
 * `faucet`.
 */

// ---------------------------------------------------------------------------
// Policy (matches the issue spec, stringified for JSON safety)
// ---------------------------------------------------------------------------

export interface GasSponsorshipPolicy {
  /**
   * Maximum number of sponsored ledger submissions per rolling 24 h window.
   * A ledger submission = one signed transaction carrying the sponsor's
   * signature.
   */
  maxDailySponsoredLedgers: number;

  /**
   * Maximum stroops the sponsor will spend on behalf of one buyer agent
   * account, over the entire lifetime of that account's sponsorship.
   */
  maxSpendPerAccountStroops: string;

  /**
   * Allowlisted Soroban contract IDs (C...). A submission whose target
   * contract is not in this list is rejected, so the tank cannot be used
   * as a general-purpose fee payer.
   */
  authorizedContracts: string[];
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

export type SponsorshipDenialReason =
  | "ACCOUNT_NOT_ELIGIBLE"
  | "CONTRACT_NOT_AUTHORIZED"
  | "ACCOUNT_BUDGET_EXCEEDED"
  | "DAILY_LEDGER_BUDGET_EXCEEDED"
  | "INVALID_REQUEST"
  | "SPONSOR_NOT_CONFIGURED";

export interface SponsorshipDecision {
  /** Whether the tank will sponsor this submission. */
  eligible: boolean;
  /** Present only when `eligible === false`. */
  reason?: SponsorshipDenialReason;
  /** Human-readable diagnostic. Never shown to end users as-is. */
  detail?: string;
  /** Remaining daily ledgers *after* this decision (informational). */
  dailyRemaining?: number;
  /** Remaining per-account stroops *after* this decision (informational). */
  accountRemainingStroops?: string;
}

// ---------------------------------------------------------------------------
// Ledger (audit trail + persistence shape)
// ---------------------------------------------------------------------------

export interface SponsorshipLedgerEntry {
  /** Buyer agent account whose fee was sponsored. */
  account: string;
  /** Soroban contract ID that was called. */
  contractId: string;
  /** Fee in stroops actually spent. */
  feeStroops: string;
  /** Transaction hash of the sponsored submission. */
  txHash: string;
  /** ISO-8601 UTC timestamp. */
  sponsoredAt: string;
}

// ---------------------------------------------------------------------------
// Submission request/result (sponsored submitter)
// ---------------------------------------------------------------------------

export interface SponsoredSubmitRequest {
  /** Buyer agent account. */
  buyerAccount: string;
  /** Pre-built, unsigned (or buyer-signed) Soroban transaction XDR (base64). */
  txXdr: string;
  /** Target Soroban contract ID, extracted by the caller or the submitter. */
  contractId: string;
  /** Estimated fee in stroops; used for pre-checks and budget accounting. */
  feeStroops: string;
}

export interface SponsoredSubmitResult {
  success: boolean;
  /** Transaction hash returned by the RPC on success. */
  txHash?: string;
  /** Populated when `success === false`. */
  reason?: SponsorshipDenialReason | "SUBMIT_FAILED";
  /** Diagnostic detail. */
  detail?: string;
}
