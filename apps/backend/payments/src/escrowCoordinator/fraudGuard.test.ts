import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@delegolabs/utils", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  tracedFetch: (input: Parameters<typeof fetch>[0], init?: RequestInit) => globalThis.fetch(input, init),
}));

import { checkEscrowVelocity } from "./fraudGuard.js";

describe("checkEscrowVelocity", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns paused=true when the fraud service pauses the account", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: { paused: true, escrowsPastHour: 10, riskScore: 100 } }),
      }),
    );

    const result = await checkEscrowVelocity("GABC123");

    expect(result.paused).toBe(true);
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/fraud/escrow-velocity"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("returns paused=false for a healthy account", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: { paused: false, escrowsPastHour: 2, riskScore: 20 } }),
      }),
    );

    expect((await checkEscrowVelocity("GABC123")).paused).toBe(false);
  });

  it("fails open when the fraud service is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    expect((await checkEscrowVelocity("GABC123")).paused).toBe(false);
  });

  it("fails open on a non-2xx response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));

    expect((await checkEscrowVelocity("GABC123")).paused).toBe(false);
  });
});
