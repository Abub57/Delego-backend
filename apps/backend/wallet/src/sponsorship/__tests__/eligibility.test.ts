import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  checkEligibility,
  isValidStellarAccount,
  isValidSorobanContract,
} from "../eligibility.js";
import type { GasSponsorshipPolicy, SponsoredSubmitRequest } from "../types.js";

vi.mock("@delegolabs/utils", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// 56-char identifiers that satisfy the base32 regexes.
const VALID_BUYER = "G" + "A".repeat(55);
const OTHER_BUYER = "G" + "B".repeat(55);
const VALID_CONTRACT = "C" + "A".repeat(55);
const OTHER_CONTRACT = "C" + "B".repeat(55);

const POLICY: GasSponsorshipPolicy = {
  maxDailySponsoredLedgers: 3,
  maxSpendPerAccountStroops: "5000",
  authorizedContracts: [VALID_CONTRACT],
};

function makeManagerMock() {
  return {
    isConfigured: vi.fn(() => true),
    getPolicy: vi.fn(() => POLICY),
    getDailyRemaining: vi.fn(async () => 3),
    getAccountRemainingStroops: vi.fn(async () => 5000n),
  };
}

function makeRequest(overrides: Partial<SponsoredSubmitRequest> = {}): SponsoredSubmitRequest {
  return {
    buyerAccount: VALID_BUYER,
    txXdr: "AAAA",
    contractId: VALID_CONTRACT,
    feeStroops: "100",
    ...overrides,
  };
}

describe("validators", () => {
  it("accepts valid G... account", () => {
    expect(isValidStellarAccount(VALID_BUYER)).toBe(true);
  });

  it("rejects malformed account", () => {
    expect(isValidStellarAccount("not-an-account")).toBe(false);
    expect(isValidStellarAccount("S" + "A".repeat(55))).toBe(false);
    expect(isValidStellarAccount("G" + "A".repeat(10))).toBe(false);
  });

  it("accepts valid C... contract", () => {
    expect(isValidSorobanContract(VALID_CONTRACT)).toBe(true);
  });

  it("rejects malformed contract", () => {
    expect(isValidSorobanContract("not-a-contract")).toBe(false);
    expect(isValidSorobanContract("G" + "A".repeat(55))).toBe(false);
    expect(isValidSorobanContract("C" + "A".repeat(10))).toBe(false);
  });
});

describe("checkEligibility", () => {
  let manager: ReturnType<typeof makeManagerMock>;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = makeManagerMock();
  });

  it("denies when sponsor is not configured", async () => {
    manager.isConfigured.mockReturnValueOnce(false);
    const res = await checkEligibility(manager as any, makeRequest());
    expect(res.eligible).toBe(false);
    expect(res.reason).toBe("SPONSOR_NOT_CONFIGURED");
  });

  it("denies malformed buyer account", async () => {
    const res = await checkEligibility(manager as any, makeRequest({ buyerAccount: "bad" }));
    expect(res.eligible).toBe(false);
    expect(res.reason).toBe("INVALID_REQUEST");
  });

  it("denies malformed contract id", async () => {
    const res = await checkEligibility(manager as any, makeRequest({ contractId: "bad" }));
    expect(res.eligible).toBe(false);
    expect(res.reason).toBe("INVALID_REQUEST");
  });

  it("denies non-numeric fee stroops", async () => {
    const res = await checkEligibility(manager as any, makeRequest({ feeStroops: "abc" }));
    expect(res.eligible).toBe(false);
    expect(res.reason).toBe("INVALID_REQUEST");
  });

  it("denies zero or negative fee stroops", async () => {
    const res = await checkEligibility(manager as any, makeRequest({ feeStroops: "0" }));
    expect(res.eligible).toBe(false);
    expect(res.reason).toBe("INVALID_REQUEST");
  });

  it("denies contract not in allowlist", async () => {
    const res = await checkEligibility(
      manager as any,
      makeRequest({ contractId: OTHER_CONTRACT }),
    );
    expect(res.eligible).toBe(false);
    expect(res.reason).toBe("CONTRACT_NOT_AUTHORIZED");
  });

  it("denies when daily ledger budget is exhausted", async () => {
    manager.getDailyRemaining.mockResolvedValueOnce(0);
    const res = await checkEligibility(manager as any, makeRequest());
    expect(res.eligible).toBe(false);
    expect(res.reason).toBe("DAILY_LEDGER_BUDGET_EXCEEDED");
    expect(res.dailyRemaining).toBe(0);
  });

  it("denies when per-account stroop budget is insufficient", async () => {
    manager.getAccountRemainingStroops.mockResolvedValueOnce(50n);
    const res = await checkEligibility(manager as any, makeRequest({ feeStroops: "100" }));
    expect(res.eligible).toBe(false);
    expect(res.reason).toBe("ACCOUNT_BUDGET_EXCEEDED");
    expect(res.accountRemainingStroops).toBe("50");
  });

  it("allows a request that passes every check", async () => {
    const res = await checkEligibility(manager as any, makeRequest());
    expect(res.eligible).toBe(true);
    expect(res.dailyRemaining).toBe(2);
    expect(res.accountRemainingStroops).toBe("4900");
  });

  it("checks both buyers independently via getAccountRemainingStroops", async () => {
    manager.getAccountRemainingStroops
      .mockResolvedValueOnce(5000n)
      .mockResolvedValueOnce(10n);

    const a = await checkEligibility(manager as any, makeRequest({ buyerAccount: VALID_BUYER }));
    const b = await checkEligibility(manager as any, makeRequest({ buyerAccount: OTHER_BUYER }));

    expect(a.eligible).toBe(true);
    expect(b.eligible).toBe(false);
    expect(b.reason).toBe("ACCOUNT_BUDGET_EXCEEDED");
  });
});
