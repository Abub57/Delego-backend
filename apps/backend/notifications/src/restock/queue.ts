/**
 * Restock waitlist queue contract (producer side).
 *
 * Imported by the gateway when a merchant raises a product's stock from zero,
 * and consumed by ./worker.ts in the notifications service.
 */

import { Queue, type ConnectionOptions } from "bullmq";

/** BullMQ rejects ":" in queue names, so the logical name uses dashes. */
export const RESTOCK_QUEUE_NAME = "product-restock-notifications";
export const RESTOCK_JOB_NAME = "notify-waitlist";

export interface RestockNotificationJobData {
  productId: string;
  previousStock: number;
  currentStock: number;
  triggeredAt: string;
}

export function redisConnectionFromUrl(
  redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379",
): ConnectionOptions {
  const url = new URL(redisUrl);
  return {
    host: url.hostname,
    port: Number(url.port) || 6379,
    username: url.username || undefined,
    password: url.password || undefined,
    db: url.pathname.length > 1 ? Number(url.pathname.slice(1)) : undefined,
  };
}

/** Only a transition from out-of-stock to in-stock notifies the waitlist. */
export function isRestock(previousStock: number, currentStock: number): boolean {
  return previousStock <= 0 && currentStock > 0;
}

let queue: Queue<RestockNotificationJobData> | null = null;

function getRestockQueue(): Queue<RestockNotificationJobData> {
  if (!queue) {
    queue = new Queue<RestockNotificationJobData>(RESTOCK_QUEUE_NAME, {
      connection: redisConnectionFromUrl(),
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: "exponential", delay: 30_000 },
        removeOnComplete: 1_000,
        removeOnFail: 5_000,
      },
    });
  }
  return queue;
}

/**
 * Enqueue a waitlist notification run when stock crosses from 0 to >0.
 * Returns whether a job was enqueued.
 *
 * Duplicate jobs for the same product are harmless: the worker claims
 * waitlist rows with `FOR UPDATE SKIP LOCKED`, so each subscriber is
 * notified by exactly one run.
 */
export async function enqueueRestockNotification(
  productId: string,
  previousStock: number,
  currentStock: number,
): Promise<boolean> {
  if (!isRestock(previousStock, currentStock)) return false;

  const data: RestockNotificationJobData = {
    productId,
    previousStock,
    currentStock,
    triggeredAt: new Date().toISOString(),
  };
  await getRestockQueue().add(RESTOCK_JOB_NAME, data);
  return true;
}

export async function closeRestockQueue(): Promise<void> {
  if (queue) {
    await queue.close();
    queue = null;
  }
}
