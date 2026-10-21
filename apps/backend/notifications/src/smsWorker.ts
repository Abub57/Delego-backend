/**
 * BullMQ SMS delivery worker (#595).
 *
 * Twilio carriers return 429 when messages are sent too fast, which drops
 * delivery updates. The queue enforces a per-worker limit of 10 messages per
 * second, retries transient failures with exponential backoff, and masks
 * recipient phone numbers in every log line.
 */

import { Queue, Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import { createLogger } from "@delegolabs/utils";

import { createTwilioSenderFromEnv } from "./sms/twilioClient.js";
import type { SmsSender } from "./sms/types.js";

const log = createLogger("notifications:sms-worker", process.env.LOG_LEVEL ?? "info");

export const SMS_NOTIFICATION_QUEUE = "sms-notifications";
/** Twilio's carrier limit for this integration: 10 messages per second. */
export const SMS_RATE_LIMIT = { max: 10, duration: 1_000 } as const;

export interface SmsNotificationJobData {
  orderId: string;
  recipientPhone: string;
  messageText: string;
  priority: "high" | "standard";
}

let queue: Queue<SmsNotificationJobData> | undefined;
let worker: Worker<SmsNotificationJobData> | undefined;

function connection(): Redis {
  return new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
    maxRetriesPerRequest: null,
  });
}

/** Keep the last four digits so support can correlate without exposing PII. */
export function maskPhoneNumber(phone: string): string {
  const trimmed = phone.trim();
  if (trimmed.length <= 4) return "****";
  const visiblePrefix = trimmed.slice(0, Math.min(3, trimmed.length - 4));
  return `${visiblePrefix}****${trimmed.slice(-4)}`;
}

/** E.164: leading +, first digit 1-9, 7-15 digits total. */
const E164 = /^\+[1-9]\d{6,14}$/;

function normalizeJob(data: SmsNotificationJobData): SmsNotificationJobData {
  const recipientPhone = data.recipientPhone?.trim() ?? "";
  if (!data.orderId?.trim()) {
    throw new TypeError("SMS notification requires an orderId");
  }
  if (!E164.test(recipientPhone)) {
    throw new TypeError("SMS recipientPhone must be an E.164 number");
  }
  if (!data.messageText?.trim()) {
    throw new TypeError("SMS notification requires messageText");
  }
  if (data.priority !== "high" && data.priority !== "standard") {
    throw new TypeError('SMS priority must be "high" or "standard"');
  }
  return { ...data, recipientPhone };
}

/** Enqueue a delivery update. High-priority jobs jump the queue but share the rate limit. */
export async function enqueueSmsNotification(
  data: SmsNotificationJobData
): Promise<{ jobId: string }> {
  const job = normalizeJob(data);
  queue ??= new Queue<SmsNotificationJobData>(SMS_NOTIFICATION_QUEUE, {
    connection: connection(),
  });
  const queued = await queue.add("send", job, {
    priority: job.priority === "high" ? 1 : 10,
    attempts: 3,
    backoff: { type: "exponential", delay: 2_000 },
    removeOnComplete: 1_000,
    removeOnFail: 5_000,
  });
  return { jobId: String(queued.id) };
}

/**
 * Send one notification through the supplied sender. Exported separately from
 * the BullMQ worker so the Twilio boundary stays unit-testable.
 */
export async function sendSmsNotification(
  data: SmsNotificationJobData,
  sender: SmsSender
): Promise<{ providerMessageId: string }> {
  const job = normalizeJob(data);
  log.info("Sending SMS notification", {
    orderId: job.orderId,
    phone: maskPhoneNumber(job.recipientPhone),
    priority: job.priority,
  });

  const result = await sender.send({
    channel: "sms",
    to: job.recipientPhone,
    body: job.messageText,
  });

  log.info("SMS notification sent", {
    orderId: job.orderId,
    phone: maskPhoneNumber(job.recipientPhone),
    providerMessageId: result.providerMessageId,
  });
  return result;
}

/** Start the BullMQ consumer once. Returns null when Twilio is not configured. */
export function startSmsWorker(
  sender: SmsSender | null = createTwilioSenderFromEnv()
): Worker<SmsNotificationJobData> | null {
  if (worker) return worker;
  if (!sender) {
    log.error("SMS worker not started: Twilio credentials are missing");
    return null;
  }

  worker = new Worker<SmsNotificationJobData>(
    SMS_NOTIFICATION_QUEUE,
    async (job: Job<SmsNotificationJobData>) => {
      await sendSmsNotification(job.data, sender);
    },
    {
      connection: connection(),
      limiter: SMS_RATE_LIMIT,
    }
  );

  worker.on("failed", (job, error) => {
    log.error("SMS notification job failed", {
      jobId: job?.id,
      orderId: job?.data.orderId,
      phone: maskPhoneNumber(job?.data.recipientPhone ?? ""),
      error: error.message,
    });
  });
  worker.on("error", (error) => {
    log.error("SMS worker connection failed", { error: error.message });
  });

  return worker;
}

export async function stopSmsWorker(): Promise<void> {
  await Promise.all([worker?.close(), queue?.close()]);
  worker = undefined;
  queue = undefined;
}

export type TwilioDeliveryStatus =
  | "queued"
  | "sent"
  | "delivered"
  | "undelivered"
  | "failed";

export interface TwilioStatusCallback {
  MessageSid: string;
  MessageStatus: TwilioDeliveryStatus;
  To?: string;
  ErrorCode?: string;
}

/**
 * Handle Twilio's status callback for an undelivered/failed message. Logs the
 * provider error with a masked number and reports whether the message landed.
 */
export function handleTwilioStatusCallback(
  payload: TwilioStatusCallback
): { delivered: boolean } {
  const phone = payload.To ? maskPhoneNumber(payload.To) : "unknown";

  if (payload.MessageStatus === "undelivered" || payload.MessageStatus === "failed") {
    log.error("Twilio delivery failed", {
      messageSid: payload.MessageSid,
      phone,
      status: payload.MessageStatus,
      errorCode: payload.ErrorCode,
    });
    return { delivered: false };
  }

  log.info("Twilio delivery status", {
    messageSid: payload.MessageSid,
    phone,
    status: payload.MessageStatus,
  });
  return { delivered: payload.MessageStatus === "delivered" };
}
