import { Pool, type PoolClient } from "pg";
import { Redis } from "ioredis";
import Redlock from "redlock";
import {
  BullMqLowStockAlertPublisher,
  LowStockAlertService,
  PgProductDetailsLookup,
  createLowStockQueue,
  type DebounceRedis,
  type InventoryLevel,
  type StockLevelObserver,
} from "./lowStockAlerts.js";

export interface InventoryReservationItem {
  merchantId: string;
  productId: string;
  quantity: number;
  /**
   * The order this reservation belongs to (Issue #342). When present, each
   * reserve/release is recorded as a row in `merchant_inventory_reservations`
   * under a unique (merchant_id, order_id, product_id) constraint, so a
   * duplicate checkout retry for the same order fails fast with a unique
   * constraint violation instead of silently double-reserving stock.
   */
  orderId?: string;
}

export class InsufficientStockError extends Error {
  constructor(public readonly productId: string) {
    super(`Insufficient stock for product ${productId}`);
    this.name = "InsufficientStockError";
  }
}

/** Postgres error code for a unique constraint violation. */
const UNIQUE_VIOLATION = "23505";

export class DuplicateReservationError extends Error {
  constructor(
    public readonly orderId: string,
    public readonly productId: string,
  ) {
    super(`Order ${orderId} already has a reservation for product ${productId}`);
    this.name = "DuplicateReservationError";
  }
}

interface ReservationLock {
  acquire(resources: string[], duration: number): Promise<{ release(): Promise<unknown> }>;
}

export class InventoryReservationService {
  constructor(
    private readonly pool: Pick<Pool, "connect">,
    private readonly redlock: ReservationLock,
    /** Notified with post-commit stock levels (low-stock alerting). */
    private readonly stockObserver?: StockLevelObserver,
  ) {}

  async reserve(items: InventoryReservationItem[]): Promise<void> {
    await this.updateReservation(items, "reserve");
  }

  async release(items: InventoryReservationItem[]): Promise<void> {
    await this.updateReservation(items, "release");
  }

  private async updateReservation(
    items: InventoryReservationItem[],
    operation: "reserve" | "release",
  ): Promise<void> {
    if (items.length === 0) return;
    for (const item of items) {
      if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
        throw new Error("Inventory reservation quantities must be positive integers");
      }
    }

    const orderedItems = [...items].sort((left, right) =>
      `${left.merchantId}:${left.productId}`.localeCompare(`${right.merchantId}:${right.productId}`),
    );
    const resources = [...new Set(orderedItems.map(
      (item) => `inventory:${item.merchantId}:${item.productId}`,
    ))];
    const lock = await this.redlock.acquire(resources, 10_000);
    let client: PoolClient | undefined;
    const levels = new Map<string, InventoryLevel>();

    try {
      client = await this.pool.connect();
      await client.query("BEGIN");
      for (const item of orderedItems) {
        const { rows } = await client.query<{
          id: string;
          available_stock: number;
          reserved_stock: number;
          low_stock_threshold: number | null;
        }>(
          "SELECT id, available_stock, reserved_stock, low_stock_threshold FROM merchant_inventory WHERE merchant_id = $1 AND product_id = $2 FOR UPDATE",
          [item.merchantId, item.productId],
        );
        const inventory = rows[0];
        if (!inventory || (operation === "reserve" && inventory.available_stock < item.quantity)) {
          throw new InsufficientStockError(item.productId);
        }
        if (operation === "release" && inventory.reserved_stock < item.quantity) {
          throw new Error(`Cannot release more than the reserved stock for product ${item.productId}`);
        }
        const stockChange = operation === "reserve"
          ? "available_stock = available_stock - $2, reserved_stock = reserved_stock + $2"
          : "available_stock = available_stock + $2, reserved_stock = reserved_stock - $2";
        const stockGuard = operation === "reserve" ? "available_stock >= $2" : "reserved_stock >= $2";
        await client.query(
          `UPDATE merchant_inventory SET ${stockChange}, updated_at = NOW() WHERE id = $1 AND ${stockGuard}`,
          [inventory.id, item.quantity],
        );

        // Track the post-update level; the same product can appear more than
        // once in a batch, so build on the previous level when it does.
        const levelKey = `${item.merchantId}:${item.productId}`;
        const before = levels.get(levelKey)?.availableStock ?? inventory.available_stock;
        levels.set(levelKey, {
          merchantId: item.merchantId,
          productId: item.productId,
          availableStock: operation === "reserve" ? before - item.quantity : before + item.quantity,
          lowStockThreshold: inventory.low_stock_threshold ?? null,
        });

        // Issue #342: record (or clear) the per-order reservation row. The
        // unique index on (merchant_id, order_id, product_id) is what makes
        // a duplicate reservation attempt for the same order fail fast
        // instead of double-reserving stock.
        if (item.orderId) {
          if (operation === "reserve") {
            await client.query(
              `INSERT INTO merchant_inventory_reservations
                 (merchant_id, order_id, product_id, quantity, status, created_at, updated_at)
               VALUES ($1, $2, $3, $4, 'reserved', NOW(), NOW())`,
              [item.merchantId, item.orderId, item.productId, item.quantity],
            );
          } else {
            await client.query(
              `UPDATE merchant_inventory_reservations
               SET status = 'released', updated_at = NOW()
               WHERE merchant_id = $1 AND order_id = $2 AND product_id = $3 AND status = 'reserved'`,
              [item.merchantId, item.orderId, item.productId],
            );
          }
        }
      }
      await client.query("COMMIT");
    } catch (error) {
      await client?.query("ROLLBACK");
      if (isUniqueViolation(error)) {
        const item = orderedItems.find((candidate) => candidate.orderId);
        throw new DuplicateReservationError(item?.orderId ?? "unknown", item?.productId ?? "unknown");
      }
      throw error;
    } finally {
      client?.release();
      await lock.release();
    }

    // Only reached after COMMIT. Decrements may cross a low-stock threshold;
    // releases may lift stock back above it and re-arm the alert.
    if (this.stockObserver && levels.size > 0) {
      await this.stockObserver.onStockLevelsChanged([...levels.values()]).catch(() => undefined);
    }
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === UNIQUE_VIOLATION
  );
}

let reservationService: InventoryReservationService | undefined;

export function getInventoryReservationService(): InventoryReservationService {
  if (!reservationService) {
    const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
    const redis = new Redis(redisUrl, { lazyConnect: true });
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });

    let lowStockAlerts: LowStockAlertService | undefined;
    if (process.env.ENABLE_LOW_STOCK_ALERTS !== "false") {
      const url = new URL(redisUrl);
      lowStockAlerts = new LowStockAlertService(
        redis as unknown as DebounceRedis,
        new PgProductDetailsLookup(pool),
        new BullMqLowStockAlertPublisher(
          createLowStockQueue({
            host: url.hostname,
            port: Number(url.port) || 6379,
            password: url.password || undefined,
          }),
        ),
        { debounceSeconds: Number(process.env.LOW_STOCK_ALERT_DEBOUNCE_SECONDS ?? 6 * 60 * 60) },
      );
    }

    reservationService = new InventoryReservationService(
      pool,
      new Redlock([redis as never]) as unknown as ReservationLock,
      lowStockAlerts,
    );
  }
  return reservationService;
}