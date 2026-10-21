import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getWebhookIdempotencyKey,
  resetWebhookIdempotencyCache,
  runIdempotently,
} from "./idempotency.js";

afterEach(() => {
  resetWebhookIdempotencyCache();
  vi.useRealTimers();
});

describe("webhook idempotency", () => {
  it("normalizes the key header and rejects missing or blank values", () => {
    expect(getWebhookIdempotencyKey("  request-1  ")).toBe("request-1");
    expect(getWebhookIdempotencyKey(["request-2", "ignored"])).toBe("request-2");
    expect(getWebhookIdempotencyKey(undefined)).toBeUndefined();
    expect(getWebhookIdempotencyKey("   ")).toBeUndefined();
  });

  it("returns the first operation response for duplicate requests", async () => {
    const operation = vi.fn().mockResolvedValue({ status: 200, signature: "tx-123" });

    const first = await runIdempotently("escrow-42:request-1", operation);
    const duplicate = await runIdempotently("escrow-42:request-1", operation);

    expect(first).toEqual({ status: 200, signature: "tx-123" });
    expect(duplicate).toBe(first);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("expires cached responses after 24 hours", async () => {
    vi.useFakeTimers();
    const operation = vi.fn().mockResolvedValue("processed");

    await runIdempotently("escrow-42:request-1", operation);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    await runIdempotently("escrow-42:request-1", operation);

    expect(operation).toHaveBeenCalledTimes(2);
  });
});