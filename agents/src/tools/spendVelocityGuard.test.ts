// @ts-ignore -- ioredis-mock has no first-party types
import Redis from "ioredis-mock";
import { describe, expect, it, beforeEach, vi } from "vitest";
import {
  SpendVelocityGuard,
  SpendVelocityExceededError,
  guardSpend,
  type SpendVelocityPolicy,
} from "./spendVelocityGuard.js";

const HOUR_MS = 60 * 60 * 1000;

describe("#533 SpendVelocityGuard", () => {
  let redis: InstanceType<typeof Redis>;
  let guard: SpendVelocityGuard;
  let policy: SpendVelocityPolicy;

  beforeEach(async () => {
    redis = new Redis();
    await redis.flushall();
    guard = new SpendVelocityGuard(redis);
    policy = {
      maxHourlyTransactions: 2,
      maxHourlyVolumeStroops: "1500",
      maxDailyVolumeStroops: "5000",
      requireBiometricAboveStroops: "2000",
    };
  });

  describe("normal flow", () => {
    it("allows a transaction under the hourly limits and reports the projected counters", async () => {
      const result = await guard.check("user-1", "500", policy);

      expect(result.allowed).toBe(true);
      expect(result.hourlyTransactions).toBe(0);
      expect(result.hourlyVolume).toBe(0n);
      expect(result.requiresBiometric).toBe(false);
    });

    it("records spends and reflects them in subsequent checks", async () => {
      await guard.recordSpend("user-1", "400");
      await guard.recordSpend("user-1", "400");

      const result = await guard.check("user-1", "100", policy);
      expect(result.allowed).toBe(false);
      expect(result.hourlyTransactions).toBe(2);
      expect(result.hourlyVolume).toBe(800n);
    });

    it("requires biometrics above the configured threshold", async () => {
      const result = await guard.check("user-1", "2500", policy);
      expect(result.requiresBiometric).toBe(true);
      expect(result.allowed).toBe(false); // 2500 > hourly volume cap of 1500
    });
  });

  describe("velocity breaches", () => {
    it("blocks when the hourly transaction count is exceeded", async () => {
      await guard.recordSpend("user-1", "100");
      await guard.recordSpend("user-1", "100");

      const result = await guard.check("user-1", "50", policy);
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/transaction count/i);
    });

    it("blocks when the hourly volume is exceeded", async () => {
      await guard.recordSpend("user-1", "1400");

      const result = await guard.check("user-1", "200", policy);
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/hourly volume/i);
    });

    it("blocks when the daily volume is exceeded even if the hourly window is clear", async () => {
      const old = Date.now() - 2 * HOUR_MS;
      await redis.zadd(`spend-velocity:user-1`, old, `${old}:0:4900`);

      const result = await guard.check("user-1", "200", policy);
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/daily volume/i);
    });

    it("throws SpendVelocityExceededError from assertWithinVelocity", async () => {
      await guard.recordSpend("user-1", "1400");

      await expect(
        guard.assertWithinVelocity("user-1", "200", policy),
      ).rejects.toBeInstanceOf(SpendVelocityExceededError);
    });
  });

  describe("sliding-window expiry", () => {
    it("expires hourly counters after 3600 seconds", async () => {
      const now = Date.now();
      const oldTimestamp = now - HOUR_MS - 1000;
      await redis.zadd(`spend-velocity:user-1`, oldTimestamp, `${oldTimestamp}:0:1000`);
      await redis.zadd(`spend-velocity:user-1`, oldTimestamp, `${oldTimestamp}:1:1000`);

      const result = await guard.check("user-1", "500", policy);
      expect(result.hourlyTransactions).toBe(0);
      expect(result.hourlyVolume).toBe(0n);
      expect(result.dailyVolume).toBe(2000n);
      expect(result.allowed).toBe(true);
    });

    it("expires daily counters after 86400 seconds", async () => {
      const now = Date.now();
      const stale = now - 24 * HOUR_MS - 1000;
      await redis.zadd(`spend-velocity:user-1`, stale, `${stale}:0:4000`);

      const result = await guard.check("user-1", "500", policy);
      expect(result.dailyVolume).toBe(0n);
      expect(result.allowed).toBe(true);
    });

    it("prunes stale entries when recording a new spend", async () => {
      const now = Date.now();
      const stale = now - 24 * HOUR_MS - 1000;
      await redis.zadd(`spend-velocity:user-1`, stale, `${stale}:0:4000`);

      await guard.recordSpend("user-1", "100");
      const members = await redis.zrange("spend-velocity:user-1", 0, -1);
      expect(members).toHaveLength(1);
    });
  });

  describe("guardSpend helper", () => {
    it("records the spend and returns true when allowed", async () => {
      const ok = await guardSpend({ guard, userId: "user-1", amountStroops: "500", policy });
      expect(ok).toBe(true);
      const result = await guard.check("user-1", "1", policy);
      expect(result.hourlyTransactions).toBe(1);
    });

    it("returns false and notifies when the velocity is breached", async () => {
      await guard.recordSpend("user-1", "1400");
      const notify = vi.fn();
      const ok = await guardSpend({
        guard,
        userId: "user-1",
        amountStroops: "200",
        policy,
        notify,
      });
      expect(ok).toBe(false);
      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify.mock.calls[0][0]).toMatchObject({ userId: "user-1" });
    });

    it("does not record a breaching spend", async () => {
      await guard.recordSpend("user-1", "1400");
      await guardSpend({ guard, userId: "user-1", amountStroops: "200", policy });
      const result = await guard.check("user-1", "1", policy);
      expect(result.hourlyTransactions).toBe(1);
    });
  });
});
