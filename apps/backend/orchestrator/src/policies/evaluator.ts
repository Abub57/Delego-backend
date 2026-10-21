// Issue #301 — Hierarchical multi-level budget & category policy evaluator.
//
// Evaluates every spending rule for an order in one pass, against one
// snapshot of the user's limits and rolling spend:
//
//   merchant allow/deny lists  → which merchants may be paid at all
//   category allow/deny lists  → which categories may be bought at all
//   per-transaction cap        → the size of this single order
//   global daily / weekly caps → total wallet spend in the rolling window
//   category daily / weekly    → spend in this order's category
//
// The order is rejected if ANY rule is violated, and every violated rule is
// reported, not just the first. Spend windows are rolling: "daily" is the 24
// hours ending at `timestamp`, "weekly" the 7 days ending at `timestamp`.
//
// Where the limits and spend totals come from is behind `PolicyDataSource`.
// For the verdict to be race-free under concurrent orders, a caller should
// read the snapshot and record the spend inside one transaction.

/** Input for one evaluation (shape from #301). */
export interface PolicyEvaluationContext {
  userId: string;
  merchantAddress: string;
  category: string;
  orderAmountStroops: bigint;
  timestamp: Date;
}

/** Verdict for one evaluation (shape from #301). */
export interface PolicyEvaluationResult {
  allowed: boolean;
  violatedRules: string[];
  requiresDualApproval: boolean;
  applicableDailyAllowanceRemainingStroops: bigint;
}

/** Daily / weekly caps for one level (global or a single category). */
export interface SpendCaps {
  dailyStroops?: bigint;
  weeklyStroops?: bigint;
}

/** A user's spending policy. Any cap left undefined is not enforced. */
export interface SpendingPolicyLimits extends SpendCaps {
  perTransactionStroops?: bigint;
  /** Caps per category, keyed by category name (matched case-insensitively). */
  categoryCaps?: Record<string, SpendCaps>;
  /** When non-empty, only these merchants may be paid. */
  allowedMerchants?: string[];
  /** Merchants that may never be paid (checked even when an allowlist is set). */
  restrictedMerchants?: string[];
  /** When non-empty, only these categories may be bought. */
  allowedCategories?: string[];
  /** Categories that may never be bought. */
  restrictedCategories?: string[];
  /** Orders at or above this amount need a second approver. */
  dualApprovalThresholdStroops?: bigint;
}

/** Spend already recorded in the rolling windows ending at the order's timestamp. */
export interface SpendTotals {
  dailyStroops: bigint;
  weeklyStroops: bigint;
  categoryDailyStroops: bigint;
  categoryWeeklyStroops: bigint;
}

export interface PolicyDataSource {
  /** The user's policy, or null when the user has none. */
  getPolicy(userId: string): Promise<SpendingPolicyLimits | null>;
  /** Rolling spend totals for the user (overall and in `category`) as of `asOf`. */
  getSpendTotals(userId: string, category: string, asOf: Date): Promise<SpendTotals>;
}

/** Rule identifiers, the prefix of every `violatedRules` entry. */
export const PolicyRule = {
  NoPolicy: "no_policy",
  InvalidAmount: "invalid_amount",
  MerchantRestricted: "merchant_restricted",
  MerchantNotAllowed: "merchant_not_allowed",
  CategoryRestricted: "category_restricted",
  CategoryNotAllowed: "category_not_allowed",
  PerTransactionLimit: "per_transaction_limit",
  DailyLimit: "daily_limit",
  WeeklyLimit: "weekly_limit",
  CategoryDailyLimit: "category_daily_limit",
  CategoryWeeklyLimit: "category_weekly_limit",
} as const;

/**
 * Reported as `applicableDailyAllowanceRemainingStroops` when no daily cap
 * applies. It is the largest Postgres BIGINT, the type every stroop column
 * uses, so callers can store or compare it without special-casing.
 */
export const UNLIMITED_ALLOWANCE_STROOPS = 9_223_372_036_854_775_807n;

export const DAY_MS = 24 * 60 * 60 * 1000;
export const WEEK_MS = 7 * DAY_MS;

function normalizeCategory(category: string): string {
  return category.trim().toLowerCase();
}

function includesCategory(list: string[] | undefined, category: string): boolean {
  return (list ?? []).some((c) => normalizeCategory(c) === category);
}

function findCategoryCaps(
  caps: Record<string, SpendCaps> | undefined,
  category: string
): SpendCaps | undefined {
  if (!caps) return undefined;
  const key = Object.keys(caps).find((k) => normalizeCategory(k) === category);
  return key === undefined ? undefined : caps[key];
}

function violation(rule: string, explanation: string): string {
  return `${rule}: ${explanation}`;
}

function remaining(cap: bigint, spent: bigint): bigint {
  const left = cap - spent;
  return left > 0n ? left : 0n;
}

/**
 * Evaluate an order against the user's spending policy.
 *
 * A user with no policy is rejected (`no_policy`): spending on someone's
 * behalf is only allowed where a limit has explicitly been granted.
 */
