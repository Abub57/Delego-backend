// Issue #302 — Transaction risk scoring & fraud detection pipeline.
//
// Scores an order 0–100 from three signals and turns the score into a
// recommendation. A score above 80 blocks the order: `enforceFraudCheck`
// alerts the user and throws, so execution cannot continue.

import type {
  FraudEvaluationRequest,
  FraudEvaluationScore,
  MerchantInfoSource,
  OrderHistorySource,
  UserAlerter,
} from "./types.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Points added per risk factor. Each signal contributes at most one factor,
 * and the total is capped at 100. The worst case for a single signal alone
 * stays below the block threshold, so blocking takes at least two signals.
 */
export const RISK_WEIGHTS = {
  /** 5+ orders in the last hour. */
  velocitySpike: 40,
  /** 3–4 orders in the last hour. */
  elevatedVelocity: 20,
  /** Merchant address not registered at all. */
  unknownMerchant: 40,
  /** Merchant registered less than 7 days ago. */
  newMerchant: 30,
  /** Merchant registered 7–30 days ago. */
  youngMerchant: 10,
  /** Reputation below 30. */
  lowReputation: 30,
  /** Reputation 30–59. */
  mediocreReputation: 10,
  /** Amount at least 5× the user's average. */
  unusualAmount: 30,
  /** Amount 3–5× the user's average. */
  elevatedAmount: 15,
} as const;

/** Scores strictly above this block the order (#302). */
export const BLOCK_THRESHOLD = 80;
/** Scores strictly above this (and not blocked) ask for step-up verification. */
export const CHALLENGE_THRESHOLD = 50;

export interface FraudScoringDeps {
  merchants: MerchantInfoSource;
  history: OrderHistorySource;
  /** Clock, injectable for tests. */
  now?: () => Date;
}

export class InvalidFraudRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidFraudRequestError";
  }
}

function parseAmount(amountStroops: string): bigint {
  if (!/^\d+$/.test(amountStroops)) {
    throw new InvalidFraudRequestError(
      `amountStroops must be a non-negative integer string, got "${amountStroops}"`
    );
  }
  return BigInt(amountStroops);
}

export function recommendationFor(riskScore: number): FraudEvaluationScore["recommendation"] {
  if (riskScore > BLOCK_THRESHOLD) return "block";
  if (riskScore > CHALLENGE_THRESHOLD) return "challenge";
  return "allow";
}

/** Score one order. Pure apart from reading the two data sources. */
export async function scoreTransaction(
  request: FraudEvaluationRequest,
  deps: FraudScoringDeps
): Promise<FraudEvaluationScore> {
  const amount = parseAmount(request.amountStroops);
  const now = deps.now?.() ?? new Date();
  const factors: string[] = [];
  let score = 0;
  const add = (points: number, factor: string) => {
    score += points;
    factors.push(factor);
  };

  const [ordersLastHour, merchant, averageAmount] = await Promise.all([
    deps.history.countOrders(request.userId, HOUR_MS, now),
    deps.merchants.getMerchant(request.merchantAddress),
    deps.history.getAverageOrderAmountStroops(request.userId),
  ]);

  // Velocity: orders per hour.
  if (ordersLastHour >= 5) {
    add(RISK_WEIGHTS.velocitySpike, `velocity_spike: ${ordersLastHour} orders in the last hour`);
  } else if (ordersLastHour >= 3) {
    add(RISK_WEIGHTS.elevatedVelocity, `elevated_velocity: ${ordersLastHour} orders in the last hour`);
  }

  // Merchant age and reputation.
  if (!merchant) {
    add(RISK_WEIGHTS.unknownMerchant, `unknown_merchant: ${request.merchantAddress} is not registered`);
  } else {
    const ageDays = Math.floor((now.getTime() - merchant.createdAt.getTime()) / DAY_MS);
    if (ageDays < 7) {
      add(RISK_WEIGHTS.newMerchant, `new_merchant: registered ${ageDays} day(s) ago`);
    } else if (ageDays < 30) {
      add(RISK_WEIGHTS.youngMerchant, `young_merchant: registered ${ageDays} days ago`);
    }

    if (merchant.reputationScore < 30) {
      add(RISK_WEIGHTS.lowReputation, `low_merchant_reputation: ${merchant.reputationScore}/100`);
    } else if (merchant.reputationScore < 60) {
      add(RISK_WEIGHTS.mediocreReputation, `mediocre_merchant_reputation: ${merchant.reputationScore}/100`);
    }
  }

  // Unusual order amount, relative to the user's own history.
  if (averageAmount !== null && averageAmount > 0n) {
    if (amount >= averageAmount * 5n) {
      add(RISK_WEIGHTS.unusualAmount, `unusual_amount: ${amount} stroops is 5x+ the user's average of ${averageAmount}`);
    } else if (amount >= averageAmount * 3n) {
      add(RISK_WEIGHTS.elevatedAmount, `elevated_amount: ${amount} stroops is 3x+ the user's average of ${averageAmount}`);
    }
  }

  const riskScore = Math.min(100, score);
  return { riskScore, recommendation: recommendationFor(riskScore), riskFactors: factors };
}

export class FraudBlockedError extends Error {
  constructor(
    readonly orderId: string,
    readonly score: FraudEvaluationScore
  ) {
    super(
      `Order ${orderId} blocked by fraud check (risk score ${score.riskScore}): ` +
        score.riskFactors.join("; ")
    );
    this.name = "FraudBlockedError";
  }
}

export interface FraudEnforcementDeps extends FraudScoringDeps {
  alerter: UserAlerter;
}

/**
 * Score an order and stop it if it is high risk.
 *
 * On `block` (score > 80) the user is alerted first and then
 * `FraudBlockedError` is thrown, so the caller cannot proceed with the order.
 * For `allow` and `challenge` the score is returned and the caller decides
 * (a challenge should trigger step-up verification before execution).
 */
export async function enforceFraudCheck(
  request: FraudEvaluationRequest,
  deps: FraudEnforcementDeps
): Promise<FraudEvaluationScore> {
  const score = await scoreTransaction(request, deps);
  if (score.recommendation === "block") {
    await deps.alerter.alertBlocked(request, score);
    throw new FraudBlockedError(request.orderId, score);
  }
  return score;
}
