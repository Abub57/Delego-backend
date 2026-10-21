import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { escrowCoordinator } from "../escrowCoordinator/index.js";
import { listAuditLogForDispute, resetAuditLogStore } from "./auditLog.js";
import { getDisputeStore, resetDisputeStore } from "./disputeStore.js";
import { notifyDisputeParties } from "./notifications.js";
import {
  DEFAULT_STALLED_HOURS,
  findAndEscalateStalledDisputes,
} from "./escalationWorker.js";

vi.mock("../escrowCoordinator/index.js", async () => {
  const actual = await vi.importActual<
    typeof import("../escrowCoordinator/index.js")
  >("../escrowCoordinator/index.js");
  return {
    ...actual,
    escrowCoordinator: {
      getEscrowStatus: vi.fn(),
      getRemainingBalance: vi.fn().mockResolvedValue({
        escrowId: "42",
        orderId: "order-1",
        buyerAddress: "GBUYER",
        sellerAddress: "GSELLER",
        totalAmount: "1000",
        releasedAmount: "0",
        refundedAmount: "0",
        remainingAmount: "1000",
      }),
      releaseEscrow: vi.fn(),
      refundEscrow: vi.fn(),
      disputeEscrow: vi.fn(),
      partialRefundEscrow: vi.fn(),
      partialReleaseEscrow: vi.fn(),
      fundEscrow: vi.fn(),
    },
  };
});

vi.mock("./notifications.js", () => ({
  notifyDisputeParties: vi.fn().mockResolvedValue(undefined),
}));

const HOUR_MS = 60 * 60 * 1000;

async function seedDispute(status?: "open" | "decided" | "resolved") {
  const store = getDisputeStore();
  const dispute = await store.create({
    escrowId: "42",
    orderId: "order-1",
    initiatedBy: "GBUYER",
    reason: "Item not received",
    slaDeadline: new Date(Date.now() + 14 * 24 * HOUR_MS).toISOString(),
  });
  if (status) return store.update(dispute.id, { status });
  return dispute;
}

describe("findAndEscalateStalledDisputes (#403)", () => {
  beforeEach(() => {
    resetDisputeStore();
    resetAuditLogStore();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("escalates a dispute unresolved past the stall window to senior", async () => {
    const dispute = await seedDispute();

    const result = await findAndEscalateStalledDisputes(
      new Date(Date.now() + 73 * HOUR_MS),
      DEFAULT_STALLED_HOURS
    );

    expect(result.scanned).toBe(1);
    expect(result.escalated).toEqual([
      { disputeId: dispute.id, stalledHours: 72, assignedTier: "senior" },
    ]);

    const updated = await getDisputeStore().findById(dispute.id);
    expect(updated?.escalationTier).toBe("senior");
    expect(updated?.escalationEscalatedAt).toBeDefined();

    expect(vi.mocked(notifyDisputeParties)).toHaveBeenCalledWith(
      "dispute_escalated",
      "order-1",
      expect.objectContaining({ id: dispute.id }),
      expect.objectContaining({ assignedTier: "senior", stalledHours: 72 })
    );

    const audit = await listAuditLogForDispute(dispute.id);
    expect(audit.map((entry) => entry.eventType)).toContain("dispute_escalated");
  });

  it("does not escalate a dispute younger than the stall window", async () => {
    await seedDispute();

    const result = await findAndEscalateStalledDisputes(
      new Date(Date.now() + 71 * HOUR_MS),
      DEFAULT_STALLED_HOURS
    );

    expect(result.scanned).toBe(0);
    expect(result.escalated).toHaveLength(0);
    expect(notifyDisputeParties).not.toHaveBeenCalled();
  });

  it("does not escalate disputes that already reached decided/resolved", async () => {
    await seedDispute("decided");
    await seedDispute("resolved");

    const result = await findAndEscalateStalledDisputes(
      new Date(Date.now() + 73 * HOUR_MS),
      DEFAULT_STALLED_HOURS
    );

    expect(result.scanned).toBe(0);
  });

  it("is idempotent: a second scan does not re-escalate the same dispute", async () => {
    await seedDispute();
    const now = new Date(Date.now() + 73 * HOUR_MS);

    const first = await findAndEscalateStalledDisputes(now, DEFAULT_STALLED_HOURS);
    const second = await findAndEscalateStalledDisputes(now, DEFAULT_STALLED_HOURS);

    expect(first.escalated).toHaveLength(1);
    expect(second.escalated).toHaveLength(0);
    expect(second.scanned).toBe(0);
  });

  it("continues escalating the rest of the batch when one dispute fails", async () => {
    const store = getDisputeStore();
    const first = await seedDispute();
    const second = await seedDispute();

    const originalUpdate = store.update.bind(store);
    vi.spyOn(store, "update").mockImplementation(async (id, update) => {
      if (id === first.id) throw new Error("db unavailable");
      return originalUpdate(id, update);
    });

    const result = await findAndEscalateStalledDisputes(
      new Date(Date.now() + 73 * HOUR_MS),
      DEFAULT_STALLED_HOURS
    );

    expect(result.scanned).toBe(2);
    expect(result.escalated.map((rule) => rule.disputeId)).toEqual([second.id]);
  });
});
