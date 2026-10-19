/**
 * Low-stock alert worker.
 *
 * Consumes jobs published by the orchestrator when a reservation drops a
 * product to or below its merchant's threshold:
 *  - `dispatch-webhook`: fans `inventory.low_stock` out to the merchant's
 *    subscribed webhooks (signed, SSRF-guarded). Per-endpoint retries are
 *    owned by the webhook dispatcher, so this job never re-sends to
 *    endpoints that already succeeded.
 *  - `send-email`: transactional email to the merchant's contact address.
 *    Transient provider errors throw so BullMQ retries with backoff;
 *    permanent ones are logged and dropped.
 */

import { Worker, type Job } from "bullmq";
import { Pool } from "pg";
import { createLogger } from "@delegolabs/utils";
import {
  LOW_STOCK_JOB,
  LOW_STOCK_QUEUE_NAME,
  LOW_STOCK_WEBHOOK_EVENT,
  type LowStockAlertPayload,
} from "@delegolabs/types";
import { sendEmail, type EmailMessage } from "../../email/index.js";
import { classifyError } from "../../email/errorClassifier.js";
import { WebhookDispatcher, type WebhookSender } from "../../webhooks/dispatcher.js";
import { defaultWebhookRegistry } from "../../webhooks/registry.js";
import { defaultWebhookDeliveryTracker } from "../../webhooks/deliveryTracker.js";
import { postJsonWithPinnedIp, validateWebhookUrl } from "../../webhooks/ssrfGuard.js";
import { redisConnectionFromUrl } from "../restock/queue.js";

const log = createLogger("notifications:low-stock:worker", process.env.LOG_LEVEL ?? "info");

const WEBHOOK_TIMEOUT_MS = 10_000;

export interface MerchantContact {
  email: string | null;
  storeName: string | null;
}

export interface LowStockJobDeps {
  dispatchWebhook(
    eventType: string,
    payload: Record<string, unknown>,
    eventId: string,
  ): Promise<unknown>;
  getMerchantContact(merchantId: string): Promise<MerchantContact | null>;
  sendEmail(message: EmailMessage): Promise<void>;
  dashboardUrl: string;
}

export type LowStockJobOutcome =
  | "webhook_dispatched"
  | "email_sent"
  | "email_skipped_no_contact"
  | "email_dropped_permanent_failure";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Stable per alert so a retried job reuses the same webhook event id. */
export function lowStockEventId(payload: LowStockAlertPayload): string {
  return `low-stock-${payload.merchantId}-${payload.productId}-${payload.triggeredAt}`;
}

export function buildLowStockEmail(
  to: string,
  payload: LowStockAlertPayload,
  dashboardUrl: string,
  storeName: string | null,
): EmailMessage {
  const title = escapeHtml(payload.title || payload.sku || payload.productId);
  const inventoryUrl = `${dashboardUrl.replace(/\/$/, "")}/inventory/${payload.productId}`;
  const greeting = storeName ? `Hi ${escapeHtml(storeName)},` : "Hi,";
  return {
    to,
    subject: `Low stock: ${payload.title || payload.sku} (${payload.currentStock} left)`,
    html:
      `<p>${greeting}</p>` +
      `<p><strong>${title}</strong> (SKU ${escapeHtml(payload.sku)}) is down to ` +
      `<strong>${payload.currentStock}</strong> unit(s), at or below your alert threshold of ${payload.threshold}.</p>` +
      `<p><a href="${escapeHtml(inventoryUrl)}">Restock now</a> to avoid overselling.</p>`,
    text:
      `${payload.title || payload.sku} (SKU ${payload.sku}) is down to ${payload.currentStock} unit(s) ` +
      `(threshold ${payload.threshold}). Restock: ${inventoryUrl}`,
  };
}

export async function processLowStockJob(
  jobName: string,
  payload: LowStockAlertPayload,
  deps: LowStockJobDeps,
): Promise<LowStockJobOutcome> {
  if (jobName === LOW_STOCK_JOB.dispatchWebhook) {
    await deps.dispatchWebhook(
      LOW_STOCK_WEBHOOK_EVENT,
      payload as unknown as Record<string, unknown>,
      lowStockEventId(payload),
    );
    return "webhook_dispatched";
  }

  if (jobName === LOW_STOCK_JOB.sendEmail) {
    const contact = await deps.getMerchantContact(payload.merchantId);
    if (!contact?.email) {
      log.warn("Merchant has no contact email; skipping low-stock email", {
        merchantId: payload.merchantId,
        productId: payload.productId,
      });
      return "email_skipped_no_contact";
    }

    try {
      await deps.sendEmail(buildLowStockEmail(contact.email, payload, deps.dashboardUrl, contact.storeName));
      return "email_sent";
    } catch (err) {
      if (classifyError(err) === "transient") throw err;
      log.error("Low-stock email permanently failed", {
        merchantId: payload.merchantId,
        productId: payload.productId,
        error: err instanceof Error ? err.message : String(err),
      });
      return "email_dropped_permanent_failure";
    }
  }

  throw new Error(`Unknown low-stock job: ${jobName}`);
}

/** HTTPS sender that re-validates the target and pins the resolved IP (SSRF guard). */
const ssrfSafeSender: WebhookSender = async (webhook, body, headers) => {
  const validation = await validateWebhookUrl(webhook.url);
  if (!validation.isValid) {
    throw new Error(`Webhook URL failed SSRF validation (${validation.reason})`);
  }
  const response = await postJsonWithPinnedIp(
    new URL(webhook.url),
    validation,
    body,
    headers,
    WEBHOOK_TIMEOUT_MS,
  );
  return { status: response.status, body: response.body };
};

export interface LowStockWorkerHandle {
  close(): Promise<void>;
}

export function startLowStockWorker(): LowStockWorkerHandle {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const dispatcher = new WebhookDispatcher(
    defaultWebhookRegistry,
    defaultWebhookDeliveryTracker,
    ssrfSafeSender,
  );

  const deps: LowStockJobDeps = {
    dispatchWebhook: (eventType, payload, eventId) => dispatcher.dispatch(eventType, payload, eventId),
    async getMerchantContact(merchantId) {
      const { rows } = await pool.query<{ contact_email: string | null; store_name: string | null }>(
        "SELECT contact_email, store_name FROM merchants WHERE id = $1",
        [merchantId],
      );
      const row = rows[0];
      return row ? { email: row.contact_email, storeName: row.store_name } : null;
    },
    sendEmail,
    dashboardUrl: process.env.MERCHANT_DASHBOARD_URL ?? "https://merchant.delego.app",
  };

  const worker = new Worker<LowStockAlertPayload, LowStockJobOutcome>(
    LOW_STOCK_QUEUE_NAME,
    async (job: Job<LowStockAlertPayload>) => {
      const outcome = await processLowStockJob(job.name, job.data, deps);
      log.info("Low-stock job processed", {
        job: job.name,
        merchantId: job.data.merchantId,
        productId: job.data.productId,
        outcome,
      });
      return outcome;
    },
    {
      connection: redisConnectionFromUrl(),
      concurrency: Number(process.env.LOW_STOCK_WORKER_CONCURRENCY ?? 5),
    },
  );

  worker.on("failed", (job, err) => {
    log.error("Low-stock job failed", {
      job: job?.name,
      productId: job?.data.productId,
      attempt: job?.attemptsMade,
      error: err.message,
    });
  });

  log.info("Low-stock alert worker started", { queue: LOW_STOCK_QUEUE_NAME });

  return {
    async close() {
      await worker.close();
      await pool.end().catch(() => undefined);
    },
  };
}
