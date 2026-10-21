import { beforeEach, describe, expect, it, vi } from "vitest";
import { escrowCoordinator } from "../escrowCoordinator/index.js";
import { getDisputeStore, resetDisputeStore } from "../disputes/disputeStore.js";
import { executeAutoRelease } from "../autoRelease/service.js";
import { enqueueAutoRelease, processAutoRelease, type AutoReleaseJobData } from "./autoRelease.js";

const queueAdd = vi.hoisted(() => vi.fn().mockResolvedValue({ id: "queued-1" }));
vi.mock("bullmq", () => ({
  Queue: class { add = queueAdd; },
  Worker: class {},
}));
vi.mock("ioredis", () => ({ Redis: class {} }));

vi.mock("../escrowCoordinator/index.js", () => ({
  escrowCoordinator: { getEscrowStatus: vi.fn() },
}));
vi.mock("../autoRelease/service.js", () => ({ executeAutoRelease: vi.fn() }));

const job = (): AutoReleaseJobData => ({
  escrowId: "42",
  orderId: "order-1",
  signedProof: {
    proof: { deliveredAt: "2026-09-27T00:00:00Z" },
    signature: "verified-hmac",
    confirmedBy: "merchant-1",
  },
  graceExpiresAt: Date.now() - 1,
});

describe("auto-release trigger worker", () => {
  beforeEach(() => {
    queueAdd.mockClear();
    resetDisputeStore();
    vi.mocked(escrowCoordinator.getEscrowStatus).mockReset().mockResolvedValue({
      escrowId: "42", buyer: "GBUYER", seller: "GSELLER", amount: "1000", status: "funded", createdAt: 0,
    });
    vi.mocked(executeAutoRelease).mockReset().mockResolvedValue({
      escrowId: "42", success: true, transactionHash: "tx", releasedAmount: "1000", remainingAmount: "0", retryCount: 0,
    });
  });

  it("schedules the job for the absolute grace deadline", async () => {
    const dueAt = Date.now() + 300_000;
    const data = { ...job(), graceExpiresAt: dueAt };
    const result = await enqueueAutoRelease(data);
    expect(result).toEqual({ jobId: "queued-1", scheduledFor: new Date(dueAt).toISOString() });
    expect(queueAdd).toHaveBeenCalledWith("release", data, expect.objectContaining({
      delay: expect.any(Number),
      jobId: `release-42-${dueAt}`,
    }));
    const delay = queueAdd.mock.calls[0][2].delay as number;
    expect(delay).toBeGreaterThan(0);
    expect(delay).toBeLessThanOrEqual(300_000);
  });

  it("aborts immediately when a mediation dispute is active", async () => {
    await getDisputeStore().create({
      escrowId: "42", orderId: "order-1", initiatedBy: "buyer", reason: "not received",
      slaDeadline: "2026-10-01T00:00:00Z",
    });
    await processAutoRelease(job());
    expect(escrowCoordinator.getEscrowStatus).not.toHaveBeenCalled();
    expect(executeAutoRelease).not.toHaveBeenCalled();
  });

  it("aborts when the on-chain dispute flag is active", async () => {
    vi.mocked(escrowCoordinator.getEscrowStatus).mockResolvedValueOnce({
      escrowId: "42", buyer: "GBUYER", seller: "GSELLER", amount: "1000", status: "disputed", createdAt: 0,
    });
    await processAutoRelease(job());
    expect(executeAutoRelease).not.toHaveBeenCalled();
  });

  it("releases only a funded escrow after grace expires", async () => {
    await processAutoRelease(job());
    expect(executeAutoRelease).toHaveBeenCalledOnce();
    await expect(processAutoRelease({ ...job(), graceExpiresAt: Date.now() + 60_000 }))
      .rejects.toThrow(/grace period/i);
    expect(executeAutoRelease).toHaveBeenCalledOnce();
  });

  it("propagates release failures so the queue can report them", async () => {
    vi.mocked(executeAutoRelease).mockResolvedValueOnce({
      escrowId: "42", success: false, releasedAmount: "0", remainingAmount: "1000",
      error: "Soroban unavailable", retryCount: 3,
    });
    await expect(processAutoRelease(job())).rejects.toThrow("Soroban unavailable");
  });
});
