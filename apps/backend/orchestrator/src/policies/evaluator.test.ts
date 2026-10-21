import { describe, expect, it } from "vitest";
import {
  DAY_MS,
  evaluateSpendingPolicy,
  InMemoryPolicyDataSource,
  PolicyRule,
  UNLIMITED_ALLOWANCE_STROOPS,
  WEEK_MS,
  type PolicyEvaluationContext,
  type SpendingPolicyLimits,
} from "./evaluator.js";

const XLM = 10_000_000n; // stroops
const NOW = new Date("2026-09-28T12:00:00Z");
const MERCHANT = "GMERCHANTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const OTHER_MERCHANT = "GOTHERBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

function context(overrides: Partial<PolicyEvaluationContext> = {}): PolicyEvaluationContext {
  return {
    userId: "user-1",
    merchantAddress: MERCHANT,
    category: "groceries",
    orderAmountStroops: 10n * XLM,
    timestamp: NOW,
    ...overrides,
  };
}

function sourceWith(policy: SpendingPolicyLimits | null): InMemoryPolicyDataSource {
  const source = new InMemoryPolicyDataSource();
  if (policy) source.setPolicy("user-1", policy);
  return source;
}

function spend(source: InMemoryPolicyDataSource, amountXlm: bigint, category: string, msAgo: number) {
  source.recordSpend({
    userId: "user-1",
    category,
    amountStroops: amountXlm * XLM,
    at: new Date(NOW.getTime() - msAgo),
  });
}

function rulesOf(violations: string[]): string[] {
  return violations.map((v) => v.split(":")[0]);
}

