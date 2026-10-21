import { describe, it, expect, afterEach } from "vitest";
import {
  checkWebhookReplay,
  claimWebhookNonce,
  extractWebhookNonce,
  extractWebhookTimestamp,
  isTimestampWithinTolerance,
  _setNonceRedisClientForTesting,
  DEFAULT_MAX_SKEW_SECONDS,
} from "./replayGuard.js";

// Issue #352 — cryptographic nonce + timestamp tolerance for webhook ingestion.

describe("isTimestampWithinTolerance", () => {
  it("accepts a timestamp within the default 300s skew", () => {
    const now = Date.now() / 1000;
    expect(isTimestampWithinTolerance(now - 100, DEFAULT_MAX_SKEW_SECONDS, now)).toBe(true);
  });

  it("rejects a timestamp older than the configured skew", () => {
    const now = Date.now() / 1000;
    expect(isTimestampWithinTolerance(now - 301, DEFAULT_MAX_SKEW_SECONDS, now)).toBe(false);
  });

  it("rejects a timestamp from the future beyond the skew", () => {
    const now = Date.now() / 1000;
    expect(isTimestampWithinTolerance(now + 400, DEFAULT_MAX_SKEW_SECONDS, now)).toBe(false);
  });

  it("rejects non-finite timestamps", () => {
    expect(isTimestampWithinTolerance(Number.NaN)).toBe(false);
  });
});

describe("claimWebhookNonce + checkWebhookReplay", () => {
  afterEach(() => {
    _setNonceRedisClientForTesting(null);
  });

  it("claims a nonce the first time it is seen", async () => {
    const claimed = await claimWebhookNonce("test-ns", "nonce-1");
    expect(claimed).toBe(true);
  });

  it("rejects a replayed nonce within the TTL window", async () => {
    expect(await claimWebhookNonce("test-ns", "nonce-2")).toBe(true);
    expect(await claimWebhookNonce("test-ns", "nonce-2")).toBe(false);
  });

  it("scopes nonces per namespace — the same nonce in a different namespace is not a replay", async () => {
    expect(await claimWebhookNonce("ns-a", "shared-nonce")).toBe(true);
    expect(await claimWebhookNonce("ns-b", "shared-nonce")).toBe(true);
  });

  it("checkWebhookReplay rejects a stale timestamp before even looking at the nonce", async () => {
    const result = await checkWebhookReplay("test-ns", {
      timestamp: Date.now() / 1000 - 1000,
      nonce: "irrelevant",
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("TIMESTAMP_EXPIRED");
  });

  it("checkWebhookReplay rejects a replayed nonce with a fresh timestamp", async () => {
    const now = Date.now() / 1000;
    const first = await checkWebhookReplay("test-ns", { timestamp: now, nonce: "replay-me" });
    expect(first.ok).toBe(true);

    const second = await checkWebhookReplay("test-ns", { timestamp: now, nonce: "replay-me" });
    expect(second.ok).toBe(false);
    expect(second.code).toBe("NONCE_REPLAYED");
  });

  it("checkWebhookReplay passes through when no nonce is supplied (timestamp-only protection)", async () => {
    const result = await checkWebhookReplay("test-ns", {
      timestamp: Date.now() / 1000,
      nonce: undefined,
    });
    expect(result.ok).toBe(true);
  });
});

describe("header extraction", () => {
  it("extracts the nonce from X-Webhook-Nonce or X-Nonce", () => {
    expect(extractWebhookNonce({ "x-webhook-nonce": "abc" })).toBe("abc");
    expect(extractWebhookNonce({ "x-nonce": "def" })).toBe("def");
    expect(extractWebhookNonce({})).toBeUndefined();
  });

  it("extracts the timestamp from X-Webhook-Timestamp or X-Timestamp", () => {
    expect(extractWebhookTimestamp({ "x-webhook-timestamp": "1700000000" })).toBe(1700000000);
    expect(extractWebhookTimestamp({ "x-timestamp": "1700000001" })).toBe(1700000001);
  });

  it("falls back to the current time when no timestamp header is sent", () => {
    const before = Date.now() / 1000;
    const extracted = extractWebhookTimestamp({});
    const after = Date.now() / 1000;
    expect(extracted).toBeGreaterThanOrEqual(before);
    expect(extracted).toBeLessThanOrEqual(after);
  });
});
