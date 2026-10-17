/**
 * BullMQ queue for merchant webhook deliveries (Issue #112).
 *
 * Uses a named queue "merchant-webhooks" with:
 * - Exponential backoff retries (1m, 5m, 30m, 2h, 24h)
 * - Dead letter queue after 5 failed attempts
 * - HMAC-SHA256 signature validation on delivery
 * - SSRF defense (Issue #348): every delivery is validated and sent via
 *   ssrfGuard.ts, which rejects private/loopback/link-local targets and
 *   non-HTTPS URLs and pins the TCP connection to the validated IP.
 */

import { Queue, Worker, QueueEvents } from "bullmq";
import { createLogger } from "@delegolabs/utils";
import { signWebhookPayload, WEBHOOK_SIGNATURE_HEADER, type WebhookPayload } from "./hmac.js";
import { WebhookRegistry } from "./registry.js";
import type { Webhook } from "./types.js";
import { validateWebhookUrl, postJsonWithPinnedIp } from "./ssrfGuard.js";

const log = createLogger("notifications:webhooks:bullQueue", process.env.LOG_LEVEL ?? "info");

// Requested backoff delays: 1m, 5m, 30m, 2h, 24h
export const RETRY_DELAYS_MS = [60_000, 300_000, 1_800_000, 7_200_000, 86_400_000];

export interface WebhookJobData {
  webhookId: string;
  payload: WebhookPayload;
  attempt: number;
}

export class WebhookBullQueue {
  private queue: Queue;
  private queueEvents: QueueEvents;
  private worker?: Worker;
  private isProcessing = false;

  constructor(
    private redisConnection: { host: string; port: number; password?: string },
    private registry: WebhookRegistry = new WebhookRegistry(),
  ) {
    this.queue = new Queue("merchant-webhooks", {
      connection: redisConnection,
      defaultJobOptions: {
        attempts: 5,
        backoff: {
          type: "custom",
          getAttempts: () => 5,
        },
        removeOnComplete: true,
        removeOnFail: false,
      },
    });

    this.queueEvents = new QueueEvents("merchant-webhooks", { connection: redisConnection });
  }

  /**
   * Start processing webhook deliveries.
   * Returns a stop function for graceful shutdown.
   */
  start(): () => void {
    if (this.worker) {
      log.warn("Webhook worker already started");
      return () => this.stop();
    }

    this.worker = new Worker(
      "merchant-webhooks",
      async (job) => {
        return this.processJob(job);
      },
      {
        connection: this.redisConnection,
        concurrency: Number(process.env.WEBHOOK_CONCURRENCY ?? 10),
        lockDuration: 30_000,
      },
    );

    this.worker.on("completed", (job) => {
      log.debug("Webhook job completed", { jobId: job.id, attempt: job.attemptsMade });
    });

    this.worker.on("failed", (job, error) => {
      log.error("Webhook job failed", {
        jobId: job.id,
        attempt: job.attemptsMade,
        error: error.message,
      });
    });

    this.isProcessing = true;
    log.info("Webhook worker started");

    return () => this.stop();
  }

  async stop(): Promise<void> {
    if (this.worker) {
      log.info("Stopping webhook worker");
      await this.worker.close();
      this.worker = undefined;
      this.isProcessing = false;
    }

    if (this.queueEvents) {
      await this.queueEvents.close();
    }
  }

  /**
   * Enqueue a webhook delivery job.
   * Uses exponential backoff delays based on attempt number.
   */
  async enqueue(
    webhookId: string,
    payload: WebhookPayload,
    delayMs?: number,
  ): Promise<void> {
    const jobOptions: Record<string, unknown> = {};

    // Apply exponential backoff delay for retries
    if (delayMs && delayMs > 0) {
      jobOptions.delay = delayMs;
    }

    const jobData: WebhookJobData = {
      webhookId,
      payload,
      attempt: 1,
    };

    await this.queue.add("deliver-webhook", jobData, jobOptions);
    log.debug("Webhook job enqueued", {
      webhookId,
      eventId: payload.id,
      event: payload.event,
      delayMs,
    });
  }

  /**
   * Enqueue a webhook delivery with automatic backoff based on previous attempts.
   */
  async enqueueWithBackoff(
    webhookId: string,
    payload: WebhookPayload,
    attempt: number,
  ): Promise<void> {
    // Calculate delay based on attempt (0-indexed for RETRY_DELAYS_MS array)
    const delayIndex = Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1);
    const delayMs = RETRY_DELAYS_MS[delayIndex];

    await this.enqueue(webhookId, payload, delayMs);
  }

  /**
   * Process a single webhook delivery job.
   */
  private async processJob(job: import("bullmq").Job): Promise<void> {
    const data = job.data as WebhookJobData;
    const webhook = this.registry.get(data.webhookId);

    if (!webhook) {
      throw new Error(`Webhook not found: ${data.webhookId}`);
    }

    const body = JSON.stringify(data.payload);
    const signature = signWebhookPayload(body, webhook.secret);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      [WEBHOOK_SIGNATURE_HEADER]: signature,
      "X-Webhook-Id": webhook.id,
      "X-Webhook-Version": String(webhook.version),
    };

    // Issue #348 — SSRF defense: resolve the webhook hostname and reject
    // private/loopback/link-local IPs (including the 169.254.169.254
    // cloud-metadata address) and non-HTTPS URLs *right before sending*,
    // then pin the TCP connection to that resolved IP so a second DNS
    // lookup at connect time can't be used for a rebinding attack.
    const validation = await validateWebhookUrl(webhook.url);
    if (!validation.isValid) {
      log.error("Webhook URL failed SSRF validation — refusing to deliver", {
        webhookId: webhook.id,
        url: webhook.url,
        reason: validation.reason,
      });
      throw new Error(
        `Webhook URL failed SSRF validation (${validation.reason}): refusing to deliver to ${webhook.url}`,
      );
    }

    log.info("Delivering webhook", {
      webhookId: webhook.id,
      url: webhook.url,
      eventId: data.payload.id,
      event: data.payload.event,
      attempt: data.attempt,
      resolvedIp: validation.ipAddress,
    });

    const response = await postJsonWithPinnedIp(new URL(webhook.url), validation, body, headers, 30_000);

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    log.info("Webhook delivered successfully", {
      webhookId: webhook.id,
      eventId: data.payload.id,
      status: response.status,
    });
  }

  /**
   * Get queue metrics.
   */
  async getMetrics(): Promise<{
    active: number;
    waiting: number;
    completed: number;
    failed: number;
    delayed: number;
  }> {
    return {
      active: await this.queue.getActiveCount(),
      waiting: await this.queue.getWaitingCount(),
      completed: await this.queue.getCompletedCount(),
      failed: await this.queue.getFailedCount(),
      delayed: await this.queue.getDelayedCount(),
    };
  }

  /**
   * Clear all jobs from the queue.
   */
  async clear(): Promise<void> {
    await this.queue.drain();
    log.info("Webhook queue cleared");
  }

  /**
   * Check if the worker is processing jobs.
   */
  isWorkerRunning(): boolean {
    return this.isProcessing && this.worker !== undefined;
  }
}

// Default queue instance for DI
export const createWebhookBullQueue = (redisUrl: string, registry?: WebhookRegistry): WebhookBullQueue => {
  const url = new URL(redisUrl);
  return new WebhookBullQueue(
    {
      host: url.hostname,
      port: Number(url.port) || 6379,
      password: url.password || undefined,
    },
    registry,
  );
};
