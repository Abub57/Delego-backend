/**
 * Outbound webhook event dispatch (Issue #102, #112, #381).
 *
 * Fans an event out to every active, matching webhook subscriber, signs
 * each payload, and records the delivery outcome via the tracker. The HTTP
 * transport is injected so this stays unit-testable without a real network
 * call, matching the sender-injection pattern in ../src/retryWorker.ts.
 *
 * With BullMQ integration:
 * - Uses "merchant-webhooks" queue with exponential backoff (1m, 5m, 30m, 2h, 24h)
 * - Moves failed deliveries to DLQ after 5 attempts
 * - Uses X-Delego-Signature header for HMAC-SHA256 verification
 *
 * Issue #381 — secret rotation:
 * - When a webhook is within its 48-hour rotation grace period, the dispatcher
 *   calls signWebhookPayloadDual() and attaches both X-Delego-Signature and
 *   X-Delego-Signature-Previous, allowing receivers to verify with either key.
 */

import { createLogger } from "@delegolabs/utils";
import { randomUUID } from "node:crypto";
import { signWebhookPayload, signWebhookPayloadDual, WEBHOOK_SIGNATURE_HEADER } from "./hmac.js";
import type { WebhookDeliveryTracker } from "./deliveryTracker.js";
import type { WebhookRegistry } from "./registry.js";
import type { Webhook, DeliveryStatus } from "./types.js";
import type { WebhookBullQueue, WebhookPayload } from "./bullQueue.js";
import type { WebhookSecretRotationService } from "./secretRotation.js";

const log = createLogger("notifications:webhooks:dispatcher", process.env.LOG_LEVEL ?? "info");

export interface WebhookSendResult {
  status: number;
  body?: string;
}

export type WebhookSender = (
  webhook: Webhook,
  body: string,
  headers: Record<string, string>,
) => Promise<WebhookSendResult>;

export interface DispatchSummary {
  eventId: string;
  eventType: string;
  matchedWebhooks: number;
  delivered: number;
  failed: number;
}

/**
 * Webhook dispatcher that can work with either direct HTTP calls (for testing)
 * or BullMQ queue (for production).
 */
export class WebhookDispatcher {
  constructor(
    private registry: WebhookRegistry,
    private tracker: WebhookDeliveryTracker,
    private sender: WebhookSender,
    private queue?: WebhookBullQueue,
    private rotationService?: WebhookSecretRotationService,
  ) {}

  /**
   * Dispatch `eventType`/`payload` to every active webhook subscribed to it
   * whose filters match. Each delivery is attempted once here; failures are
   * left in the tracker as "failed" (with a scheduled nextRetryAt) for the
   * retry worker to pick up.
   *
   * When BullMQ queue is configured, failures are enqueued with exponential
   * backoff delays (1m, 5m, 30m, 2h, 24h) instead of using in-memory scheduling.
   */
  async dispatch(
    eventType: string,
    payload: Record<string, unknown>,
    eventId = randomUUID(),
  ): Promise<DispatchSummary> {
    const subscribers = this.registry.findSubscribers(eventType, payload);
    let delivered = 0;
    let failed = 0;

    for (const webhook of subscribers) {
      const ok = await this.deliverOnce(webhook, eventType, payload, eventId);
      if (ok) delivered += 1;
      else failed += 1;
    }

    log.info("Webhook event dispatched", {
      eventId,
      eventType,
      matchedWebhooks: subscribers.length,
      delivered,
      failed,
    });

    return { eventId, eventType, matchedWebhooks: subscribers.length, delivered, failed };
  }

  /**
   * Retry a previously failed delivery. This method is used both for:
   * - In-memory retry worker (when queue is not configured)
   * - BullMQ queue jobs (when queue is configured)
   */
  async retry(deliveryId: string): Promise<boolean> {
    const delivery = this.tracker.getDelivery(deliveryId);
    if (!delivery) {
      throw new Error(`Webhook delivery record not found: ${deliveryId}`);
    }
    const webhook = this.registry.get(delivery.webhookId);
    if (!webhook) {
      throw new Error(`Webhook not found: ${delivery.webhookId}`);
    }

    this.tracker.incrementAttempt(deliveryId);
    return this.send(webhook, delivery.eventType, delivery.payload as Record<string, unknown>, deliveryId);
  }