export async function evaluateSpendingPolicy(
  context: PolicyEvaluationContext,
  source: PolicyDataSource
): Promise<PolicyEvaluationResult> {
  const amount = context.orderAmountStroops;
  const category = normalizeCategory(context.category);

  if (amount <= 0n) {
    return {
      allowed: false,
      violatedRules: [
        violation(PolicyRule.InvalidAmount, `order amount must be positive, got ${amount} stroops`),
      ],
      requiresDualApproval: false,
      applicableDailyAllowanceRemainingStroops: 0n,
    };
  }

  const policy = await source.getPolicy(context.userId);
  if (!policy) {
    return {
      allowed: false,
      violatedRules: [
        violation(PolicyRule.NoPolicy, `user ${context.userId} has no spending policy`),
      ],
      requiresDualApproval: false,
      applicableDailyAllowanceRemainingStroops: 0n,
    };
  }

  const spent = await source.getSpendTotals(context.userId, category, context.timestamp);
  const categoryCaps = findCategoryCaps(policy.categoryCaps, category);
  const violatedRules: string[] = [];

  // Who and what may be paid.
  if ((policy.restrictedMerchants ?? []).includes(context.merchantAddress)) {
    violatedRules.push(
      violation(PolicyRule.MerchantRestricted, `merchant ${context.merchantAddress} is blocked`)
    );
  } else if (
    (policy.allowedMerchants ?? []).length > 0 &&
    !policy.allowedMerchants!.includes(context.merchantAddress)
  ) {
    violatedRules.push(
      violation(
        PolicyRule.MerchantNotAllowed,
        `merchant ${context.merchantAddress} is not on the allowed merchant list`
      )
    );
  }

  if (includesCategory(policy.restrictedCategories, category)) {
    violatedRules.push(
      violation(PolicyRule.CategoryRestricted, `category "${category}" is blocked`)
    );
  } else if (
    (policy.allowedCategories ?? []).length > 0 &&
    !includesCategory(policy.allowedCategories, category)
  ) {
    violatedRules.push(
      violation(
        PolicyRule.CategoryNotAllowed,
        `category "${category}" is not on the allowed category list`
      )
    );
  }

  // How much may be spent.
  if (policy.perTransactionStroops !== undefined && amount > policy.perTransactionStroops) {
    violatedRules.push(
      violation(
        PolicyRule.PerTransactionLimit,
        `order of ${amount} stroops exceeds the per-transaction limit of ${policy.perTransactionStroops} stroops`
      )
    );
  }

  const checkCap = (
    rule: string,
    label: string,
    cap: bigint | undefined,
    alreadySpent: bigint
  ): void => {
    if (cap === undefined || alreadySpent + amount <= cap) return;
    violatedRules.push(
      violation(
        rule,
        `order of ${amount} stroops would bring ${label} spend to ${alreadySpent + amount} stroops, ` +
          `over the limit of ${cap} stroops (${remaining(cap, alreadySpent)} stroops left)`
      )
    );
  };

  checkCap(PolicyRule.DailyLimit, "24-hour", policy.dailyStroops, spent.dailyStroops);
  checkCap(PolicyRule.WeeklyLimit, "7-day", policy.weeklyStroops, spent.weeklyStroops);
  checkCap(
    PolicyRule.CategoryDailyLimit,
    `24-hour "${category}"`,
    categoryCaps?.dailyStroops,
    spent.categoryDailyStroops
  );
  checkCap(
    PolicyRule.CategoryWeeklyLimit,
    `7-day "${category}"`,
    categoryCaps?.weeklyStroops,
    spent.categoryWeeklyStroops
  );

  // The tightest daily allowance that applies to this order, before it is placed.
  const dailyAllowances: bigint[] = [];
  if (policy.dailyStroops !== undefined) {
    dailyAllowances.push(remaining(policy.dailyStroops, spent.dailyStroops));
  }
  if (categoryCaps?.dailyStroops !== undefined) {
    dailyAllowances.push(remaining(categoryCaps.dailyStroops, spent.categoryDailyStroops));
  }
  const applicableDailyAllowanceRemainingStroops =
    dailyAllowances.length === 0
      ? UNLIMITED_ALLOWANCE_STROOPS
      : dailyAllowances.reduce((min, v) => (v < min ? v : min));

  return {
    allowed: violatedRules.length === 0,
    violatedRules,
    requiresDualApproval:
      policy.dualApprovalThresholdStroops !== undefined &&
      amount >= policy.dualApprovalThresholdStroops,
    applicableDailyAllowanceRemainingStroops,
  };
}

// ---------------------------------------------------------------------------
// In-memory data source
// ---------------------------------------------------------------------------

export interface RecordedSpend {
  userId: string;
  category: string;
  amountStroops: bigint;
  at: Date;
}

/**
 * Keeps policies and spend in memory. Used by tests, and usable wherever a
 * process-local source is enough.
 */
export class InMemoryPolicyDataSource implements PolicyDataSource {
  private readonly policies = new Map<string, SpendingPolicyLimits>();
  private readonly spends: RecordedSpend[] = [];

  setPolicy(userId: string, policy: SpendingPolicyLimits): void {
    this.policies.set(userId, policy);
  }

  recordSpend(spend: RecordedSpend): void {
    this.spends.push({ ...spend, category: normalizeCategory(spend.category) });
  }

  async getPolicy(userId: string): Promise<SpendingPolicyLimits | null> {
    return this.policies.get(userId) ?? null;
  }

  async getSpendTotals(userId: string, category: string, asOf: Date): Promise<SpendTotals> {
    const end = asOf.getTime();
    const wanted = normalizeCategory(category);
    const totals: SpendTotals = {
      dailyStroops: 0n,
      weeklyStroops: 0n,
      categoryDailyStroops: 0n,
      categoryWeeklyStroops: 0n,
    };

    for (const spend of this.spends) {
      if (spend.userId !== userId) continue;
      const at = spend.at.getTime();
      if (at > end) continue; // after the order: not part of this snapshot
      const inDay = at > end - DAY_MS;
      const inWeek = at > end - WEEK_MS;
      const sameCategory = spend.category === wanted;
      if (inDay) totals.dailyStroops += spend.amountStroops;
      if (inWeek) totals.weeklyStroops += spend.amountStroops;
      if (inDay && sameCategory) totals.categoryDailyStroops += spend.amountStroops;
      if (inWeek && sameCategory) totals.categoryWeeklyStroops += spend.amountStroops;
    }
    return totals;
  }
}
