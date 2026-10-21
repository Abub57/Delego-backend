/**
 * Row-level lock inventory deduction for flash-sale / high-concurrency checkout.
 *
 * `allocateInventoryWithLock` runs inside a single Postgres transaction,
 * acquires `FOR UPDATE` row locks on every `merchant_inventory` row it
 * touches, checks availability, decrements stock atomically, and only
 * commits if *all* items pass the stock check. On any insufficiency the
 * entire transaction is rolled back and the caller receives the exact set
 * of product IDs that were out of stock.
 *
 * After a successful commit, a stock-deduction event is published to the
 * Redis stream `stock:deductions` so the storefront can update counts in
 * real time without polling.
 */

import type { Pool, PoolClient } from "pg";

// Inline Redis client interface — mirrors the minimal surface used here
// (XADD only) without importing @delegolabs/cache, which requires the
// workspace dist to be built before tests can resolve it.
export interface StockEventRedisClient {
  xadd(
    key: string,
    maxlen: "MAXLEN",
    approx: "~",
    count: string,
    id: "*",
    ...fields: string[]
  ): Promise<string | null>;
}

// Minimal logger — avoids @delegolabs/utils → @delegolabs/types resolution
// failure in the test environment where workspace packages are not pre-built.
const log = {
  debug: (msg: string, ctx?: Record<string, unknown>) => {
    if (process.env.LOG_LEVEL === "debug") console.debug(`[orchestrator:inventory:allocate] ${msg}`, ctx ?? "");
  },
  info: (msg: string, ctx?: Record<string, unknown>) => {
    console.info(`[orchestrator:inventory:allocate] ${msg}`, ctx ?? "");
  },
  warn: (msg: string, ctx?: Record<string, unknown>) => {
    console.warn(`[orchestrator:inventory:allocate] ${msg}`, ctx ?? "");
  },
};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface InventoryDeductionItem {
  productId: string;
  requestedQuantity: number;
}

export interface InventoryDeductionRequest {
  orderId: string;
  items: InventoryDeductionItem[];
  /** Maximum ms to wait for the Postgres transaction (default: 5 000). */
  timeoutMs?: number;
}

export interface AllocatedItem {
  productId: string;
  remainingStock: number;
}

export interface InventoryDeductionResult {
  success: boolean;
  allocatedItems: AllocatedItem[];
  failedProductIds?: string[];
}

// ---------------------------------------------------------------------------
// Stock-deduction event helpers
// ---------------------------------------------------------------------------

const STOCK_DEDUCTION_STREAM = "stock:deductions";

interface StockDeductionEvent {
  orderId: string;
  productId: string;
  deductedQuantity: number;
  remainingStock: number;
  occurredAt: string;
}

/**
 * Publish a stock-deduction event to the Redis stream so the storefront can
 * update inventory counts in real time without polling.
 *
 * We use `XADD` with `MAXLEN ~ 10000` to cap the stream at roughly 10 k
 * entries — old events are automatically trimmed with approximate trimming
 * (`~`) to avoid blocking the write path.
 *
 * Publishing failures are intentionally non-fatal: the Postgres deduction
 * already happened and is durable. A failed publish is logged as a warning;
 * the caller still gets a successful result.
 */
