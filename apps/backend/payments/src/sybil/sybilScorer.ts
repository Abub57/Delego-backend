/**
 * Anti-Sybil Score Calculator (Issue #anti-sybil)
 *
 * Discounts reviews from newly-created Stellar accounts or escrow
 * transactions below economic thresholds. Malicious actors can
 * wash-trade negligible 1-stroop transactions to artificially boost
 * merchant reputation; this service assigns a trustWeight < 0.2 in
 * those cases and flags repeat reciprocal transactions between the
 * same buyer/merchant pair.
 */

import { createLogger } from "@delegolabs/utils";

const log = createLogger("payments:sybil", process.env.LOG_LEVEL ?? "info");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum account age (in days) to receive full trust. */
const MIN_ACCOUNT_AGE_DAYS = 7;

/** Minimum escrow volume in USDC to receive full trust. */
const MIN_ESCROW_VOLUME_USDC = 1;

/** Stroops per XLM (Stellar's base unit). */
const STROOPS_PER_XLM = 10_000_000;

/**
 * 1 USDC ≈ 1 USD. We use a fixed exchange rate here; in production
 * this should be read from the exchange-rate oracle.
 */
const USDC_PER_XLM = 0.1;

/** Penalty weight applied to suspicious accounts. */
const SUSPICIOUS_TRUST_WEIGHT = 0.1;

/** Full trust weight for verified accounts. */
const FULL_TRUST_WEIGHT = 1.0;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SybilEvaluationResult {
  isSuspicious: boolean;
  /** 0.0 to 1.0 — weight applied when computing weighted-average ratings. */
  trustWeight: number;
  reasons: string[];
  accountAgeDays: number;
  escrowVolumeUsdc: number;
}

/** Minimal Stellar account info needed for sybil evaluation. */
export interface StellarAccountInfo {
  /** ISO-8601 creation timestamp of the Stellar account. */
  createdAt: string;
  /** Total escrow / payment amount transacted (in stroops). */
  totalTransactionStroops: string;
}

// ---------------------------------------------------------------------------
// Reciprocal-transaction tracking (in-memory; swap out for DB in production)
// ---------------------------------------------------------------------------

/**
 * Tracks (buyer, merchant) pairs and their transaction counts so we can
 * flag wash-trading between the same two addresses.
 */
export interface ReciprocalTransactionStore {
  record(buyerAddress: string, merchantAddress: string): Promise<void>;
  getCount(buyerAddress: string, merchantAddress: string): Promise<number>;
  reset(): void;
}

function pairKey(buyer: string, merchant: string): string {
  return `${buyer}::${merchant}`;
}

export class InMemoryReciprocalStore implements ReciprocalTransactionStore {
  private readonly counts = new Map<string, number>();

  async record(buyerAddress: string, merchantAddress: string): Promise<void> {
    const key = pairKey(buyerAddress, merchantAddress);
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }

  async getCount(buyerAddress: string, merchantAddress: string): Promise<number> {
    return this.counts.get(pairKey(buyerAddress, merchantAddress)) ?? 0;
  }

  reset(): void {
    this.counts.clear();
  }
}

let reciprocalStore: ReciprocalTransactionStore = new InMemoryReciprocalStore();

export function setReciprocalStore(store: ReciprocalTransactionStore): void {
  reciprocalStore = store;
}

export function resetReciprocalStore(): void {
  reciprocalStore = new InMemoryReciprocalStore();
}

// ---------------------------------------------------------------------------
// Horizon account fetching
// ---------------------------------------------------------------------------

