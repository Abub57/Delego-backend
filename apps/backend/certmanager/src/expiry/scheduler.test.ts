import { describe, expect, it, vi } from "vitest";
import { ExpiryScheduler } from "./scheduler.js";
import type { CertExpiryChecker, ExpiryCheckSummary } from "../src/expiry/checker.js";

function fakeChecker() {
  const calls: Array<Promise<ExpiryCheckSummary>> = [];
  return {
    calls,
    checkAllDomains: vi.fn(async (): Promise<ExpiryCheckSummary> => {
      const p = Promise.resolve({
        checked: 0,
        expiringSoon: 0,
        expired: 0,
        unreachable: 0,
        alertsEmitted: 0,
        failures: 0,
        results: [],
      });
      calls.push(p);
      return p;
    }),
  } as unknown as CertExpiryChecker & { checkAllDomains: ReturnType<typeof vi.fn> };
}

describe("ExpiryScheduler", () => {
  it("runs a sweep on tick()", async () => {
    const checker = fakeChecker();
    const scheduler = new ExpiryScheduler(checker, { intervalMs: 60_000 });
    const summary = await scheduler.tick();
    expect(checker.checkAllDomains).toHaveBeenCalledOnce();
    expect(summary.checked).toBe(0);
  });

  it("runs on the interval until stopped", async () => {
    vi.useFakeTimers();
    try {
      const checker = fakeChecker();
      const scheduler = new ExpiryScheduler(checker, { intervalMs: 100 });
      scheduler.start();
      await vi.advanceTimersByTimeAsync(350);
      scheduler.stop();
      expect(checker.checkAllDomains).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not double-start", async () => {
    vi.useFakeTimers();
    try {
      const checker = fakeChecker();
      const scheduler = new ExpiryScheduler(checker, { intervalMs: 100 });
      scheduler.start();
      scheduler.start();
      await vi.advanceTimersByTimeAsync(250);
      scheduler.stop();
      expect(checker.checkAllDomains).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stop() cancels the timer", async () => {
    vi.useFakeTimers();
    try {
      const checker = fakeChecker();
      const scheduler = new ExpiryScheduler(checker, { intervalMs: 100 });
      scheduler.start();
      scheduler.stop();
      await vi.advanceTimersByTimeAsync(500);
      expect(checker.checkAllDomains).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("supports runOnStart and reports errors through onError", async () => {
    vi.useFakeTimers();
    try {
      const onError = vi.fn();
      const checker = fakeChecker();
      (checker.checkAllDomains as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("sweep failed"),
      );
      const scheduler = new ExpiryScheduler(checker, { intervalMs: 100, onError, runOnStart: true });
      scheduler.start();
      await vi.advanceTimersByTimeAsync(10);
      scheduler.stop();
      expect(onError).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
