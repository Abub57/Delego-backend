import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it, vi } from "vitest";
import {
  EmergencyKillSwitchService,
  type EmergencyRevocationDTO,
} from "./service.js";

describe("EmergencyKillSwitchService", () => {
  it("cancels proposals within one second before flushing sessions and batch revocation", async () => {
    const walletAddress = Keypair.random().publicKey();
    const sessionAddress = Keypair.random().publicKey();
    const otherSessionAddress = Keypair.random().publicKey();
    let proposalsCancelled = false;
    const database = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("UPDATE purchase_proposals")) {
          proposalsCancelled = true;
          return { rows: [{ id: "proposal-1" }] };
        }
        return { rows: [{ id: "user-1" }] };
      }),
    };
    const redis = {
      scan: vi.fn().mockResolvedValue(["0", [
        `session_key:${sessionAddress}`,
        `session_key:${otherSessionAddress}`,
      ]]),
      get: vi.fn(async (key: string) => JSON.stringify({
        sessionPublicKey: key.slice("session_key:".length),
        userId: key.includes(sessionAddress) ? "user-1" : "user-2",
      })),
      del: vi.fn().mockResolvedValue(1),
    };
    const revokePermissions = vi.fn(async () => {
      expect(proposalsCancelled).toBe(true);
    });
    const service = new EmergencyKillSwitchService({
      database,
      redis,
      revokePermissions,
      adminSecret: "emergency-secret",
    });
    const dto: EmergencyRevocationDTO = {
      walletAddress,
      adminSecretToken: "emergency-secret",
      revokeOnChain: true,
    };

    const startedAt = performance.now();
    const result = await service.execute(dto);

    expect(performance.now() - startedAt).toBeLessThan(1000);
    expect(proposalsCancelled).toBe(true);
    expect(redis.del).toHaveBeenCalledWith(`session_key:${sessionAddress}`);
    expect(redis.del).not.toHaveBeenCalledWith(`session_key:${otherSessionAddress}`);
    expect(revokePermissions).toHaveBeenCalledWith(walletAddress, [sessionAddress]);
    expect(result).toEqual({
      cancelledProposalCount: 1,
      flushedSessionCount: 1,
      revokedPermissionCount: 1,
    });
  });

  it("rejects an invalid administrator token before changing state", async () => {
    const database = { query: vi.fn() };
    const redis = { scan: vi.fn(), get: vi.fn(), del: vi.fn() };
    const service = new EmergencyKillSwitchService({
      database,
      redis,
      revokePermissions: vi.fn(),
      adminSecret: "correct-secret",
    });

    await expect(service.execute({
      walletAddress: Keypair.random().publicKey(),
      adminSecretToken: "incorrect-secret",
      revokeOnChain: false,
    })).rejects.toThrow("Invalid administrator authorization token");
    expect(database.query).not.toHaveBeenCalled();
  });
});