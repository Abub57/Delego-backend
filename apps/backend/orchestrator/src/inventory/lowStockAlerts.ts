/**
 * Low-stock alerting for merchant inventory.
 *
 * After each committed inventory change the reservation service reports the
 * new stock levels here. Any row whose `available_stock` is at or below its
 * merchant-configured `low_stock_threshold` produces one alert, which is
 * published as two jobs for the notifications service: an `inventory.low_stock`
 * webhook (high priority, processed immediately) and a transactional email.
 *
 * Debouncing: a Redis key per (merchant, product) is claimed with SET NX EX,
 * so a hot item selling unit by unit below its threshold alerts once per
 * window instead of on every decrement. The key is cleared as soon as stock
 * climbs back above the threshold, re-arming the alert for the next dip.
 */

import { Queue, type ConnectionOptions } from "bullmq";
import type { Pool } from "pg";
import { createLogger } from "@delegolabs/utils";
import {
  LOW_STOCK_JOB,
  LOW_STOCK_QUEUE_NAME,
  type LowStockAlertPayload,
} from "@delegolabs/types";

const log = createLogger("orchestrator:inventory:low-stock", process.env.LOG_LEVEL ?? "info");

export const DEFAULT_LOW_STOCK_DEBOUNCE_SECONDS = 6 * 60 * 60;

/** Post-commit stock level for one inventory row. */
export interface InventoryLevel {
  merchantId: string;
  productId: string;
  availableStock: number;
  lowStockThreshold: number | null;
}

export interface StockLevelObserver {
  onStockLevelsChanged(levels: InventoryLevel[]): Promise<unknown>;
}

export interface LowStockAlertPublisher {
  publish(payload: LowStockAlertPayload): Promise<void>;
}

export interface ProductDetailsLookup {
  getProductDetails(productId: string): Promise<{ sku: string; title: string } | null>;
}

/** Minimal Redis surface for the debounce keys (subset of ioredis). */
export interface DebounceRedis {
  set(key: string, value: string, ...args: Array<string | number>): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

export interface LowStockAlertServiceOptions {
  debounceSeconds?: number;
  now?: () => Date;
}

export function lowStockDebounceKey(merchantId: string, productId: string): string {
  return `inventory:low_stock:alerted:${merchantId}:${productId}`;
}

export class LowStockAlertService implements StockLevelObserver {
  private readonly debounceSeconds: number;
  private readonly now: () => Date;

  constructor(
    private readonly redis: DebounceRedis,
    private readonly products: ProductDetailsLookup,
    private readonly publisher: LowStockAlertPublisher,
    options: LowStockAlertServiceOptions = {},
  ) {
    this.debounceSeconds = options.debounceSeconds ?? DEFAULT_LOW_STOCK_DEBOUNCE_SECONDS;
    this.now = options.now ?? (() => new Date());
  }

  /** Returns the alerts that were published (empty when nothing crossed or all were debounced). */
  async onStockLevelsChanged(levels: InventoryLevel[]): Promise<LowStockAlertPayload[]> {
    const published: LowStockAlertPayload[] = [];
    for (const level of levels) {
      try {
        const payload = await this.evaluate(level);
        if (payload) published.push(payload);
      } catch (err) {
        // Alerting must never affect the inventory operation that triggered it.
        log.error("Low-stock evaluation failed", {
          merchantId: level.merchantId,
          productId: level.productId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return published;
  }

  private async evaluate(level: InventoryLevel): Promise<LowStockAlertPayload | null> {
    if (level.lowStockThreshold === null) return null;
    const key = lowStockDebounceKey(level.merchantId, level.productId);

    if (level.availableStock > level.lowStockThreshold) {
      await this.redis.del(key);
      return null;
    }

    const claimed = await this.redis.set(
      key,
      String(level.availableStock),
      "EX",
      this.debounceSeconds,
      "NX",
    );
    if (claimed !== "OK") return null;

    try {
      const details = await this.products.getProductDetails(level.productId);
      const payload: LowStockAlertPayload = {
        merchantId: level.merchantId,
        productId: level.productId,
        sku: details?.sku ?? "",
        title: details?.title ?? "",
        currentStock: level.availableStock,
        threshold: level.lowStockThreshold,
        triggeredAt: this.now().toISOString(),
      };
      await this.publisher.publish(payload);
      log.info("Low-stock alert published", {
        merchantId: payload.merchantId,
        productId: payload.productId,
        currentStock: payload.currentStock,
        threshold: payload.threshold,
      });
      return payload;
    } catch (err) {
      // Release the debounce claim so the next decrement retries the alert.
      await this.redis.del(key).catch(() => undefined);
      throw err;
    }
  }
}

/** Publishes each alert as a high-priority webhook job plus a transactional email job. */
export class BullMqLowStockAlertPublisher implements LowStockAlertPublisher {
  constructor(private readonly queue: Pick<Queue<LowStockAlertPayload>, "addBulk">) {}

  async publish(payload: LowStockAlertPayload): Promise<void> {
    await this.queue.addBulk([
      {
        name: LOW_STOCK_JOB.dispatchWebhook,
        data: payload,
        opts: {
          priority: 1,
          attempts: 5,
          backoff: { type: "exponential", delay: 10_000 },
          removeOnComplete: 1_000,
          removeOnFail: 5_000,
        },
      },
      {
        name: LOW_STOCK_JOB.sendEmail,
        data: payload,
        opts: {
          priority: 5,
          attempts: 5,
          backoff: { type: "exponential", delay: 30_000 },
          removeOnComplete: 1_000,
          removeOnFail: 5_000,
        },
      },
    ]);
  }
}

export function createLowStockQueue(connection: ConnectionOptions): Queue<LowStockAlertPayload> {
  return new Queue<LowStockAlertPayload>(LOW_STOCK_QUEUE_NAME, { connection });
}

export class PgProductDetailsLookup implements ProductDetailsLookup {
  constructor(private readonly pool: Pick<Pool, "query">) {}

  async getProductDetails(productId: string): Promise<{ sku: string; title: string } | null> {
    const { rows } = await this.pool.query<{ sku: string; title: string }>(
      "SELECT sku, title FROM products WHERE id = $1",
      [productId],
    );
    return rows[0] ?? null;
  }
}
