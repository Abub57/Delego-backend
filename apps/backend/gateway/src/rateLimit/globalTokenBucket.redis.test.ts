import { randomUUID, createHash } from "node:crypto";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GlobalTokenBucket, GLOBAL_QUOTAS, type GlobalTier } from "./globalTokenBucket.js";

// Explicit opt-in: never connect to or flush a developer's default Redis.
const url = process.env.RATE_LIMIT_TEST_REDIS_URL;
describe.skipIf(!url)("atomic token bucket with real Redis", () => {
  const prefix = `test:539:${randomUUID()}:`;
  const clients: Redis[] = [];
  beforeAll(async () => {
    for (let i = 0; i < 4; i++) {
      const client = new Redis(url!, { lazyConnect: true, maxRetriesPerRequest: 0 });
      clients.push(client);
      await client.connect();
    }
  });
  afterAll(async () => {
    if (clients[0]?.status === "ready") {
      const keys = await clients[0].keys(`${prefix}*`);
      if (keys.length) await clients[0].del(...keys);
    }
    clients.forEach((client) => client.disconnect());
  });

  it.each(Object.keys(GLOBAL_QUOTAS) as GlobalTier[])(
    "enforces the exact %s capacity across four independent replicas", async (tier) => {
      const limiters = clients.map((client) => new GlobalTokenBucket(client, prefix, () => 1000));
      const capacity = GLOBAL_QUOTAS[tier];
      const count = Math.max(1000, capacity + 1000);
      const decisions = await Promise.all(Array.from({ length: count }, (_, i) =>
        limiters[i % 4].check(`user:load-${tier}`, tier)));
      expect(decisions.filter((decision) => decision.allowed)).toHaveLength(capacity);
      expect(decisions.filter((decision) => !decision.allowed)).toHaveLength(count - capacity);
      expect(decisions.every((decision) => Number(decision.headers["X-RateLimit-Remaining"]) >= 0)).toBe(true);
      expect(decisions.filter((decision) => !decision.allowed).every((decision) =>
        decision.headers["Retry-After"] === "1")).toBe(true);
    }, 15000,
  );

  it("preserves fractional tokens and does not refill twice after clock rollback", async () => {
    let now = 1000;
    const limiter = new GlobalTokenBucket(clients[0], prefix, () => now);
    for (let i = 0; i < 60; i++) await limiter.check("clock", "free");
    now = 1500;
    expect((await limiter.check("clock", "free")).allowed).toBe(false);
    now = 1200;
    expect((await limiter.check("clock", "free")).allowed).toBe(false);
    now = 2000;
    expect((await limiter.check("clock", "free")).allowed).toBe(true);
    expect((await limiter.check("clock", "free")).allowed).toBe(false);
    now = 120000;
    expect((await limiter.check("clock", "free")).headers["X-RateLimit-Remaining"]).toBe("59");
  });

  it("retains depleted state across tier changes and expires only after refill", async () => {
    const limiter = new GlobalTokenBucket(clients[0], prefix, () => 1000);
    for (let i = 0; i < 60; i++) await limiter.check("tier-change", "free");
    expect((await limiter.check("tier-change", "enterprise")).allowed).toBe(false);
    const key = prefix + createHash("sha256").update("tier-change").digest("hex");
    expect(await clients[0].pttl(key)).toBeGreaterThan(60000);
  });

  it("uses the Redis server timestamp when no test clock is supplied", async () => {
    const limiter = new GlobalTokenBucket(clients[0], prefix);
    const before = Date.now();
    await limiter.check("server-time", "free");
    const key = prefix + createHash("sha256").update("server-time").digest("hex");
    const timestamp = Number(await clients[0].hget(key, "ts"));
    expect(Math.abs(timestamp - before)).toBeLessThan(5000);
  });
});
