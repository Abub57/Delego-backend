import { describe, expect, it, vi } from "vitest";
import { retryWithBackoff } from "./retry.js";

describe("retryWithBackoff", () => {
  it("returns the result of the first successful attempt without retrying", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await retryWithBackoff(fn, { sleep });

    expect(result).toEqual({ success: true, value: "ok", retryCount: 0 });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries on failure and succeeds once the underlying call recovers", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("network blip"))
      .mockRejectedValueOnce(new Error("network blip"))
      .mockResolvedValueOnce("recovered");
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await retryWithBackoff(fn, { sleep });

    expect(result).toEqual({ success: true, value: "recovered", retryCount: 2 });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("gives up after the configured max retries and reports the last error", async () => {
    const error = new Error("Soroban RPC unavailable");
    const fn = vi.fn().mockRejectedValue(error);
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await retryWithBackoff(fn, { maxRetries: 3, sleep });

    expect(result.success).toBe(false);
    expect(result.error).toBe(error);
    expect(result.retryCount).toBe(3);
    // Initial attempt + 3 retries = 4 total calls.
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it("backs off exponentially: 2s, 4s, 8s for the default base delay", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("fail"));
    const sleep = vi.fn().mockResolvedValue(undefined);

    await retryWithBackoff(fn, { maxRetries: 3, baseDelayMs: 2000, sleep });

    expect(sleep).toHaveBeenNthCalledWith(1, 2000);
    expect(sleep).toHaveBeenNthCalledWith(2, 4000);
    expect(sleep).toHaveBeenNthCalledWith(3, 8000);
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it("invokes onRetry with the attempt number and delay before each retry", async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error("fail")).mockResolvedValueOnce("ok");
    const sleep = vi.fn().mockResolvedValue(undefined);
    const onRetry = vi.fn();

    await retryWithBackoff(fn, { sleep, onRetry });

    expect(onRetry).toHaveBeenCalledWith(1, expect.any(Error), 2000);
  });

  it("stops retrying when shouldRetry rejects the error", async () => {
    const terminalError = new Error("Error(Contract, #35)");
    const fn = vi.fn().mockRejectedValue(terminalError);
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await retryWithBackoff(fn, { sleep, shouldRetry: () => false });

    expect(result).toEqual({ success: false, error: terminalError, retryCount: 0 });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("continues retrying while shouldRetry accepts the error", async () => {
    const transientError = new Error("fetch failed");
    const fn = vi
      .fn()
      .mockRejectedValueOnce(transientError)
      .mockResolvedValueOnce("recovered");
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await retryWithBackoff(fn, { sleep, shouldRetry: () => true });

    expect(result).toEqual({ success: true, value: "recovered", retryCount: 1 });
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
