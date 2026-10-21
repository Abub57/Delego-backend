/**
 * Integration tests: WebhookDispatcher dual-signing during secret rotation
 * grace period (Issue #381).
 *
 * These tests exercise the full interaction between WebhookDispatcher,
 * WebhookSecretRotationService, WebhookRegistry, WebhookDeliveryTracker,
 * and the HMAC helpers to verify end-to-end dual-signing behaviour.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { WebhookDispatcher, type WebhookSender } from "./dispatcher.js";
import { WebhookDeliveryTracker } from "./deliveryTracker.js";
import { WebhookRegistry } from "./registry.js";
import { WebhookSecretRotationService } from "./secretRotation.js";
import {
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_SIGNATURE_PREVIOUS_HEADER,
  signWebhookPayload,
} from "./hmac.js";
import { ROTATION_GRACE_PERIOD_MS } from "./types.js";

// ─── test utilities ────────────────────────────────────────────────────────────

function makeSuite() {
  const registry = new WebhookRegistry();
  const tracker = new WebhookDeliveryTracker();
  const rotationService = new WebhookSecretRotationService();

  function makeDispatcher(sender: WebhookSender) {
    return new WebhookDispatcher(registry, tracker, sender, undefined, rotationService);
  }

  return { registry, tracker, rotationService, makeDispatcher };
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe("WebhookDispatcher + WebhookSecretRotationService integration", () => {
  let registry: WebhookRegistry;
  let tracker: WebhookDeliveryTracker;
  let rotationService: WebhookSecretRotationService;
  let makeDispatcher: (sender: WebhookSender) => WebhookDispatcher;

  beforeEach(() => {
    ({ registry, tracker, rotationService, makeDispatcher } = makeSuite());
  });

  // ── without rotation service ────────────────────────────────────────────────

  describe("without rotation service", () => {
    it("sends only X-Delego-Signature using the webhook's stored secret", async () => {
      const webhook = registry.register({
        name: "my-hook",
        url: "https://example.com/hook",
        events: ["order.created"],
      });

      let captured: Record<string, string> = {};
      const sender: WebhookSender = vi.fn(async (_wh, body, headers) => {
        captured = headers;
        return { status: 200 };
      });

      const dispatcher = new WebhookDispatcher(registry, tracker, sender);
      await dispatcher.dispatch("order.created", { orderId: "123" });

      expect(captured[WEBHOOK_SIGNATURE_HEADER]).toMatch(/^sha256=[a-f0-9]{64}$/);
      expect(captured[WEBHOOK_SIGNATURE_PREVIOUS_HEADER]).toBeUndefined();

      // Verify the signature is correct for the webhook's stored secret
      const body = (sender as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(captured[WEBHOOK_SIGNATURE_HEADER]).toBe(signWebhookPayload(body, webhook.secret));
    });
  });

  // ── grace period begins ─────────────────────────────────────────────────────

  describe("during the 48-hour grace period", () => {
    it("sends both X-Delego-Signature and X-Delego-Signature-Previous", async () => {
      const webhook = registry.register({
        name: "rotated-hook",
        url: "https://example.com/hook",
        events: ["order.created"],
      });

      // Initiate rotation: previousSecret = webhook.secret
      const rotationState = rotationService.rotate(webhook.id, webhook.secret);

      let capturedBody = "";
      let capturedHeaders: Record<string, string> = {};
      const sender: WebhookSender = vi.fn(async (_wh, body, headers) => {
        capturedBody = body;
        capturedHeaders = headers;
        return { status: 200 };
      });

      const dispatcher = makeDispatcher(sender);
      await dispatcher.dispatch("order.created", { orderId: "456" });

      // Both headers must be present
      expect(capturedHeaders[WEBHOOK_SIGNATURE_HEADER]).toMatch(/^sha256=[a-f0-9]{64}$/);
      expect(capturedHeaders[WEBHOOK_SIGNATURE_PREVIOUS_HEADER]).toMatch(/^sha256=[a-f0-9]{64}$/);

      // Verify against the new (current) secret
      expect(capturedHeaders[WEBHOOK_SIGNATURE_HEADER]).toBe(
        signWebhookPayload(capturedBody, rotationState.currentSecret),
      );
      // Verify against the old (previous) secret
      expect(capturedHeaders[WEBHOOK_SIGNATURE_PREVIOUS_HEADER]).toBe(
        signWebhookPayload(capturedBody, webhook.secret),
      );
    });

    it("the two signatures are different (secrets differ)", async () => {
      const webhook = registry.register({
        name: "rotated-hook",
        url: "https://example.com/hook",
        events: ["order.created"],
      });
      rotationService.rotate(webhook.id, webhook.secret);

      let capturedHeaders: Record<string, string> = {};
      const sender: WebhookSender = vi.fn(async (_wh, _body, headers) => {
        capturedHeaders = headers;
        return { status: 200 };
      });

      await makeDispatcher(sender).dispatch("order.created", {});

      expect(capturedHeaders[WEBHOOK_SIGNATURE_HEADER]).not.toBe(
        capturedHeaders[WEBHOOK_SIGNATURE_PREVIOUS_HEADER],
      );
    });

    it("delivers successfully and records the delivery as 'delivered'", async () => {
      const webhook = registry.register({
        name: "rotated-hook",
        url: "https://example.com/hook",
        events: ["order.created"],
      });
      rotationService.rotate(webhook.id, webhook.secret);

      const sender: WebhookSender = vi.fn().mockResolvedValue({ status: 200 });
      const summary = await makeDispatcher(sender).dispatch("order.created", {});

      expect(summary.delivered).toBe(1);
      expect(summary.failed).toBe(0);
      const [delivery] = tracker.getAllDeliveries();
      expect(delivery.status).toBe("delivered");
    });

    it("propagates failures correctly during grace period", async () => {
      const webhook = registry.register({
        name: "rotated-hook",
        url: "https://example.com/hook",
        events: ["order.created"],
      });
      rotationService.rotate(webhook.id, webhook.secret);

      const sender: WebhookSender = vi.fn().mockResolvedValue({ status: 500 });
      const summary = await makeDispatcher(sender).dispatch("order.created", {});

      expect(summary.failed).toBe(1);
      const [delivery] = tracker.getAllDeliveries();
      expect(delivery.status).toBe("failed");
    });
  });

  // ── after grace period expires ──────────────────────────────────────────────

  describe("after the grace period expires and cleanExpiredSecrets() runs", () => {
    it("reverts to single signing (no X-Delego-Signature-Previous)", async () => {
      const webhook = registry.register({
        name: "rotated-hook",
        url: "https://example.com/hook",
        events: ["order.created"],
      });

      const now = new Date();
      const rotationState = rotationService.rotate(webhook.id, webhook.secret, now);

      // Simulate time passing past the deadline
      const afterDeadline = new Date(now.getTime() + ROTATION_GRACE_PERIOD_MS + 1);
      rotationService.cleanExpiredSecrets(afterDeadline);

      let capturedBody = "";
      let capturedHeaders: Record<string, string> = {};
      const sender: WebhookSender = vi.fn(async (_wh, body, headers) => {
        capturedBody = body;
        capturedHeaders = headers;
        return { status: 200 };
      });

      // Dispatch with a fake "now" that is after the deadline by using the
      // real dispatcher — cleanExpiredSecrets already removed previousSecret
      await makeDispatcher(sender).dispatch("order.created", {});

      // Only the new-secret header is present
      expect(capturedHeaders[WEBHOOK_SIGNATURE_HEADER]).toBe(
        signWebhookPayload(capturedBody, rotationState.currentSecret),
      );
      expect(capturedHeaders[WEBHOOK_SIGNATURE_PREVIOUS_HEADER]).toBeUndefined();
    });
  });

  // ── multiple subscribers ─────────────────────────────────────────────────────

  describe("multiple subscribers — only the rotated webhook dual-signs", () => {
    it("dual-signs the rotated webhook and single-signs the other", async () => {
      const rotated = registry.register({
        name: "rotated",
        url: "https://a.com/hook",
        events: ["order.created"],
      });
      const normal = registry.register({
        name: "normal",
        url: "https://b.com/hook",
        events: ["order.created"],
      });

      rotationService.rotate(rotated.id, rotated.secret);

      const capturedByWebhook: Record<string, Record<string, string>> = {};
      const sender: WebhookSender = vi.fn(async (webhook, _body, headers) => {
        capturedByWebhook[webhook.id] = headers;
        return { status: 200 };
      });

      await makeDispatcher(sender).dispatch("order.created", {});

      // Rotated webhook has both headers
      expect(capturedByWebhook[rotated.id][WEBHOOK_SIGNATURE_PREVIOUS_HEADER]).toBeDefined();
      // Normal webhook has only the primary signature
      expect(capturedByWebhook[normal.id][WEBHOOK_SIGNATURE_PREVIOUS_HEADER]).toBeUndefined();
      expect(capturedByWebhook[normal.id][WEBHOOK_SIGNATURE_HEADER]).toMatch(/^sha256=/);
    });
  });

  // ── no rotation state but rotationService injected ──────────────────────────

  describe("rotation service is injected but no rotation was initiated", () => {
    it("falls back to signing with the webhook's stored secret", async () => {
      const webhook = registry.register({
        name: "no-rotation",
        url: "https://example.com/hook",
        events: ["order.created"],
      });
      // rotationService exists but rotate() was never called for this webhook

      let capturedBody = "";
      let capturedHeaders: Record<string, string> = {};
      const sender: WebhookSender = vi.fn(async (_wh, body, headers) => {
        capturedBody = body;
        capturedHeaders = headers;
        return { status: 200 };
      });

      await makeDispatcher(sender).dispatch("order.created", {});

      expect(capturedHeaders[WEBHOOK_SIGNATURE_HEADER]).toBe(
        signWebhookPayload(capturedBody, webhook.secret),
      );
      expect(capturedHeaders[WEBHOOK_SIGNATURE_PREVIOUS_HEADER]).toBeUndefined();
    });
  });
});