describe("evaluateSpendingPolicy", () => {
  it("allows an order within every limit", async () => {
    const source = sourceWith({
      perTransactionStroops: 50n * XLM,
      dailyStroops: 100n * XLM,
      weeklyStroops: 500n * XLM,
      categoryCaps: { groceries: { dailyStroops: 40n * XLM } },
      allowedMerchants: [MERCHANT],
      allowedCategories: ["groceries"],
    });
    spend(source, 20n, "groceries", 60_000);

    const result = await evaluateSpendingPolicy(context(), source);

    expect(result).toEqual({
      allowed: true,
      violatedRules: [],
      requiresDualApproval: false,
      // tightest daily allowance before this order: category 40 - 20 = 20 XLM
      applicableDailyAllowanceRemainingStroops: 20n * XLM,
    });
  });

  describe("rejects when any single limit is breached", () => {
    it("global daily limit", async () => {
      const source = sourceWith({ dailyStroops: 100n * XLM });
      spend(source, 95n, "electronics", 60_000);
      const result = await evaluateSpendingPolicy(context(), source);
      expect(result.allowed).toBe(false);
      expect(rulesOf(result.violatedRules)).toEqual([PolicyRule.DailyLimit]);
      expect(result.violatedRules[0]).toContain("over the limit of 1000000000 stroops");
      expect(result.violatedRules[0]).toContain("50000000 stroops left");
    });

    it("global weekly limit", async () => {
      const source = sourceWith({ dailyStroops: 1000n * XLM, weeklyStroops: 100n * XLM });
      spend(source, 95n, "electronics", 3 * DAY_MS);
      const result = await evaluateSpendingPolicy(context(), source);
      expect(result.allowed).toBe(false);
      expect(rulesOf(result.violatedRules)).toEqual([PolicyRule.WeeklyLimit]);
    });

    it("category daily limit, even with plenty of global allowance", async () => {
      const source = sourceWith({
        dailyStroops: 1000n * XLM,
        categoryCaps: { groceries: { dailyStroops: 25n * XLM } },
      });
      spend(source, 20n, "groceries", 60_000);
      const result = await evaluateSpendingPolicy(context(), source);
      expect(result.allowed).toBe(false);
      expect(rulesOf(result.violatedRules)).toEqual([PolicyRule.CategoryDailyLimit]);
      expect(result.violatedRules[0]).toContain('24-hour "groceries" spend');
    });

    it("category weekly limit", async () => {
      const source = sourceWith({ categoryCaps: { groceries: { weeklyStroops: 25n * XLM } } });
      spend(source, 20n, "groceries", 2 * DAY_MS);
      const result = await evaluateSpendingPolicy(context(), source);
      expect(rulesOf(result.violatedRules)).toEqual([PolicyRule.CategoryWeeklyLimit]);
    });

    it("per-transaction limit", async () => {
      const source = sourceWith({ perTransactionStroops: 5n * XLM });
      const result = await evaluateSpendingPolicy(context(), source);
      expect(result.allowed).toBe(false);
      expect(rulesOf(result.violatedRules)).toEqual([PolicyRule.PerTransactionLimit]);
    });

    it("merchant not on the allowlist", async () => {
      const source = sourceWith({ allowedMerchants: [OTHER_MERCHANT] });
      const result = await evaluateSpendingPolicy(context(), source);
      expect(rulesOf(result.violatedRules)).toEqual([PolicyRule.MerchantNotAllowed]);
    });

    it("restricted merchant, even if also allowlisted", async () => {
      const source = sourceWith({ allowedMerchants: [MERCHANT], restrictedMerchants: [MERCHANT] });
      const result = await evaluateSpendingPolicy(context(), source);
      expect(rulesOf(result.violatedRules)).toEqual([PolicyRule.MerchantRestricted]);
    });

    it("category not on the allowlist", async () => {
      const source = sourceWith({ allowedCategories: ["travel"] });
      const result = await evaluateSpendingPolicy(context(), source);
      expect(rulesOf(result.violatedRules)).toEqual([PolicyRule.CategoryNotAllowed]);
    });

    it("restricted category", async () => {
      const source = sourceWith({ restrictedCategories: ["Groceries"] });
      const result = await evaluateSpendingPolicy(context(), source);
      expect(rulesOf(result.violatedRules)).toEqual([PolicyRule.CategoryRestricted]);
    });
  });

  it("reports every violated rule in one evaluation, not just the first", async () => {
    const source = sourceWith({
      perTransactionStroops: 5n * XLM,
      dailyStroops: 15n * XLM,
      weeklyStroops: 15n * XLM,
      categoryCaps: { groceries: { dailyStroops: 5n * XLM, weeklyStroops: 5n * XLM } },
      allowedMerchants: [OTHER_MERCHANT],
      allowedCategories: ["travel"],
    });
    spend(source, 10n, "groceries", 60_000);

    const result = await evaluateSpendingPolicy(context(), source);

    expect(result.allowed).toBe(false);
    expect(rulesOf(result.violatedRules)).toEqual([
      PolicyRule.MerchantNotAllowed,
      PolicyRule.CategoryNotAllowed,
      PolicyRule.PerTransactionLimit,
      PolicyRule.DailyLimit,
      PolicyRule.WeeklyLimit,
      PolicyRule.CategoryDailyLimit,
      PolicyRule.CategoryWeeklyLimit,
    ]);
  });

  it("allows spending exactly up to a limit", async () => {
    const source = sourceWith({ dailyStroops: 100n * XLM, perTransactionStroops: 10n * XLM });
    spend(source, 90n, "groceries", 60_000);
    const result = await evaluateSpendingPolicy(context(), source);
    expect(result.allowed).toBe(true);
    expect(result.applicableDailyAllowanceRemainingStroops).toBe(10n * XLM);
  });

  it("uses rolling windows: older spend drops out", async () => {
    const source = sourceWith({ dailyStroops: 100n * XLM, weeklyStroops: 100n * XLM });
    spend(source, 95n, "groceries", DAY_MS + 60_000); // just over a day ago
    const daily = await evaluateSpendingPolicy(context(), source);
    expect(rulesOf(daily.violatedRules)).toEqual([PolicyRule.WeeklyLimit]);

    const later = context({ timestamp: new Date(NOW.getTime() + WEEK_MS) });
    const afterAWeek = await evaluateSpendingPolicy(later, source);
    expect(afterAWeek.allowed).toBe(true);
  });

  it("ignores spend recorded after the order's timestamp", async () => {
    const source = sourceWith({ dailyStroops: 100n * XLM });
    spend(source, 95n, "groceries", -60_000); // one minute in the future
    const result = await evaluateSpendingPolicy(context(), source);
    expect(result.allowed).toBe(true);
  });

  it("only counts spend in the same category against category caps", async () => {
    const source = sourceWith({ categoryCaps: { groceries: { dailyStroops: 25n * XLM } } });
    spend(source, 50n, "electronics", 60_000);
    const result = await evaluateSpendingPolicy(context(), source);
    expect(result.allowed).toBe(true);
    expect(result.applicableDailyAllowanceRemainingStroops).toBe(25n * XLM);
  });

  it("matches categories case-insensitively", async () => {
    const source = sourceWith({ categoryCaps: { Groceries: { dailyStroops: 25n * XLM } } });
    spend(source, 20n, "GROCERIES", 60_000);
    const result = await evaluateSpendingPolicy(context({ category: " groceries " }), source);
    expect(rulesOf(result.violatedRules)).toEqual([PolicyRule.CategoryDailyLimit]);
  });

  it("does not count another user's spend", async () => {
    const source = sourceWith({ dailyStroops: 20n * XLM });
    source.recordSpend({ userId: "user-2", category: "groceries", amountStroops: 100n * XLM, at: NOW });
    expect((await evaluateSpendingPolicy(context(), source)).allowed).toBe(true);
  });

  describe("dual approval", () => {
    it("is required at or above the threshold", async () => {
      const source = sourceWith({ dualApprovalThresholdStroops: 10n * XLM });
      expect((await evaluateSpendingPolicy(context(), source)).requiresDualApproval).toBe(true);
    });

    it("is not required below the threshold or without one", async () => {
      const below = sourceWith({ dualApprovalThresholdStroops: 11n * XLM });
      expect((await evaluateSpendingPolicy(context(), below)).requiresDualApproval).toBe(false);
      expect((await evaluateSpendingPolicy(context(), sourceWith({}))).requiresDualApproval).toBe(false);
    });
  });

  describe("applicableDailyAllowanceRemainingStroops", () => {
    it("is the global daily allowance when there is no category cap", async () => {
      const source = sourceWith({ dailyStroops: 100n * XLM });
      spend(source, 30n, "groceries", 60_000);
      const result = await evaluateSpendingPolicy(context(), source);
      expect(result.applicableDailyAllowanceRemainingStroops).toBe(70n * XLM);
    });

    it("never goes below zero", async () => {
      const source = sourceWith({ dailyStroops: 100n * XLM });
      spend(source, 150n, "groceries", 60_000);
      const result = await evaluateSpendingPolicy(context(), source);
      expect(result.applicableDailyAllowanceRemainingStroops).toBe(0n);
    });

    it("is unlimited when no daily cap applies", async () => {
      const result = await evaluateSpendingPolicy(context(), sourceWith({ weeklyStroops: 100n * XLM }));
      expect(result.applicableDailyAllowanceRemainingStroops).toBe(UNLIMITED_ALLOWANCE_STROOPS);
    });
  });

  it("rejects a user with no spending policy", async () => {
    const result = await evaluateSpendingPolicy(context(), sourceWith(null));
    expect(result.allowed).toBe(false);
    expect(rulesOf(result.violatedRules)).toEqual([PolicyRule.NoPolicy]);
  });

  it.each([0n, -5n])("rejects a non-positive amount (%s)", async (amount) => {
    const result = await evaluateSpendingPolicy(
      context({ orderAmountStroops: amount }),
      sourceWith({})
    );
    expect(result.allowed).toBe(false);
    expect(rulesOf(result.violatedRules)).toEqual([PolicyRule.InvalidAmount]);
  });

  it("reads the policy and the spend snapshot once per evaluation", async () => {
    const source = sourceWith({ dailyStroops: 100n * XLM });
    let policyReads = 0;
    let totalReads = 0;
    const counting = {
      getPolicy: (u: string) => (policyReads++, source.getPolicy(u)),
      getSpendTotals: (u: string, c: string, at: Date) => (totalReads++, source.getSpendTotals(u, c, at)),
    };
    await evaluateSpendingPolicy(context(), counting);
    expect([policyReads, totalReads]).toEqual([1, 1]);
  });
});