/** Fetches minimal account data from the Stellar Horizon API. */
export async function fetchStellarAccountInfo(
  stellarAddress: string,
  horizonBaseUrl = process.env.HORIZON_URL ?? "https://horizon-testnet.stellar.org"
): Promise<StellarAccountInfo | null> {
  try {
    const url = `${horizonBaseUrl}/accounts/${encodeURIComponent(stellarAddress)}`;
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      log.warn("Horizon account fetch failed", { stellarAddress, status: res.status });
      return null;
    }
    const data = (await res.json()) as {
      id: string;
      created_at?: string;
      last_modified_time?: string;
      balances?: Array<{ balance: string; asset_type: string }>;
    };

    const createdAt = data.created_at ?? data.last_modified_time ?? new Date().toISOString();
    // Sum up all native (XLM) balance as a proxy for transaction volume.
    const xlmBalance = data.balances?.find((b) => b.asset_type === "native")?.balance ?? "0";
    const totalStroops = BigInt(Math.round(parseFloat(xlmBalance) * STROOPS_PER_XLM)).toString();

    return { createdAt, totalTransactionStroops: totalStroops };
  } catch (err) {
    log.error("fetchStellarAccountInfo failed", {
      stellarAddress,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Core evaluation logic
// ---------------------------------------------------------------------------

/**
 * Converts a stroop amount to an approximate USDC value.
 * stroops → XLM → USDC (using a fixed rate).
 */
function stroopsToUsdc(stroops: string): number {
  const xlm = Number(BigInt(stroops)) / STROOPS_PER_XLM;
  return xlm * USDC_PER_XLM;
}

/**
 * Computes the account age in days from the Stellar `created_at` timestamp.
 */
function accountAgeDays(createdAtIso: string): number {
  const createdMs = new Date(createdAtIso).getTime();
  const nowMs = Date.now();
  return (nowMs - createdMs) / (1_000 * 60 * 60 * 24);
}

/**
 * Evaluates a buyer's Sybil risk and returns a trust weight in [0, 1].
 *
 * @param buyerAddress    Stellar address of the buyer leaving the review.
 * @param merchantAddress Stellar address of the merchant being reviewed.
 * @param escrowStroops   Amount (in stroops) of the escrow transaction.
 * @param accountInfo     Optional pre-fetched account info (skips Horizon call).
 */
export async function evaluateSybilRisk(
  buyerAddress: string,
  merchantAddress: string,
  escrowStroops: string,
  accountInfo?: StellarAccountInfo | null
): Promise<SybilEvaluationResult> {
  const reasons: string[] = [];

  // Fetch Stellar account data if not already provided.
  const info = accountInfo ?? (await fetchStellarAccountInfo(buyerAddress));
  const ageDays = info ? accountAgeDays(info.createdAt) : 0;
  const escrowVolumeUsdc = stroopsToUsdc(escrowStroops);

  let isSuspicious = false;

  if (ageDays < MIN_ACCOUNT_AGE_DAYS) {
    isSuspicious = true;
    reasons.push(`Account is only ${ageDays.toFixed(1)} days old (minimum: ${MIN_ACCOUNT_AGE_DAYS})`);
  }

  if (escrowVolumeUsdc < MIN_ESCROW_VOLUME_USDC) {
    isSuspicious = true;
    reasons.push(
      `Escrow volume $${escrowVolumeUsdc.toFixed(6)} USDC is below the minimum $${MIN_ESCROW_VOLUME_USDC} USDC`
    );
  }

  // Check for reciprocal wash-trading between this exact (buyer, merchant) pair.
  const reciprocalCount = await reciprocalStore.getCount(buyerAddress, merchantAddress);
  if (reciprocalCount > 0) {
    isSuspicious = true;
    reasons.push(
      `Repeat reciprocal transaction detected between buyer and merchant (count: ${reciprocalCount + 1})`
    );
  }

  // Record this transaction for future checks.
  await reciprocalStore.record(buyerAddress, merchantAddress);

  const trustWeight = isSuspicious ? SUSPICIOUS_TRUST_WEIGHT : FULL_TRUST_WEIGHT;

  log.info("Sybil evaluation complete", {
    buyerAddress,
    merchantAddress,
    isSuspicious,
    trustWeight,
    ageDays,
    escrowVolumeUsdc,
    reasons,
  });

  return {
    isSuspicious,
    trustWeight,
    reasons,
    accountAgeDays: ageDays,
    escrowVolumeUsdc,
  };
}

// ---------------------------------------------------------------------------
// Weighted average rating calculator
// ---------------------------------------------------------------------------

export interface WeightedRatingInput {
  rating: number; // 1-5
  trustWeight: number; // 0.0-1.0
}

/**
 * Computes a trust-weighted average rating from a set of review inputs.
 * Reviews with a low trust weight (sybil suspects) contribute proportionally
 * less to the final score.
 *
 * Returns `null` if the total weight sums to zero (no valid reviews).
 */
export function computeWeightedAverageRating(reviews: WeightedRatingInput[]): number | null {
  if (reviews.length === 0) return null;

  let weightedSum = 0;
  let totalWeight = 0;

  for (const { rating, trustWeight } of reviews) {
    weightedSum += rating * trustWeight;
    totalWeight += trustWeight;
  }

  if (totalWeight === 0) return null;

  return weightedSum / totalWeight;
}
