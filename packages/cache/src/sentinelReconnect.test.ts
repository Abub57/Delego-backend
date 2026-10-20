import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_SENTINEL_RECONNECT_CONFIG,
  SentinelReconnectManager,
  sentinelReconnectDelay,
} from "./sentinelReconnect.js";

const fixedRandom = (value: number) => () => value;

describe("sentinelReconnectDelay", () => {
  it("doubles the capped delay per attempt", () => {
    const config = { ...DEFAULT_SENTINEL_RECONNECT_CONFIG, jitterRatio: 0 };
    expect(sentinelReconnectDelay(0, config)).toBe(100);
    expect(sentinelReconnectDelay(1, config)).toBe(200);
    expect(sentinelReconnectDelay(2, config)).toBe(400);
  });

  it("applies full jitter within [0, capped]", () => {
    const config = { ...DEFAULT_SENTINEL_RECONNECT_CONFIG, baseMs: 1000, jitterRatio: 1 };
    expect(sentinelReconnectDelay(0, config, fixedRandom(0))).toBe(0);
    expect(sentinelReconnectDelay(0, config, fixedRandom(0.5))).toBe(500);
    expect(sentinelReconnectDelay(0, config, fixedRandom(0.999))).toBe(999);
  });

  it("never exceeds the maximum backoff", () => {
    const config = {
      ...DEFAULT_SENTINEL_RECONNECT_CONFIG,
      baseMs: 1000,
      maxMs: 5000,
      jitterRatio: 1,
    };
    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect(sentinelReconnectDelay(attempt, config)).toBeLessThanOrEqual(5000);
    }
    expect(sentinelReconnectDelay(10, config, fixedRandom(1))).toBe(5000);
  });
});

describe("SentinelReconnectManager", () => {
  it("deduplicates concurrent reconnect calls into one loop", async () => {
    const sleep = vi.fn(async () => {});
    const task = vi.fn(async () => {});
    const manager = new SentinelReconnectManager(
      { ...DEFAULT_SENTINEL_RECONNECT_CONFIG, jitterRatio: 0 },
      sleep,
      fixedRandom(0)
    );

    const first = manager.schedule(task);
    const second = manager.schedule(task);
    expect(first).toBe(second);

    await Promise.all([first, second]);
    expect(task).toHaveBeenCalledTimes(1);
    expect(manager.attempts).toBe(0);
  });

  it("retries with exponential backoff and resets after success", async () => {
    const delays: number[] = [];
    const sleep = async (ms: number) => {
      delays.push(ms);
    };
    let calls = 0;
    const task = async () => {
      calls += 1;
      if (calls < 3) throw new Error("master not ready");
    };
    const manager = new SentinelReconnectManager(
      { ...DEFAULT_SENTINEL_RECONNECT_CONFIG, jitterRatio: 0 },
      sleep,
      fixedRandom(0)
    );

    await manager.schedule(task);

    expect(calls).toBe(3);
    expect(delays).toEqual([100, 200, 400]);
    expect(manager.attempts).toBe(0);
  });

  it("rejects after the configured number of attempts", async () => {
    const sleep = vi.fn(async () => {});
    const task = vi.fn(async () => {
      throw new Error("still down");
    });
    const manager = new SentinelReconnectManager(
      { ...DEFAULT_SENTINEL_RECONNECT_CONFIG, jitterRatio: 0, maxAttempts: 2 },
      sleep,
      fixedRandom(0)
    );

    await expect(manager.schedule(task)).rejects.toThrow("still down");
    expect(task).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});
