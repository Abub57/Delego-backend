import { describe, expect, it, beforeEach } from "vitest";
import MockRedis from "ioredis-mock";
import { acquireRedlock, releaseRedlock, extendRedlock, lockKeyForResource } from "./redlock.js";
import type { CacheRedisClient } from "./client.js";

let nextMockPort = 30000;
function newClient(): CacheRedisClient {
  return new MockRedis(nextMockPort++) as unknown as CacheRedisClient;
}

describe("redlock", () => {
  let redis: CacheRedisClient;

  beforeEach(() => {
    redis = newClient();
  });

  it("only one worker acquires the lock for a resource", async () => {
    const first = await acquireRedlock(redis, {
      resource: "cart:abc",
      ttlMs: 5_000,
      retryCount: 0,
      retryDelayMs: 25,
    });
    const second = await acquireRedlock(redis, {
      resource: "cart:abc",
      ttlMs: 5_000,
      retryCount: 0,
      retryDelayMs: 25,
    });

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(first?.lockKey).toBe(lockKeyForResource("cart:abc"));
  });

  it("releases the lock only when the caller token matches", async () => {
    const owner = await acquireRedlock(redis, {
      resource: "cart:def",
      ttlMs: 5_000,
      retryCount: 0,
      retryDelayMs: 25,
    });
    expect(owner).not.toBeNull();

    const wrongToken = "wrong-lock-value";
    expect(await releaseRedlock(redis, owner!.lockKey, wrongToken)).toBe(false);
    expect(await releaseRedlock(redis, owner!.lockKey, owner!.lockValue)).toBe(true);
  });

  it("extends a held lock for the current owner only", async () => {
    const lock = await acquireRedlock(redis, {
      resource: "cart:ghi",
      ttlMs: 1_000,
      retryCount: 0,
      retryDelayMs: 25,
    });

    expect(lock).not.toBeNull();
    expect(await extendRedlock(redis, lock!.lockKey, lock!.lockValue, 3_000)).toBe(true);
    expect(await extendRedlock(redis, lock!.lockKey, "another-token", 3_000)).toBe(false);
  });
});
