import { describe, expect, it, vi } from "vitest";
import { GlobalTokenBucket, RateLimitUnavailableError, resolveGlobalTier } from "./globalTokenBucket.js";

describe("global token bucket", () => {
  it.each([
    [undefined, "free"], [[], "free"], [["verified"], "verified"],
    [["merchant"], "verified"], [["pro"], "verified"],
    [["verified", "enterprise"], "enterprise"],
  ])("resolves verified roles %j to %s", (roles, tier) => {
    expect(resolveGlobalTier(roles as string[] | undefined)).toBe(tier);
  });

  it("uses one key across tier changes and Redis time in production", async () => {
    const evalScript = vi.fn().mockResolvedValue([1, 59, 0]);
    const limiter = new GlobalTokenBucket({ eval: evalScript });
    expect((await limiter.check("user:merchant-1", "free")).headers).toEqual({
      "X-RateLimit-Limit": "60", "X-RateLimit-Remaining": "59",
    });
    await limiter.check("user:merchant-1", "verified");
    expect(evalScript.mock.calls[0][2]).toBe(evalScript.mock.calls[1][2]);
    expect(evalScript.mock.calls[0][2]).not.toContain("merchant-1");
    expect(evalScript.mock.calls[0][5]).toBe("");
  });

  it("rounds retry time up to a positive HTTP delta in seconds", async () => {
    const limiter = new GlobalTokenBucket({ eval: async () => [0, 0, 1001] });
    expect((await limiter.check("ip:1", "free")).headers["Retry-After"]).toBe("2");
  });

  it.each([null, [1, -1, 0], [2, 1, 0], [1, 61, 0], ["1", 1, 0]])(
    "fails closed on invalid Redis response %j", async (result) => {
      const limiter = new GlobalTokenBucket({ eval: async () => result });
      await expect(limiter.check("ip:1", "free")).rejects.toBeInstanceOf(RateLimitUnavailableError);
    },
  );

  it("fails closed when Redis is unavailable", async () => {
    const limiter = new GlobalTokenBucket({ eval: async () => { throw new Error("connection failed"); } });
    await expect(limiter.check("ip:1", "free")).rejects.toBeInstanceOf(RateLimitUnavailableError);
  });
});
