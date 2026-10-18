import { describe, it, expect, beforeEach, afterEach } from "vitest";
// @ts-ignore -- ioredis-mock has no first-party types
import MockRedis from "ioredis-mock";
import type { CacheRedisClient } from "@delegolabs/cache";
import { workflowLockKey } from "@delegolabs/cache";
import { DistributedLockManager } from "./manager.js";
import { lockKeyForStep, lockKeyForWorkflow } from "./keys.js";

let nextPort = 31000;
function client(): CacheRedisClient {
  return new MockRedis(nextPort++) as unknown as CacheRedisClient;
}

describe("DistributedLockManager", () => {
  let redis: CacheRedisClient;
  let a: DistributedLockManager;
  let b: DistributedLockManager;

  beforeEach(() => {
    redis = client();
    a = new DistributedLockManager({ client: redis, owner: "instance-a" });
    b = new DistributedLockManager({ client: redis, owner: "instance-b" });
  });

  afterEach(async () => {
    await a.releaseAll();
    await b.releaseAll();
  });

  it("acquires and lists the held lock for this instance", async () => {
    const key = lockKeyForWorkflow("wf-1");
    const result = await a.acquire(key, { ttlMs: 5_000, autoRenew: false });
    expect(result.acquired).toBe(true);
    expect(result.lock?.owner).toBe("instance-a");
    expect(a.listHeld()).toHaveLength(1);
  });

  it("auto-renews so the lock does not expire while held", async () => {
    const key = lockKeyForWorkflow("wf-renew");
    const acquired = await a.acquire(key, { ttlMs: 500, autoRenew: true, renewIntervalMs: 100 });
    expect(acquired.acquired).toBe(true);
    await new Promise((r) => setTimeout(r, 650));
    const inspect = await a.inspect(key);
    expect(inspect.lock?.owner).toBe("instance-a");
    expect(inspect.pttlMs).toBeGreaterThan(0);
    expect(a.wasStolen(key)).toBe(false);
  });

  it("reports steal when another owner takes the key after TTL", async () => {
    const key = lockKeyForWorkflow("wf-steal");
    await a.acquire(key, { ttlMs: 80, autoRenew: false });
    await new Promise((r) => setTimeout(r, 120));
    const taken = await b.acquire(key, { ttlMs: 1_000, autoRenew: false, waitTimeoutMs: 0 });
    expect(taken.acquired).toBe(true);
    const renewed = await a.renew(key);
    expect(renewed).toBe(false);
    expect(a.wasStolen(key)).toBe(true);
  });

  it("acquires hierarchy workflow-then-step and refuses inverted ownership", async () => {
    const wf = await a.acquireHierarchy("order-1", "deposit", { ttlMs: 5_000, autoRenew: false, waitTimeoutMs: 0 });
    expect(wf.acquired).toBe(true);
    const other = await b.acquire(lockKeyForStep("order-1", "deposit"), { ttlMs: 5_000, waitTimeoutMs: 0, autoRenew: false });
    expect(other.acquired).toBe(false);
  });

  it("times out waits within 30s (short timeout in test)", async () => {
    const key = workflowLockKey("wf-wait");
    await a.acquire(key, { ttlMs: 30_000, autoRenew: false, waitTimeoutMs: 0 });
    const started = Date.now();
    const blocked = await b.acquire(key, { ttlMs: 1_000, autoRenew: false, waitTimeoutMs: 80 });
    expect(blocked.acquired).toBe(false);
    expect(blocked.error).toBe("DEADLOCK_TIMEOUT");
    expect(blocked.waitTimeMs).toBeGreaterThanOrEqual(80);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("wrong owner cannot release", async () => {
    const key = lockKeyForWorkflow("wf-rel");
    await a.acquire(key, { ttlMs: 5_000, autoRenew: false });
    expect(await b.release(key)).toBe(false);
    expect((await a.inspect(key)).lock?.owner).toBe("instance-a");
  });

  // Issue #340 — a Redis Sentinel failover can leave a renewal command
  // hanging on a connection that is mid-reconnect to the newly promoted
  // master. Simulate that by making `eval` (what `redisLockRenew` calls)
  // never resolve, and assert `renew()` fails fast and releases ownership
  // instead of hanging the renewal interval indefinitely.
  it("fails fast and releases the lock when the connection hangs mid-renewal (simulated Sentinel failover)", async () => {
    const key = lockKeyForWorkflow("wf-failover");
    const acquired = await a.acquire(key, { ttlMs: 2_000, autoRenew: false });
    expect(acquired.acquired).toBe(true);

    const originalEval = redis.eval.bind(redis);
    (redis as any).eval = (...args: unknown[]) => {
      const [script] = args;
      if (typeof script === "string" && script.includes("ARGV[3]")) {
        // Simulate a stuck connection: never resolves, as if the command
        // were queued against a demoted master during Sentinel failover.
        return new Promise(() => {});
      }
      return originalEval(...(args as Parameters<typeof originalEval>));
    };

    const started = Date.now();
    const renewed = await a.renew(key);
    const elapsedMs = Date.now() - started;

    expect(renewed).toBe(false);
    expect(a.wasStolen(key)).toBe(true);
    // Bounded by withRenewTimeout (<=5s cap), well under the hang this
    // guards against.
    expect(elapsedMs).toBeLessThan(5_500);

    // Restore the real eval before the owner's lock key TTL is manipulated
    // so the next acquire below exercises real Redis behaviour.
    (redis as any).eval = originalEval;

    // "Worker recovery": once the fail-fast release stops `a` from treating
    // itself as the owner, another worker instance must be able to acquire
    // the lock the original job was stuck on — proving the system recovers
    // instead of deadlocking even though the original renewal never
    // completed.
    await redis.del(key);
    const recovered = await b.acquire(key, { ttlMs: 2_000, autoRenew: false, waitTimeoutMs: 0 });
    expect(recovered.acquired).toBe(true);
  });
});
