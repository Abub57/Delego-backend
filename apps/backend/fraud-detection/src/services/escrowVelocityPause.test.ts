import { beforeEach, describe, expect, it, vi } from "vitest";

const redisMock = {
  exists: vi.fn(),
  set: vi.fn(),
  del: vi.fn(),
  quit: vi.fn(),
};

vi.mock("ioredis", () => ({
  default: vi.fn(() => redisMock),
}));

import { EscrowVelocityService } from "./escrowVelocityService.js";

describe("EscrowVelocityService pause", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports paused when the pause key exists", async () => {
    redisMock.exists.mockResolvedValue(1);
    const service = new EscrowVelocityService("redis://localhost:6379", 10);

    expect(await service.isPaused("GABC123")).toBe(true);
    expect(redisMock.exists).toHaveBeenCalledWith("fraud:escrow-paused:GABC123");
  });

  it("reports not paused when the pause key is missing", async () => {
    redisMock.exists.mockResolvedValue(0);
    const service = new EscrowVelocityService("redis://localhost:6379", 10);

    expect(await service.isPaused("GABC123")).toBe(false);
  });

  it("pauseAccount returns true only the first time (one review per pause)", async () => {
    redisMock.set.mockResolvedValueOnce("OK").mockResolvedValueOnce(null);
    const service = new EscrowVelocityService("redis://localhost:6379", 10);

    expect(await service.pauseAccount("GABC123")).toBe(true);
    expect(await service.pauseAccount("GABC123")).toBe(false);
    expect(redisMock.set).toHaveBeenCalledWith("fraud:escrow-paused:GABC123", "1", "NX");
  });

  it("clearPause removes the pause key", async () => {
    redisMock.del.mockResolvedValue(1);
    const service = new EscrowVelocityService("redis://localhost:6379", 10);

    await service.clearPause("GABC123");
    expect(redisMock.del).toHaveBeenCalledWith("fraud:escrow-paused:GABC123");
  });
});