  /**
   * Enqueue a failed delivery to the BullMQ queue with exponential backoff.
   * Only called when BullMQ queue is configured.
   */
  async enqueueWithBackoff(webhook: Webhook, eventType: string, payload: unknown, deliveryId: string, attempt: number): Promise<void> {
    if (!this.queue) {
      throw new Error("BullMQ queue not configured");
    }

    const webhookPayload: WebhookPayload = {
      id: deliveryId,
      event: eventType as WebhookPayload["event"],
      timestamp: new Date().toISOString(),
      data: payload,
    };

    await this.queue.enqueueWithBackoff(webhook.id, webhookPayload, attempt);
    log.info("Webhook delivery enqueued with backoff", {
      webhookId: webhook.id,
      eventId: deliveryId,
      attempt,
    });
  }

  private async deliverOnce(
    webhook: Webhook,
    eventType: string,
    payload: Record<string, unknown>,
    eventId: string,
  ): Promise<boolean> {
    const delivery = this.tracker.recordAttempt(webhook.id, eventId, eventType, payload);
    const ok = await this.send(webhook, eventType, payload, delivery.id);

    // When BullMQ queue is configured, enqueue failed deliveries for retry
    if (!ok && this.queue) {
      const updatedDelivery = this.tracker.getDelivery(delivery.id);
      if (updatedDelivery && updatedDelivery.status === "failed") {
        try {
          await this.enqueueWithBackoff(webhook, eventType, payload, delivery.id, updatedDelivery.attempt);
        } catch (err) {
          log.error("Failed to enqueue webhook for retry", {
            webhookId: webhook.id,
            eventId: delivery.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    return ok;
  }

  private async send(
    webhook: Webhook,
    eventType: string,
    payload: Record<string, unknown>,
    deliveryId: string,
  ): Promise<boolean> {
    const body = JSON.stringify({
      eventId: deliveryId,
      event: eventType,
      timestamp: new Date().toISOString(),
      data: payload,
    });

    // Issue #381: use dual-signing headers when the rotation service reports
    // an active grace period for this webhook; otherwise fall back to the
    // single-secret path using the webhook's stored secret directly.
    const rotationState = this.rotationService?.getState(webhook.id);
    const signatureHeaders: Record<string, string> =
      rotationState && this.rotationService?.isInGracePeriod(webhook.id)
        ? signWebhookPayloadDual(body, rotationState.currentSecret, rotationState.previousSecret)
        : {
            // When a rotation state exists but is outside the grace period, use the
            // rotated secret (not the stale webhook.secret); fall back to webhook.secret
            // if no rotation has ever been initiated.
            [WEBHOOK_SIGNATURE_HEADER]: signWebhookPayload(
              body,
              rotationState?.currentSecret ?? webhook.secret,
            ),
          };

    const headers = {
      "Content-Type": "application/json",
      ...signatureHeaders,
      "X-Webhook-Id": webhook.id,
      "X-Webhook-Version": String(webhook.version),
      ...webhook.headers,
    };

    try {
      const result = await this.sender(webhook, body, headers);
      if (result.status >= 200 && result.status < 300) {
        this.tracker.recordSuccess(deliveryId, result.status, result.body);
        return true;
      }
      this.tracker.recordFailure(
        deliveryId,
        `Non-2xx response: ${result.status}`,
        webhook.retryPolicy,
        result.status,
      );
      return false;
    } catch (err) {
      this.tracker.recordFailure(
        deliveryId,
        err instanceof Error ? err.message : String(err),
        webhook.retryPolicy,
      );
      return false;
    }
  }
}