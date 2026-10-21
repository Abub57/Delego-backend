import { describe, expect, it, vi } from "vitest";
import {
  BLOCK_THRESHOLD,
  enforceFraudCheck,
  FraudBlockedError,
  InvalidFraudRequestError,
  recommendationFor,
  RISK_WEIGHTS,
  scoreTransaction,
} from "./scorer.js";
import {
  FRAUD_ALERT_STREAM,
  InMemoryMerchantInfoSource,
  InMemoryOrderHistorySource,
  PostgresMerchantInfoSource,
  RedisStreamUserAlerter,
} from "./sources.js";
import type { FraudEvaluationRequest, UserAlerter } from "./types.js";

const NOW = new Date("2026-09-28T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const MERCHANT = "GMERCHANTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const request: FraudEvaluationRequest = {
  orderId: "ord-1",
  userId: "user-1",
  merchantAddress: MERCHANT,
  amountStroops: "100000000", // 10 XLM
  ipAddress: "203.0.113.7",
};

interface Setup {
  ordersLastHour?: number;
  averageStroops?: bigint | null;
  merchant?: { ageDays: number; reputation: number } | null;
}

function setup({ ordersLastHour = 0, averageStroops = 100_000_000n, merchant = { ageDays: 400, reputation: 95 } }: Setup = {}) {
  const history = new InMemoryOrderHistorySource();
  for (let i = 0; i < ordersLastHour; i++) {
    history.record({ userId: "user-1", amountStroops: averageStroops ?? 1n, at: new Date(NOW.getTime() - (i + 1) * 60_000) });
  }
  if (ordersLastHour === 0 && averageStroops !== null) {
    // History from last month: sets the average without counting as velocity.
    history.record({ userId: "user-1", amountStroops: averageStroops, at: new Date(NOW.getTime() - 30 * DAY) });
  }
  const merchants = new InMemoryMerchantInfoSource();
  if (merchant) {
    merchants.set(MERCHANT, {
      createdAt: new Date(NOW.getTime() - merchant.ageDays * DAY),
      reputationScore: merchant.reputation,
    });
  }
  return { history, merchants, now: () => NOW };
}

describe("scoreTransaction", () => {
  it("allows a normal order with a score of 0", async () => {
    expect(await scoreTransaction(request, setup())).toEqual({
      riskScore: 0,
      recommendation: "allow",
      riskFactors: [],
    });
  });

  describe("velocity", () => {
    it("flags a spike of 5+ orders in the last hour", async () => {
      const score = await scoreTransaction(request, setup({ ordersLastHour: 5 }));
      expect(score.riskScore).toBe(RISK_WEIGHTS.velocitySpike);
      expect(score.riskFactors).toEqual(["velocity_spike: 5 orders in the last hour"]);
    });

    it("flags elevated velocity at 3 orders", async () => {
      const score = await scoreTransaction(request, setup({ ordersLastHour: 3 }));
      expect(score.riskFactors).toEqual(["elevated_velocity: 3 orders in the last hour"]);
    });

    it("ignores orders older than an hour", async () => {
      const deps = setup();
      for (let i = 0; i < 6; i++) {
        deps.history.record({ userId: "user-1", amountStroops: 100_000_000n, at: new Date(NOW.getTime() - 2 * 60 * 60_000) });
      }
      expect((await scoreTransaction(request, deps)).riskScore).toBe(0);
    });
  });

  describe("merchant age and reputation", () => {
    it("flags an unregistered merchant", async () => {
      const score = await scoreTransaction(request, setup({ merchant: null }));
      expect(score.riskScore).toBe(RISK_WEIGHTS.unknownMerchant);
      expect(score.riskFactors[0]).toMatch(/^unknown_merchant: /);
    });

    it("flags a merchant registered under 7 days ago", async () => {
      const score = await scoreTransaction(request, setup({ merchant: { ageDays: 2, reputation: 95 } }));
      expect(score.riskFactors).toEqual(["new_merchant: registered 2 day(s) ago"]);
    });

    it("gives a smaller score to a merchant 7-30 days old", async () => {
      const score = await scoreTransaction(request, setup({ merchant: { ageDays: 20, reputation: 95 } }));
      expect(score.riskScore).toBe(RISK_WEIGHTS.youngMerchant);
    });

    it("flags low and mediocre reputation", async () => {
      const low = await scoreTransaction(request, setup({ merchant: { ageDays: 400, reputation: 10 } }));
      expect(low.riskFactors).toEqual(["low_merchant_reputation: 10/100"]);
      const mid = await scoreTransaction(request, setup({ merchant: { ageDays: 400, reputation: 45 } }));
      expect(mid.riskScore).toBe(RISK_WEIGHTS.mediocreReputation);
    });
  });

  describe("unusual amount", () => {
    it("flags an amount 5x the user's average", async () => {
      const score = await scoreTransaction({ ...request, amountStroops: "500000000" }, setup());
      expect(score.riskScore).toBe(RISK_WEIGHTS.unusualAmount);
      expect(score.riskFactors[0]).toMatch(/^unusual_amount: /);
    });

    it("flags an amount 3x the user's average less heavily", async () => {
      const score = await scoreTransaction({ ...request, amountStroops: "300000000" }, setup());
      expect(score.riskScore).toBe(RISK_WEIGHTS.elevatedAmount);
    });

    it("does not flag the first order a user makes", async () => {
      const score = await scoreTransaction({ ...request, amountStroops: "999999999999" }, setup({ averageStroops: null }));
      expect(score.riskScore).toBe(0);
    });
  });

  it("blocks when signals add up past 80", async () => {
    const score = await scoreTransaction(
      { ...request, amountStroops: "500000000" },
      setup({ ordersLastHour: 5, merchant: { ageDays: 1, reputation: 20 } })
    );
    expect(score.recommendation).toBe("block");
    expect(score.riskScore).toBe(100); // 40 + 30 + 30 + 30 = 130, capped
    expect(score.riskFactors).toHaveLength(4);
  });

  it("no single signal alone reaches the block threshold", () => {
    const maxPerSignal = [
      RISK_WEIGHTS.velocitySpike,
      Math.max(RISK_WEIGHTS.unknownMerchant, RISK_WEIGHTS.newMerchant + RISK_WEIGHTS.lowReputation),
      RISK_WEIGHTS.unusualAmount,
    ];
    for (const points of maxPerSignal) expect(points).toBeLessThanOrEqual(BLOCK_THRESHOLD);
  });

  it("rejects an amount that is not an integer string", async () => {
    await expect(scoreTransaction({ ...request, amountStroops: "10.5" }, setup())).rejects.toBeInstanceOf(
      InvalidFraudRequestError
    );
  });
});

describe("recommendationFor", () => {
  it.each([
    [0, "allow"],
    [50, "allow"],
    [51, "challenge"],
    [80, "challenge"],
    [81, "block"],
    [100, "block"],
  ] as const)("score %i -> %s", (score, expected) => {
    expect(recommendationFor(score)).toBe(expected);
  });
});

describe("enforceFraudCheck", () => {
  function alerter(): UserAlerter & { alertBlocked: ReturnType<typeof vi.fn> } {
    return { alertBlocked: vi.fn().mockResolvedValue(undefined) };
  }

  it("blocks execution and alerts the user when the score is above 80", async () => {
    const alerts = alerter();
    const deps = { ...setup({ ordersLastHour: 5, merchant: null }), alerter: alerts }; // 40 + 40 = 80... plus amount
    const risky = { ...request, amountStroops: "500000000" }; // + 30 -> 110 -> 100

    const error = await enforceFraudCheck(risky, deps).catch((e) => e);

    expect(error).toBeInstanceOf(FraudBlockedError);
    expect((error as FraudBlockedError).score.riskScore).toBe(100);
    expect(alerts.alertBlocked).toHaveBeenCalledTimes(1);
    expect(alerts.alertBlocked).toHaveBeenCalledWith(risky, (error as FraudBlockedError).score);
  });

  it("does not block or alert at exactly 80", async () => {
    const alerts = alerter();
    const deps = { ...setup({ ordersLastHour: 5, merchant: null }), alerter: alerts }; // 40 + 40
    const score = await enforceFraudCheck(request, deps);
    expect(score).toMatchObject({ riskScore: 80, recommendation: "challenge" });
    expect(alerts.alertBlocked).not.toHaveBeenCalled();
  });

  it("lets a low-risk order through without alerting", async () => {
    const alerts = alerter();
    const score = await enforceFraudCheck(request, { ...setup(), alerter: alerts });
    expect(score.recommendation).toBe("allow");
    expect(alerts.alertBlocked).not.toHaveBeenCalled();
  });

  it("publishes the alert to the fraud:alerts stream end to end", async () => {
    const redis = { xadd: vi.fn().mockResolvedValue("1-0") };
    const deps = {
      ...setup({ ordersLastHour: 6, merchant: { ageDays: 0, reputation: 5 } }),
      alerter: new RedisStreamUserAlerter(redis, FRAUD_ALERT_STREAM, () => NOW),
    };

    await expect(enforceFraudCheck(request, deps)).rejects.toBeInstanceOf(FraudBlockedError);

    expect(redis.xadd).toHaveBeenCalledTimes(1);
    const [stream, id, field, json] = redis.xadd.mock.calls[0];
    expect([stream, id, field]).toEqual(["fraud:alerts", "*", "data"]);
    expect(JSON.parse(json)).toEqual({
      type: "fraud.blocked",
      orderId: "ord-1",
      userId: "user-1",
      riskScore: 100,
      riskFactors: expect.arrayContaining([expect.stringMatching(/^velocity_spike/)]),
      occurredAt: NOW.toISOString(),
    });
  });
});

describe("PostgresMerchantInfoSource", () => {
  it("reads age and reputation by Stellar address", async () => {
    const created = new Date("2026-01-01T00:00:00Z");
    const db = { query: vi.fn().mockResolvedValue({ rows: [{ created_at: created, reputation_score: 72 }] }) };
    const profile = await new PostgresMerchantInfoSource(db).getMerchant(MERCHANT);
    expect(profile).toEqual({ createdAt: created, reputationScore: 72 });
    expect(db.query).toHaveBeenCalledWith(expect.stringMatching(/FROM merchants WHERE stellar_address = \$1/), [MERCHANT]);
  });

  it("returns null for an unregistered merchant", async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    expect(await new PostgresMerchantInfoSource(db).getMerchant(MERCHANT)).toBeNull();
  });
});
