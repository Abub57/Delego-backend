import { beforeEach, describe, expect, it, vi } from "vitest";

const redisMock = {
  multi: vi.fn(),
  zremrangebyscore: vi.fn(),
  zcount: vi.fn(),
  quit: vi.fn(),
};

vi.mock("ioredis", () => ({
  default: vi.fn(() => redisMock),
}));

import { EscrowVelocityService } from "./escrowVelocityService.js";

describe("EscrowVelocityService", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    redisMock.multi.mockReturnValue({
      zadd: vi.fn().mockReturnThis(),
      zremrangebyscore: vi.fn().mockReturnThis(),
      expire: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([]),
    });

    redisMock.zremrangebyscore.mockResolvedValue(0);
    redisMock.zcount.mockResolvedValue(3);
    redisMock.quit.mockResolvedValue("OK");
  });

  it("returns the rolling one-hour escrow velocity for an account", async () => {
    const service = new EscrowVelocityService(
      "redis://localhost:6379",
      10,
    );

    const result = await service.getVelocity("GABC123");

    expect(result).toEqual({
      accountAddress: "GABC123",
      escrowsPastHour: 3,
      riskScore: 30,
      isFlagged: false,
    });

    expect(redisMock.zcount).toHaveBeenCalledWith(
      "fraud:escrow-velocity:GABC123",
      expect.any(Number),
      expect.any(Number),
    );
  });

  it("flags an account when escrow velocity reaches the review threshold", async () => {
    redisMock.zcount.mockResolvedValue(10);

    const service = new EscrowVelocityService(
      "redis://localhost:6379",
      10,
    );

    const result = await service.getVelocity("GABC123");

    expect(result.escrowsPastHour).toBe(10);
    expect(result.riskScore).toBe(100);
    expect(result.isFlagged).toBe(true);
  });

  it("records an escrow creation in the rolling Redis window", async () => {
    const service = new EscrowVelocityService("redis://localhost:6379", 10);
    await service.recordEscrowCreation("GABC123");

    const transaction = redisMock.multi.mock.results[0].value;

    expect(transaction.zadd).toHaveBeenCalledWith(
      "fraud:escrow-velocity:GABC123",
      expect.any(Number),
      expect.stringMatching(/^\d+:/),
    );
    expect(transaction.zremrangebyscore).toHaveBeenCalledWith(
      "fraud:escrow-velocity:GABC123",
      0,
      expect.any(Number),
    );
    expect(transaction.expire).toHaveBeenCalledWith(
      "fraud:escrow-velocity:GABC123",
      60 * 60 * 2,
    );
    expect(transaction.exec).toHaveBeenCalled();
  });
});
