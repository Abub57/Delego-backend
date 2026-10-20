/**
 * Reputation Flag Event Processor — Unit Tests
 *
 * Verifies:
 *  - Penalty scores are accumulated correctly.
 *  - Storefront is suspended when total penalty > 100.
 *  - Storefront stays active when total penalty <= 100.
 *  - Notifications are dispatched via publishPaymentEvent.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  handleReputationFlagEvent,
  resetReputationFlagStore,
  SUSPENSION_THRESHOLD,
  type ReputationFlagEvent,
} from "./reputationFlagProcessor.js";

// ---------------------------------------------------------------------------
// Mock publishPaymentEvent so tests don't need a real Redis connection
// ---------------------------------------------------------------------------

vi.mock("../../events/index.js", () => ({
  publishPaymentEvent: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(penaltyPoints: number, merchantAddress = "GMERCHANT"): ReputationFlagEvent {
  return {
    contractId: "CCONTRACT123",
    merchantAddress,
    reporterAddress: "GREPORTER456",
    penaltyPoints,
    reasonCode: 1,
    ledger: 1_000_000,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("handleReputationFlagEvent", () => {
  beforeEach(() => {
    resetReputationFlagStore();
    vi.clearAllMocks();
  });

  it("accumulates penalty points across multiple events", async () => {
    const result1 = await handleReputationFlagEvent(makeEvent(30));
    expect(result1.totalPenaltyScore).toBe(30);
    expect(result1.suspended).toBe(false);

    const result2 = await handleReputationFlagEvent(makeEvent(40));
    expect(result2.totalPenaltyScore).toBe(70);
    expect(result2.suspended).toBe(false);
  });

  it("does NOT suspend when totalPenaltyScore equals the threshold exactly", async () => {
    // Threshold is 100 — equality should NOT suspend (strictly >)
    const result = await handleReputationFlagEvent(makeEvent(SUSPENSION_THRESHOLD));
    expect(result.totalPenaltyScore).toBe(SUSPENSION_THRESHOLD);
    expect(result.suspended).toBe(false);
    expect(result.isActive).toBe(true);
  });

  it("suspends the storefront when totalPenaltyScore exceeds the threshold", async () => {
    // Push just over the limit
    await handleReputationFlagEvent(makeEvent(100)); // = threshold, no suspend
    const result = await handleReputationFlagEvent(makeEvent(1));  // 101 > 100, suspend

    expect(result.totalPenaltyScore).toBe(101);
    expect(result.suspended).toBe(true);
    expect(result.isActive).toBe(false);
  });

  it("suspends in a single event when penalty points exceed threshold alone", async () => {
    const result = await handleReputationFlagEvent(makeEvent(150));
    expect(result.suspended).toBe(true);
    expect(result.totalPenaltyScore).toBe(150);
  });

  it("tracks penalty scores independently per merchant address", async () => {
    await handleReputationFlagEvent(makeEvent(90, "GMERCHANT_A"));
    const resultA = await handleReputationFlagEvent(makeEvent(90, "GMERCHANT_A"));
    const resultB = await handleReputationFlagEvent(makeEvent(50, "GMERCHANT_B"));

    // GMERCHANT_A is now at 180 → suspended
    expect(resultA.suspended).toBe(true);
    // GMERCHANT_B is only at 50 → not suspended
    expect(resultB.suspended).toBe(false);
  });

  it("dispatches a notification for every reputation flag event", async () => {
    const { publishPaymentEvent } = await import("../../events/index.js");

    await handleReputationFlagEvent(makeEvent(10));
    expect(publishPaymentEvent).toHaveBeenCalledOnce();

    const callArg = (publishPaymentEvent as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArg.type).toBe("merchant_reputation_flagged");
    expect(callArg.payload.merchantAddress).toBe("GMERCHANT");
    expect(callArg.payload.penaltyPoints).toBe(10);
  });

  it("includes suspension = true in the notification payload when suspended", async () => {
    const { publishPaymentEvent } = await import("../../events/index.js");

    await handleReputationFlagEvent(makeEvent(200)); // way over threshold

    const callArg = (publishPaymentEvent as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArg.payload.suspended).toBe(true);
    expect(callArg.payload.disputeInstructions).toContain("appeal");
  });

  it("returns correct result shape with all required fields", async () => {
    const result = await handleReputationFlagEvent(makeEvent(20));

    expect(result).toHaveProperty("merchantAddress");
    expect(result).toHaveProperty("totalPenaltyScore");
    expect(result).toHaveProperty("suspended");
    expect(result).toHaveProperty("isActive");
  });
});
