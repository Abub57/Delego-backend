/**
 * Sponsorship Eligibility Validator
 *
 * Pure decision function: given a manager (which reads budgets) and a
 * request, decide whether the gas tank will sponsor the submission.
 *
 * No side effects — the caller is responsible for calling
 * `manager.recordSponsored(...)` *after* the sponsored transaction
 * confirms. Keeping this pure makes it trivial to test each denial
 * branch in isolation.
 *
 * Closes #398.
 */

import type { GasTankManager } from "./gasTankManager.js";
import type {
  SponsoredSubmitRequest,
  SponsorshipDecision,
} from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STELLAR_ACCOUNT_RE = /^G[A-Z2-7]{55}$/;
const SOROBAN_CONTRACT_RE = /^C[A-Z2-7]{55}$/;

export function isValidStellarAccount(addr: string): boolean {
  return STELLAR_ACCOUNT_RE.test(addr.trim());
}

export function isValidSorobanContract(id: string): boolean {
  return SOROBAN_CONTRACT_RE.test(id.trim());
}

function parseStroops(s: string): bigint | null {
  if (!/^[0-9]+$/.test(s)) return null;
  try {
    return BigInt(s);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Eligibility check
// ---------------------------------------------------------------------------

export async function checkEligibility(
  manager: GasTankManager,
  request: SponsoredSubmitRequest,
): Promise<SponsorshipDecision> {
  // 0. Sponsor key must be configured.
  if (!manager.isConfigured()) {
    return {
      eligible: false,
      reason: "SPONSOR_NOT_CONFIGURED",
      detail: "No sponsor secret configured on this replica.",
    };
  }

  // 1. Structural validation.
  if (!isValidStellarAccount(request.buyerAccount)) {
    return {
      eligible: false,
      reason: "INVALID_REQUEST",
      detail: `Invalid buyer account: ${request.buyerAccount}`,
    };
  }

  if (!isValidSorobanContract(request.contractId)) {
    return {
      eligible: false,
      reason: "INVALID_REQUEST",
      detail: `Invalid contract ID: ${request.contractId}`,
    };
  }

  const fee = parseStroops(request.feeStroops);
  if (fee === null || fee <= 0n) {
    return {
      eligible: false,
      reason: "INVALID_REQUEST",
      detail: `Invalid fee stroops: ${request.feeStroops}`,
    };
  }

  // 2. Contract allowlist.
  if (!manager.getPolicy().authorizedContracts.includes(request.contractId)) {
    return {
      eligible: false,
      reason: "CONTRACT_NOT_AUTHORIZED",
      detail: `Contract ${request.contractId} is not in the sponsorship allowlist.`,
    };
  }

  // 3. Daily ledger cap.
  const dailyRemaining = await manager.getDailyRemaining();
  if (dailyRemaining <= 0) {
    return {
      eligible: false,
      reason: "DAILY_LEDGER_BUDGET_EXCEEDED",
      detail: `Daily ledger budget exhausted (${manager.getPolicy().maxDailySponsoredLedgers}).`,
      dailyRemaining: 0,
    };
  }

  // 4. Per-account stroop cap.
  const accountRemaining = await manager.getAccountRemainingStroops(request.buyerAccount);
  if (accountRemaining < fee) {
    return {
      eligible: false,
      reason: "ACCOUNT_BUDGET_EXCEEDED",
      detail: `Account ${request.buyerAccount} has ${accountRemaining} stroops remaining, needs ${fee}.`,
      accountRemainingStroops: accountRemaining.toString(),
    };
  }

  // 5. All checks passed.
  return {
    eligible: true,
    dailyRemaining: dailyRemaining - 1,
    accountRemainingStroops: (accountRemaining - fee).toString(),
  };
}
