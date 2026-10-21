/**
 * Escrow release reminder worker (#587).
 *
 * Escrows auto-finalize (release or dispute) at `orders.escrow_deadline` if the
 * buyer has not confirmed receipt. A recurring BullMQ job scans `in_transit`
 * orders and enqueues one reminder job per (order, window): 48h and 12h before
 * the deadline. Each window is mutually exclusive, so an order is in at most one.
 *
 * Exactly-once delivery has three layers:
 *   1. Deterministic BullMQ jobId per (order, window) stops duplicate enqueues.
 *   2. `escrow_reminders_sent` is claimed (INSERT ... ON CONFLICT DO NOTHING)
 *      before sending, so retries and concurrent workers cannot double-send.
 *   3. The claim is released if the send fails so the retry can send it.
 *
 * The order is re-checked at send time, so a buyer who confirms or disputes
 * between enqueue and delivery gets no reminder.
 */
import { Queue, Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import { createLogger } from "@delegolabs/utils";
import { sendEmail } from "../email/index.js";
import { renderLocalizedTemplate } from "./i18n/localized-template.js";

const log = createLogger("notifications:escrowReminder", process.env.LOG_LEVEL ?? "info");

export const ESCROW_REMINDER_QUEUE = "escrow-release-reminders";
const SCAN_JOB = "scan";
const REMINDER_JOB = "reminder";
const SCAN_SCHEDULER_ID = "escrow-reminder-scan";
const DEFAULT_SCAN_INTERVAL_MS = 15 * 60 * 1000;

/** Reminder windows, largest first. A window covers (next window, this window] hours. */
export const REMINDER_WINDOWS = [48, 12] as const;

export interface EscrowReminderJobData {
  orderId: string;
  buyerEmail: string;
  merchantName: string;
  escrowDeadline: string;
  hoursRemaining: 48 | 12;
}

export interface ReminderDb {
  query(text: string, params: unknown[]): Promise<{ rows: unknown[] }>;
}

export interface ReminderDeps {
  db: ReminderDb;
  sendEmailFn?: typeof sendEmail;
  /** Returns a BCP-47 tag for the buyer; unsupported tags fall back to English. */
  getUserLocale?: (userId: string) => Promise<string>;
  /** Base URL of the web app, used for the confirmation link. */
  appBaseUrl?: string;
  now?: () => Date;
}

/** Deterministic id: BullMQ ignores an add() whose jobId already exists. */
export function reminderJobId(orderId: string, hoursRemaining: number): string {
  return `escrow-reminder-${orderId}-${hoursRemaining}`;
}

/**
 * Orders inside each window that are still in transit, have no unresolved
 * dispute, and have not yet been sent that window's reminder.
 */
export async function findDueReminders(
  db: ReminderDb,
  now: Date
): Promise<EscrowReminderJobData[]> {
  const due: EscrowReminderJobData[] = [];
  for (let i = 0; i < REMINDER_WINDOWS.length; i++) {
    const upper = REMINDER_WINDOWS[i];
    const lower = REMINDER_WINDOWS[i + 1] ?? 0;
    const { rows } = await db.query(
      `SELECT o.id AS order_id, u.email AS buyer_email,
              COALESCE(m.store_name, o.merchant_id) AS merchant_name,
              o.escrow_deadline
         FROM orders o
         JOIN users u ON u.id = o.user_id
         LEFT JOIN merchants m ON m.id::text = o.merchant_id
        WHERE o.status = 'in_transit'
          AND o.deleted_at IS NULL
          AND o.escrow_deadline >  $1::timestamptz + make_interval(hours => $3)
          AND o.escrow_deadline <= $1::timestamptz + make_interval(hours => $2)
          AND NOT EXISTS (SELECT 1 FROM disputes d
                           WHERE d.order_id = o.id AND d.status <> 'resolved')
          AND NOT EXISTS (SELECT 1 FROM escrow_reminders_sent s
                           WHERE s.order_id = o.id AND s.hours_remaining = $2)
        ORDER BY o.escrow_deadline ASC`,
      [now.toISOString(), upper, lower]
    );
    for (const row of rows as Array<{
      order_id: string;
      buyer_email: string;
      merchant_name: string;
      escrow_deadline: Date | string;
    }>) {
      due.push({
        orderId: row.order_id,
        buyerEmail: row.buyer_email,
        merchantName: row.merchant_name,
        escrowDeadline: new Date(row.escrow_deadline).toISOString(),
        hoursRemaining: upper,
      });
    }
  }
  return due;
}

/** Enqueue a reminder job per due (order, window); returns how many were offered. */
export async function enqueueDueReminders(
  queue: Pick<Queue<EscrowReminderJobData>, "add">,
  db: ReminderDb,
  now: Date
): Promise<number> {
  const due = await findDueReminders(db, now);
  for (const data of due) {
    await queue.add(REMINDER_JOB, data, {
      jobId: reminderJobId(data.orderId, data.hoursRemaining),
      attempts: 5,
      backoff: { type: "exponential", delay: 30_000 },
      removeOnComplete: { age: 30 * 24 * 3600 },
      removeOnFail: { age: 30 * 24 * 3600 },
    });
  }
  return due.length;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatDeadline(iso: string, locale: string): string {
  try {
    return `${new Intl.DateTimeFormat(locale, {
      dateStyle: "long",
      timeStyle: "short",
      timeZone: "UTC",
    }).format(new Date(iso))} UTC`;
  } catch {
    return new Date(iso).toUTCString();
  }
}

export type ReminderOutcome = "sent" | "skipped";

/** Send one reminder. Throws on send failure so BullMQ retries. */
export async function processReminder(
  data: EscrowReminderJobData,
  deps: ReminderDeps
): Promise<ReminderOutcome> {
  const { db } = deps;
  const send = deps.sendEmailFn ?? sendEmail;
  const now = (deps.now ?? (() => new Date()))();

  // Re-check: the buyer may have confirmed or disputed since enqueue.
  const { rows: current } = await db.query(
    `SELECT o.user_id
       FROM orders o
      WHERE o.id = $1
        AND o.status = 'in_transit'
        AND o.deleted_at IS NULL
        AND o.escrow_deadline > $2::timestamptz
        AND NOT EXISTS (SELECT 1 FROM disputes d
                         WHERE d.order_id = o.id AND d.status <> 'resolved')`,
    [data.orderId, now.toISOString()]
  );
  const order = (current as Array<{ user_id: string }>)[0];
  if (!order) {
    log.info("Skipping reminder: order no longer eligible", {
      orderId: data.orderId,
      hoursRemaining: data.hoursRemaining,
    });
    return "skipped";
  }

  // Claim before sending so a retry or second worker cannot send it twice.
  const { rows: claimed } = await db.query(
    `INSERT INTO escrow_reminders_sent (order_id, hours_remaining)
     VALUES ($1, $2)
     ON CONFLICT DO NOTHING
     RETURNING order_id`,
    [data.orderId, data.hoursRemaining]
  );
  if (claimed.length === 0) {
    log.info("Skipping reminder: already sent", {
      orderId: data.orderId,
      hoursRemaining: data.hoursRemaining,
    });
    return "skipped";
  }

  try {
    const locale = await (deps.getUserLocale ?? (async () => "en"))(order.user_id);
    const baseUrl = (deps.appBaseUrl ?? process.env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
    const confirmUrl = `${baseUrl}/orders/${encodeURIComponent(data.orderId)}/confirm`;
    const { subject, body } = renderLocalizedTemplate("escrow.release_reminder", locale, {
      orderId: data.orderId,
      merchant: data.merchantName,
      hours: String(data.hoursRemaining),
      deadline: formatDeadline(data.escrowDeadline, locale),
      confirmUrl,
    });
    await send({
      to: data.buyerEmail,
      subject,
      html: `<p>${escapeHtml(body).replace(/\n/g, "<br>")}</p>` +
        `<p><a href="${escapeHtml(confirmUrl)}">${escapeHtml(confirmUrl)}</a></p>`,
      text: body,
    });
  } catch (err) {
    // Release the claim so the BullMQ retry can send it.
    await db.query(
      `DELETE FROM escrow_reminders_sent WHERE order_id = $1 AND hours_remaining = $2`,
      [data.orderId, data.hoursRemaining]
    );
    throw err;
  }

  log.info("Escrow release reminder sent", {
    orderId: data.orderId,
    hoursRemaining: data.hoursRemaining,
  });
  return "sent";
}

export interface EscrowReminderWorkerHandle {
  stop(): Promise<void>;
}

function redisConnection(): Redis {
  return new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
    maxRetriesPerRequest: null,
  });
}

/**
 * Start the recurring scan and the consumer. The scan is a BullMQ job
 * scheduler stored in Redis, so several service instances share one schedule.
 */
export async function startEscrowReminderWorker(
  deps: ReminderDeps,
  scanIntervalMs: number = Number(process.env.ESCROW_REMINDER_SCAN_INTERVAL_MS) || DEFAULT_SCAN_INTERVAL_MS
): Promise<EscrowReminderWorkerHandle> {
  const queue = new Queue<EscrowReminderJobData>(ESCROW_REMINDER_QUEUE, {
    connection: redisConnection(),
  });
  await queue.upsertJobScheduler(SCAN_SCHEDULER_ID, { every: scanIntervalMs }, { name: SCAN_JOB });

  const worker = new Worker<EscrowReminderJobData>(
    ESCROW_REMINDER_QUEUE,
    async (job: Job<EscrowReminderJobData>) => {
      if (job.name === SCAN_JOB) {
        const offered = await enqueueDueReminders(queue, deps.db, (deps.now ?? (() => new Date()))());
        log.info("Escrow reminder scan complete", { offered });
        return;
      }
      await processReminder(job.data, deps);
    },
    { connection: redisConnection() }
  );
  worker.on("failed", (job, error) => {
    log.error("Escrow reminder job failed", { jobId: job?.id, error: error.message });
  });
  worker.on("error", (error) => {
    log.error("Escrow reminder worker error", { error: error.message });
  });

  return {
    async stop() {
      await Promise.all([worker.close(), queue.close()]);
    },
  };
}
