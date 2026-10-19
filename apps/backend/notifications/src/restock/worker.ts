/**
 * Restock waitlist worker.
 *
 * For each restock job, walks the product's pending waitlist in signup order
 * in batches, notifying each subscriber via email (rate limited) and/or web
 * push. Before every batch the current stock is re-read: if the product sold
 * out again the run stops and the remaining subscribers stay pending for the
 * next restock.
 */

import { Worker, type Job } from "bullmq";
import { Pool } from "pg";
import { Redis } from "ioredis";
import { createLogger } from "@delegolabs/utils";
import { sendEmail } from "../../email/index.js";
import { parseTrackedPushSubscription, sendPushNotification } from "../../push/index.js";
import { getWalletLookupAdapter } from "../walletLookup.js";
import { ChannelRestockNotifier, type RestockNotifier } from "./notifier.js";
import { TokenBucketRateLimiter } from "./rateLimiter.js";
import {
  PgRestockRepository,
  type RestockBatchOutcome,
  type RestockRepository,
} from "./repository.js";
import {
  RESTOCK_QUEUE_NAME,
  redisConnectionFromUrl,
  type RestockNotificationJobData,
} from "./queue.js";

const log = createLogger("notifications:restock:worker", process.env.LOG_LEVEL ?? "info");

export const DEFAULT_RESTOCK_BATCH_SIZE = 50;

export interface RestockProcessorDeps {
  repository: RestockRepository;
  notifier: RestockNotifier;
  batchSize?: number;
}

export interface RestockJobResult {
  notified: number;
  failed: number;
  stoppedReason: "drained" | "out_of_stock" | "product_missing";
}

/** Thrown to hand the job back to BullMQ for a backoff retry. */
export class RestockDeferredError extends Error {
  constructor(productId: string, remainingInBatch: number) {
    super(
      `Transient notification failure for product ${productId}; ${remainingInBatch} subscriber(s) deferred to retry`,
    );
    this.name = "RestockDeferredError";
  }
}

export async function processRestockJob(
  data: RestockNotificationJobData,
  deps: RestockProcessorDeps,
  onProgress?: (progress: { notified: number; failed: number }) => Promise<void> | void,
): Promise<RestockJobResult> {
  const batchSize = deps.batchSize ?? DEFAULT_RESTOCK_BATCH_SIZE;
  let notified = 0;
  let failed = 0;

  for (;;) {
    const product = await deps.repository.getProduct(data.productId);
    if (!product) {
      return { notified, failed, stoppedReason: "product_missing" };
    }
    if (product.stockQuantity <= 0) {
      return { notified, failed, stoppedReason: "out_of_stock" };
    }

    let attempted = 0;
    const outcome = await deps.repository.processPendingBatch(
      data.productId,
      batchSize,
      async (entries): Promise<RestockBatchOutcome> => {
        attempted = entries.length;
        const result: RestockBatchOutcome = { notifiedIds: [], failedIds: [], deferred: false };
        // Sequential on purpose: preserves signup order and lets the email
        // rate limiter pace provider calls.
        for (const entry of entries) {
          const status = await deps.notifier.notify(entry, product);
          if (status === "sent") {
            result.notifiedIds.push(entry.id);
          } else if (status === "permanent_failure") {
            result.failedIds.push(entry.id);
          } else {
            result.deferred = true;
            break;
          }
        }
        return result;
      },
    );

    if (!outcome) {
      return { notified, failed, stoppedReason: "drained" };
    }

    notified += outcome.notifiedIds.length;
    failed += outcome.failedIds.length;
    await onProgress?.({ notified, failed });

    if (outcome.deferred) {
      const remaining = attempted - outcome.notifiedIds.length - outcome.failedIds.length;
      throw new RestockDeferredError(data.productId, remaining);
    }
  }
}

export interface RestockWorkerHandle {
  close(): Promise<void>;
}

/** Start the BullMQ worker with production dependencies. */
export function startRestockWorker(): RestockWorkerHandle {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", { lazyConnect: true });

  const notifier = new ChannelRestockNotifier({
    sendEmail,
    emailLimiter: new TokenBucketRateLimiter(
      Number(process.env.RESTOCK_EMAIL_RATE_PER_SECOND ?? 10),
      Number(process.env.RESTOCK_EMAIL_BURST ?? 10),
    ),
    walletLookup: getWalletLookupAdapter(),
    async getPushSubscriptions(userId) {
      const members = await redis.smembers(`push:subscriptions:${userId}`);
      return members.map((member) => parseTrackedPushSubscription(member).subscription);
    },
    sendPush: sendPushNotification,
    storefrontUrl: process.env.STOREFRONT_URL ?? "https://delego.app",
  });

  const deps: RestockProcessorDeps = {
    repository: new PgRestockRepository(pool),
    notifier,
    batchSize: Number(process.env.RESTOCK_BATCH_SIZE ?? DEFAULT_RESTOCK_BATCH_SIZE),
  };

  const worker = new Worker<RestockNotificationJobData, RestockJobResult>(
    RESTOCK_QUEUE_NAME,
    async (job: Job<RestockNotificationJobData>) => {
      const result = await processRestockJob(job.data, deps, (progress) => job.updateProgress(progress));
      log.info("Restock waitlist run finished", { productId: job.data.productId, ...result });
      return result;
    },
    {
      connection: redisConnectionFromUrl(),
      concurrency: Number(process.env.RESTOCK_WORKER_CONCURRENCY ?? 2),
    },
  );

  worker.on("failed", (job, err) => {
    log.error("Restock waitlist job failed", {
      jobId: job?.id,
      productId: job?.data.productId,
      attempt: job?.attemptsMade,
      error: err.message,
    });
  });

  log.info("Restock waitlist worker started", { queue: RESTOCK_QUEUE_NAME });

  return {
    async close() {
      await worker.close();
      await Promise.allSettled([pool.end(), redis.quit()]);
    },
  };
}
