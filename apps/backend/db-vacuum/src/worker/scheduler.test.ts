import { afterEach, describe, expect, it, vi } from "vitest";
import type { VacuumRunSummary } from "@delegolabs/types";
import type { DatabaseVacuumService } from "../service.js";
import { DEFAULT_INTERVAL_MS, VacuumScheduler } from "./scheduler.js";

function makeSummary(runNumber: number): VacuumRunSummary {
  return {
    runId: `run-${runNumber}`,
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z",
    durationMs: 1000,
    tablesScanned: 5,
    tablesOverThreshold: 1,
    vacuumed: ["public.orders"],
    skipped: [],
    failed: [],
    alertsRaised: 1,
    dryRun: false,
  };
}

function makeService() {
  let runs = 0;
  const runOnce = vi.fn(async () => makeSummary(++runs));
  return { runOnce, service: { runOnce } as unknown as DatabaseVacuumService };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("VacuumScheduler", () => {
  it("defaults to a 15 minute interval", () => {
    expect(DEFAULT_INTERVAL_MS).toBe(15 * 60 * 1000);
  });

  it("tick delegates to the service and reports the run", async () => {
    const { service, runOnce } = makeService();
    const onRun = vi.fn();
    const scheduler = new VacuumScheduler(service, { onRun });

    const summary = await scheduler.tick();

    expect(runOnce).toHaveBeenCalledTimes(1);
    expect(summary.runId).toBe("run-1");
    expect(onRun).toHaveBeenCalledWith(summary);
  });

  it("does not start a timer until start() is called", () => {
    const scheduler = new VacuumScheduler(makeService().service, { intervalMs: 1000 });
    expect(scheduler.isRunning()).toBe(false);
  });

  it("runs on the configured interval", async () => {
    vi.useFakeTimers();
    const { service, runOnce } = makeService();
    const scheduler = new VacuumScheduler(service, {
      intervalMs: 1000,
      skipInitialTick: true,
    });

    scheduler.start();
    expect(scheduler.isRunning()).toBe(true);

    await vi.advanceTimersByTimeAsync(3000);
    expect(runOnce).toHaveBeenCalledTimes(3);

    scheduler.stop();
    expect(scheduler.isRunning()).toBe(false);

    await vi.advanceTimersByTimeAsync(3000);
    expect(runOnce).toHaveBeenCalledTimes(3);
  });

  it("ticks immediately on start unless asked to wait", async () => {
    vi.useFakeTimers();
    const { service, runOnce } = makeService();
    const scheduler = new VacuumScheduler(service, { intervalMs: 1000 });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(runOnce).toHaveBeenCalledTimes(1);

    scheduler.stop();
  });

  it("start() is idempotent", async () => {
    vi.useFakeTimers();
    const { service, runOnce } = makeService();
    const scheduler = new VacuumScheduler(service, {
      intervalMs: 1000,
      skipInitialTick: true,
    });

    scheduler.start();
    scheduler.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(runOnce).toHaveBeenCalledTimes(1);

    scheduler.stop();
  });

  it("routes tick failures to onError and keeps running", async () => {
    vi.useFakeTimers();
    const runOnce = vi.fn().mockRejectedValue(new Error("database unavailable"));
    const onError = vi.fn();
    const scheduler = new VacuumScheduler(
      { runOnce } as unknown as DatabaseVacuumService,
      { intervalMs: 1000, skipInitialTick: true, onError },
    );

    scheduler.start();
    await vi.advanceTimersByTimeAsync(2000);

    expect(onError).toHaveBeenCalledTimes(2);
    expect((onError.mock.calls[0]?.[0] as Error).message).toBe("database unavailable");
    scheduler.stop();
  });

  it("stop() is safe when never started", () => {
    const scheduler = new VacuumScheduler(makeService().service);
    expect(() => scheduler.stop()).not.toThrow();
  });
});
