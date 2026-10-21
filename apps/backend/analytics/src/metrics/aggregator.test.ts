import { afterEach, describe, expect, it, vi } from "vitest";
import { startSpendMetricsAggregator, SPEND_AGGREGATION_INTERVAL_MS } from "./aggregator.js";

vi.mock("../db.js", () => ({ sequelize: {} }));

afterEach(() => { vi.useRealTimers(); });

describe("spend aggregation scheduler", () => {
  it("runs at startup and hourly, and stops scheduling on shutdown", async () => {
    vi.useFakeTimers();
    const refresh = vi.fn().mockResolvedValue(true);
    const worker = startSpendMetricsAggregator(refresh);
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(SPEND_AGGREGATION_INTERVAL_MS - 1);
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(2);
    await worker.stop();
    await vi.advanceTimersByTimeAsync(SPEND_AGGREGATION_INTERVAL_MS);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("skips overlapping ticks and waits for the active refresh on shutdown", async () => {
    vi.useFakeTimers();
    let finish!: (value: boolean) => void;
    const refresh = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    const worker = startSpendMetricsAggregator(refresh);
    await vi.advanceTimersByTimeAsync(2 * SPEND_AGGREGATION_INTERVAL_MS);
    expect(refresh).toHaveBeenCalledTimes(1);
    let stopped = false;
    const stop = worker.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    finish(true);
    await stop;
    expect(stopped).toBe(true);
  });

  it("retries on the next hour after a rejected refresh", async () => {
    vi.useFakeTimers();
    const refresh = vi.fn().mockRejectedValueOnce(new Error("database unavailable")).mockResolvedValue(true);
    const worker = startSpendMetricsAggregator(refresh);
    await vi.advanceTimersByTimeAsync(SPEND_AGGREGATION_INTERVAL_MS);
    expect(refresh).toHaveBeenCalledTimes(2);
    await worker.stop();
  });
});