async function publishStockDeductionEvent(
  redis: StockEventRedisClient,
  event: StockDeductionEvent,
): Promise<void> {
  try {
    await redis.xadd(
      STOCK_DEDUCTION_STREAM,
      "MAXLEN",
      "~",
      "10000",
      "*",
      "orderId",
      event.orderId,
      "productId",
      event.productId,
      "deductedQuantity",
      String(event.deductedQuantity),
      "remainingStock",
      String(event.remainingStock),
      "occurredAt",
      event.occurredAt,
    );
    log.debug("Stock deduction event published", { stream: STOCK_DEDUCTION_STREAM, ...event });
  } catch (err) {
    log.warn("Failed to publish stock deduction event — deduction already persisted", {
      productId: event.productId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// Core allocation logic
// ---------------------------------------------------------------------------

interface InventoryRow {
  id: string;
  product_id: string;
  available_stock: number;
}

/**
 * Allocate inventory for all items in a single atomic Postgres transaction.
 *
 * Algorithm:
 *   1. Sort items deterministically (by productId) to avoid deadlocks between
 *      concurrent transactions trying to lock the same rows in different orders.
 *   2. Open a transaction and acquire `FOR UPDATE` on every matching
 *      `merchant_inventory` row — this serialises concurrent deductions for the
 *      same product so no two transactions can see the same `available_stock`.
 *   3. Verify every item has sufficient stock. Collect all failing product IDs
 *      before rolling back so the caller gets the full failure picture in one
 *      round-trip.
 *   4. On any insufficiency, ROLLBACK immediately and return the failed IDs.
 *   5. On full success, decrement every row's `available_stock` and COMMIT.
 *   6. Publish a per-product stock-deduction event to the Redis stream.
 *
 * The `FOR UPDATE` lock is held only for the duration of the transaction —
 * typically a few milliseconds — so this does not create a long-held lock
 * problem even under flash-sale load.
 */
export async function allocateInventoryWithLock(
  request: InventoryDeductionRequest,
  pool: Pool,
  redis: StockEventRedisClient,
): Promise<InventoryDeductionResult> {
  const { orderId, items } = request;

  if (items.length === 0) {
    return { success: true, allocatedItems: [] };
  }

  // Validate quantities up front so we never enter a transaction for bad input.
  for (const item of items) {
    if (!Number.isInteger(item.requestedQuantity) || item.requestedQuantity <= 0) {
      throw new Error(
        `Invalid requestedQuantity for product ${item.productId}: must be a positive integer`,
      );
    }
  }

  // Deterministic ordering prevents deadlocks between concurrent transactions.
  const orderedItems = [...items].sort((a, b) =>
    a.productId.localeCompare(b.productId),
  );
  const productIds = orderedItems.map((i) => i.productId);

  let pgClient: PoolClient | undefined;
  try {
    pgClient = await pool.connect();
    await pgClient.query("BEGIN");

    // Single batched SELECT … FOR UPDATE acquires all row locks atomically and
    // in a stable order (ORDER BY product_id matches our sorted input).
    const { rows } = await pgClient.query<InventoryRow>(
      `SELECT id, product_id, available_stock
         FROM merchant_inventory
        WHERE product_id = ANY($1::uuid[])
        ORDER BY product_id
        FOR UPDATE`,
      [productIds],
    );

    // Index rows by product_id for O(1) lookup.
    const rowByProductId = new Map<string, InventoryRow>(
      rows.map((r) => [r.product_id, r]),
    );

    // Collect all failures before rolling back — one round-trip is cheaper
    // than an early-exit and provides better UX.
    const failedProductIds: string[] = [];
    for (const item of orderedItems) {
      const row = rowByProductId.get(item.productId);
      if (!row || row.available_stock < item.requestedQuantity) {
        failedProductIds.push(item.productId);
      }
    }

    if (failedProductIds.length > 0) {
      await pgClient.query("ROLLBACK");
      log.info("Inventory allocation failed — insufficient stock", {
        orderId,
        failedProductIds,
      });
      return { success: false, allocatedItems: [], failedProductIds };
    }

    // All items passed the stock check — decrement every row.
    const allocatedItems: AllocatedItem[] = [];
    for (const item of orderedItems) {
      const row = rowByProductId.get(item.productId)!;
      const newStock = row.available_stock - item.requestedQuantity;
      await pgClient.query(
        `UPDATE merchant_inventory
            SET available_stock = $1,
                reserved_stock  = reserved_stock + $2,
                updated_at      = NOW()
          WHERE id = $3
            AND available_stock >= $2`,
        [newStock, item.requestedQuantity, row.id],
      );
      allocatedItems.push({ productId: item.productId, remainingStock: newStock });
    }

    await pgClient.query("COMMIT");
    log.info("Inventory allocated", { orderId, count: allocatedItems.length });

    // Publish events after the transaction commits — out-of-band, best effort.
    const now = new Date().toISOString();
    for (const allocated of allocatedItems) {
      const item = orderedItems.find((i) => i.productId === allocated.productId)!;
      await publishStockDeductionEvent(redis, {
        orderId,
        productId: allocated.productId,
        deductedQuantity: item.requestedQuantity,
        remainingStock: allocated.remainingStock,
        occurredAt: now,
      });
    }

    return { success: true, allocatedItems };
  } catch (err) {
    try {
      await pgClient?.query("ROLLBACK");
    } catch {
      // ROLLBACK failure is non-fatal — the transaction will roll back on
      // connection release anyway.
    }
    throw err;
  } finally {
    pgClient?.release();
  }
}
