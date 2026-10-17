/**
 * Unit tests for Issue #351 — timing-safe HMAC verification on incoming
 * carrier webhooks.
 */

import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { timingSafeHmacVerify } from "./carrierWebhook.js";

const SECRET = "carrier-webhook-secret";

function sign(body: string, secret = SECRET): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

describe("timingSafeHmacVerify", () => {
  it("accepts a correctly signed payload", () => {
    const body = JSON.stringify({ id: "evt_1" });
    expect(timingSafeHmacVerify(body, SECRET, sign(body))).toBe(true);
  });

  it("accepts a sha256=<hex> prefixed signature", () => {
    const body = JSON.stringify({ id: "evt_1" });
    expect(timingSafeHmacVerify(body, SECRET, `sha256=${sign(body)}`)).toBe(true);
  });

  it("rejects a tampered payload", () => {
    const original = JSON.stringify({ id: "evt_1" });
    const tampered = JSON.stringify({ id: "evt_2" });
    expect(timingSafeHmacVerify(tampered, SECRET, sign(original))).toBe(false);
  });

  it("rejects a same-length but incorrect signature", () => {
    const body = JSON.stringify({ id: "evt_1" });
    expect(timingSafeHmacVerify(body, SECRET, "0".repeat(64))).toBe(false);
  });

  it("rejects a partial/truncated signature without throwing", () => {
    const body = JSON.stringify({ id: "evt_1" });
    const truncated = sign(body).slice(0, 10);
    expect(() => timingSafeHmacVerify(body, SECRET, truncated)).not.toThrow();
    expect(timingSafeHmacVerify(body, SECRET, truncated)).toBe(false);
  });

  it("rejects an overly long signature without throwing", () => {
    const body = JSON.stringify({ id: "evt_1" });
    const overlong = sign(body) + "deadbeef".repeat(50);
    expect(() => timingSafeHmacVerify(body, SECRET, overlong)).not.toThrow();
    expect(timingSafeHmacVerify(body, SECRET, overlong)).toBe(false);
  });

  it("rejects a missing signature without throwing", () => {
    const body = JSON.stringify({ id: "evt_1" });
    expect(() => timingSafeHmacVerify(body, SECRET, undefined)).not.toThrow();
    expect(timingSafeHmacVerify(body, SECRET, undefined)).toBe(false);
    expect(timingSafeHmacVerify(body, SECRET, "")).toBe(false);
  });

  it("rejects an empty-string signature without throwing", () => {
    const body = "";
    expect(() => timingSafeHmacVerify(body, SECRET, "")).not.toThrow();
    expect(timingSafeHmacVerify(body, SECRET, "")).toBe(false);
  });

  it("rejects when the secret is empty", () => {
    const body = JSON.stringify({ id: "evt_1" });
    expect(timingSafeHmacVerify(body, "", sign(body, ""))).toBe(false);
  });
});
