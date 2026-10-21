/**
 * Unit tests for WebhookSecretRotationService (Issue #381).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { WebhookSecretRotationService } from "./secretRotation.js";
import { ROTATION_GRACE_PERIOD_MS } from "./types.js";
import { signWebhookPayload } from "./hmac.js";
import { createHmac } from "node:crypto";

// ─── helpers ──────────────────────────────────────────────────────────────────

const SECRET = "a".repeat(64);
const WEBHOOK_ID = "wh-test-001";
const BODY = JSON.stringify({ event: "order.created", data: { id: 42 } });

/** Return a Date that is `ms` milliseconds in the future from `base`. */
function future(ms: number, base = new Date()): Date {
  return new Date(base.getTime() + ms);
}

/** Return a Date that is `ms` milliseconds in the past from `base`. */
function past(ms: number, base = new Date()): Date {
  return new Date(base.getTime() - ms);
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe("WebhookSecretRotationService", () => {
  let svc: WebhookSecretRotationService;

  beforeEach(() => {
    svc = new WebhookSecretRotationService();
  });

  // ── rotate() ────────────────────────────────────────────────────────────────

  describe("rotate()", () => {
    it("returns a new state with a fresh currentSecret", () => {
      const state = svc.rotate(WEBHOOK_ID, SECRET);
      expect(state.currentSecret).not.toBe(SECRET);
      // 32 random bytes → 64 hex chars
      expect(state.currentSecret).toHaveLength(64);
    });

    it("stores the original secret as previousSecret", () => {
      const state = svc.rotate(WEBHOOK_ID, SECRET);
      expect(state.previousSecret).toBe(SECRET);
    });

    it("sets rotationDeadline ~48 h from now", () => {
      const now = new Date();
      const state = svc.rotate(WEBHOOK_ID, SECRET, now);
      const expected = new Date(now.getTime() + ROTATION_GRACE_PERIOD_MS);
      expect(state.rotationDeadline?.getTime()).toBe(expected.getTime());
    });

    it("stores the state so getState() returns it", () => {
      svc.rotate(WEBHOOK_ID, SECRET);
      const state = svc.getState(WEBHOOK_ID);
      expect(state).toBeDefined();
      expect(state?.previousSecret).toBe(SECRET);
    });

    it("chains rotations: a second rotate keeps the latest secret as previousSecret", () => {
      const first = svc.rotate(WEBHOOK_ID, SECRET);
      const second = svc.rotate(WEBHOOK_ID, first.currentSecret);
      // The previous secret is what was current after the first rotation
      expect(second.previousSecret).toBe(first.currentSecret);
      expect(second.currentSecret).not.toBe(first.currentSecret);
    });

    it("generates different secrets on each call", () => {
      const a = svc.rotate("wh-1", SECRET);
      const b = svc.rotate("wh-2", SECRET);
      expect(a.currentSecret).not.toBe(b.currentSecret);
    });
  });

  // ── isInGracePeriod() ────────────────────────────────────────────────────────

  describe("isInGracePeriod()", () => {
    it("returns true immediately after a rotation", () => {
      svc.rotate(WEBHOOK_ID, SECRET);
      expect(svc.isInGracePeriod(WEBHOOK_ID)).toBe(true);
    });

    it("returns false when the deadline has passed", () => {
      const now = new Date();
      svc.rotate(WEBHOOK_ID, SECRET, now);
      // Advance time past the deadline
      const afterDeadline = future(ROTATION_GRACE_PERIOD_MS + 1, now);
      expect(svc.isInGracePeriod(WEBHOOK_ID, afterDeadline)).toBe(false);
    });

    it("returns true at exactly one millisecond before the deadline", () => {
      const now = new Date();
      svc.rotate(WEBHOOK_ID, SECRET, now);
      const justBefore = future(ROTATION_GRACE_PERIOD_MS - 1, now);
      expect(svc.isInGracePeriod(WEBHOOK_ID, justBefore)).toBe(true);
    });

    it("returns false for an unknown webhookId", () => {
      expect(svc.isInGracePeriod("unknown-id")).toBe(false);
    });

    it("returns false when previousSecret has already been cleaned up", () => {
      const now = new Date();
      svc.rotate(WEBHOOK_ID, SECRET, now);
      const afterDeadline = future(ROTATION_GRACE_PERIOD_MS + 1, now);
      svc.cleanExpiredSecrets(afterDeadline);
      expect(svc.isInGracePeriod(WEBHOOK_ID, afterDeadline)).toBe(false);
    });
  });

  // ── sign() ───────────────────────────────────────────────────────────────────

  describe("sign()", () => {
    it("throws when no rotation state exists for the webhookId", () => {
      expect(() => svc.sign("unknown-id", BODY)).toThrow(/No rotation state found/);
    });

    it("returns only a current signature when not in grace period", () => {
      const now = new Date();
      const state = svc.rotate(WEBHOOK_ID, SECRET, now);
      // Jump past the deadline so grace period is over
      const afterDeadline = future(ROTATION_GRACE_PERIOD_MS + 1, now);
      const result = svc.sign(WEBHOOK_ID, BODY, afterDeadline);

      const expected = `sha256=${createHmac("sha256", state.currentSecret).update(BODY, "utf8").digest("hex")}`;
      expect(result.current).toBe(expected);
      expect(result.previous).toBeUndefined();
    });

    it("returns both signatures during the grace period", () => {
      const now = new Date();
      const state = svc.rotate(WEBHOOK_ID, SECRET, now);
      const result = svc.sign(WEBHOOK_ID, BODY, now);

      expect(result.current).toBe(signWebhookPayload(BODY, state.currentSecret));
      expect(result.previous).toBe(signWebhookPayload(BODY, SECRET));
    });

    it("current and previous signatures are different when secrets differ", () => {
      svc.rotate(WEBHOOK_ID, SECRET);
      const result = svc.sign(WEBHOOK_ID, BODY);
      expect(result.current).not.toBe(result.previous);
    });

    it("signatures follow the sha256=<hex> format", () => {
      svc.rotate(WEBHOOK_ID, SECRET);
      const result = svc.sign(WEBHOOK_ID, BODY);
      expect(result.current).toMatch(/^sha256=[a-f0-9]{64}$/);
      expect(result.previous).toMatch(/^sha256=[a-f0-9]{64}$/);
    });
  });

  // ── cleanExpiredSecrets() ────────────────────────────────────────────────────

  describe("cleanExpiredSecrets()", () => {
    it("returns 0 when no deadlines have passed", () => {
      svc.rotate(WEBHOOK_ID, SECRET);
      expect(svc.cleanExpiredSecrets(new Date())).toBe(0);
    });

    it("removes previousSecret and rotationDeadline after the deadline passes", () => {
      const now = new Date();
      const state = svc.rotate(WEBHOOK_ID, SECRET, now);
      const afterDeadline = future(ROTATION_GRACE_PERIOD_MS + 1, now);

      const count = svc.cleanExpiredSecrets(afterDeadline);
      expect(count).toBe(1);

      const cleaned = svc.getState(WEBHOOK_ID);
      expect(cleaned?.currentSecret).toBe(state.currentSecret);
      expect(cleaned?.previousSecret).toBeUndefined();
      expect(cleaned?.rotationDeadline).toBeUndefined();
    });

    it("cleans multiple expired webhooks in a single pass", () => {
      const now = new Date();
      svc.rotate("wh-a", SECRET, now);
      svc.rotate("wh-b", SECRET, now);
      svc.rotate("wh-c", SECRET, now);

      const afterDeadline = future(ROTATION_GRACE_PERIOD_MS + 1, now);
      expect(svc.cleanExpiredSecrets(afterDeadline)).toBe(3);
    });

    it("does not clean webhooks whose deadline has not yet passed", () => {
      const now = new Date();
      svc.rotate("wh-expired", SECRET, past(ROTATION_GRACE_PERIOD_MS + 1, now));
      svc.rotate("wh-active", SECRET, now); // deadline still in the future

      const count = svc.cleanExpiredSecrets(now);
      expect(count).toBe(1);
      expect(svc.getState("wh-active")?.previousSecret).toBe(SECRET);
    });

    it("is idempotent — calling it twice has no additional effect", () => {
      const now = new Date();
      svc.rotate(WEBHOOK_ID, SECRET, now);
      const afterDeadline = future(ROTATION_GRACE_PERIOD_MS + 1, now);

      svc.cleanExpiredSecrets(afterDeadline);
      const secondCount = svc.cleanExpiredSecrets(afterDeadline);
      expect(secondCount).toBe(0);
    });
  });

  // ── setState() / getState() ──────────────────────────────────────────────────

  describe("setState() / getState()", () => {
    it("stores and retrieves an externally provided state", () => {
      const deadline = future(ROTATION_GRACE_PERIOD_MS);
      const state = { currentSecret: "new", previousSecret: "old", rotationDeadline: deadline };
      svc.setState(WEBHOOK_ID, state);
      expect(svc.getState(WEBHOOK_ID)).toEqual(state);
    });

    it("getState() returns undefined for unknown webhook", () => {
      expect(svc.getState("no-such-id")).toBeUndefined();
    });
  });

  // ── remove() ────────────────────────────────────────────────────────────────

  describe("remove()", () => {
    it("returns true and removes the state for a known webhook", () => {
      svc.rotate(WEBHOOK_ID, SECRET);
      expect(svc.remove(WEBHOOK_ID)).toBe(true);
      expect(svc.getState(WEBHOOK_ID)).toBeUndefined();
    });

    it("returns false for an unknown webhook", () => {
      expect(svc.remove("ghost-id")).toBe(false);
    });
  });

  // ── clear() ─────────────────────────────────────────────────────────────────

  describe("clear()", () => {
    it("removes all stored states", () => {
      svc.rotate("wh-1", SECRET);
      svc.rotate("wh-2", SECRET);
      svc.clear();
      expect(svc.getState("wh-1")).toBeUndefined();
      expect(svc.getState("wh-2")).toBeUndefined();
    });
  });
});
