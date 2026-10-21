/**
 * Concurrency stress test for allocateInventoryWithLock.
 *
 * This suite covers the acceptance criteria:
 *   - 20 parallel requests compete for 5 stock units.
 *   - Stock counts never drop below zero.
 *   - Exactly 5 requests succeed and 15 are rejected.
 *   - Rejected requests carry the exact out-of-stock product ID.
 *   - Stock-deduction events are published to the Redis stream for each
 *     successful allocation.
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { Pool, PoolClient } from "pg";
import {
  allocateInventoryWithLock,
  type InventoryDeductionRequest,
  type InventoryDeductionResult,
  type StockEventRedisClient,
} from "./allocateInventory.js";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeInventoryRow {
  id: string;
  product_id: string;
  available_stock: number;
  reserved_stock: number;
}

/**
 * Builds a fake Postgres pool that simulates `FOR UPDATE` row-level locking
 * via a single serialised promise chain.  All concurrent transactions queue
 * through `rowLock` so that they truly see the stock after any preceding
 * transaction commits — exactly what `FOR UPDATE` guarantees at the
 * `READ COMMITTED` isolation level.
 */
function buildFakePool(rows: FakeInventoryRow[]): Pool {
  // Shared mutable state — all fake "connections" operate on this.
  const inventory = rows;

  // rowLock serialises the critical section (BEGIN → COMMIT/ROLLBACK).
  let rowLock: Promise<void> = Promise.resolve();

  const buildClient = (): PoolClient => {
    let releaseRowLock: (() => void) | undefined;
    let inTransaction = false;

    return {
      async query(sql: string, values?: unknown[]) {
        if (sql === "BEGIN") {
          // Chain onto the shared lock so transactions serialise.
          const previousLock = rowLock;
          rowLock = previousLock.then(
            () =>
              new Promise<void>((resolve) => {
                releaseRowLock = resolve;
              }),
          );
          await previousLock;
          inTransaction = true;
          return { rows: [], rowCount: 0 };
        }

        if (sql.includes("FOR UPDATE")) {
          // SELECT … FOR UPDATE: return a snapshot of current stock.
          const productIds = (values?.[0] as string[]) ?? [];
          const matched = inventory
            .filter((r) => productIds.includes(r.product_id))
            .sort((a, b) => a.product_id.localeCompare(b.product_id));
          return { rows: matched.map((r) => ({ ...r })), rowCount: matched.length };
        }

        if (sql.startsWith("UPDATE merchant_inventory")) {
          // Destructure positional params: $1=newStock, $2=qty, $3=id, guard: available_stock >= $2
          const [newStock, qty, id] = values as [number, number, string];
          const row = inventory.find((r) => r.id === id);
          if (row && row.available_stock >= qty) {
            row.available_stock = newStock;
            row.reserved_stock += qty;
          }
          return { rows: [], rowCount: 1 };
        }

        if (sql === "COMMIT" || sql === "ROLLBACK") {
          if (inTransaction) {
            inTransaction = false;
            releaseRowLock?.();
          }
          return { rows: [], rowCount: 0 };
        }

        throw new Error(`Unexpected SQL in fake pool: ${sql}`);
      },
      release() {
        // If the client is released without COMMIT/ROLLBACK (e.g. an
        // exception path that skips the finally block), release the lock
        // anyway so the test doesn't hang.
        if (inTransaction) {
          inTransaction = false;
          releaseRowLock?.();
        }
      },
    } as unknown as PoolClient;
  };

  return {
    async connect() {
      return buildClient();
    },
  } as unknown as Pool;
}

/**
 * Minimal fake Redis client that records every XADD call so we can assert
 * that stock-deduction events were published.
 */
class FakeRedisClient implements StockEventRedisClient {
  readonly xaddCalls: Array<Record<string, string>> = [];

  async xadd(
    _key: string,
    _maxlen: string,
    _approx: string,
    _count: string,
    _id: string,
    ...fields: string[]
  ): Promise<string> {
    const event: Record<string, string> = {};
    for (let i = 0; i < fields.length - 1; i += 2) {
      event[fields[i]] = fields[i + 1];
    }
    this.xaddCalls.push(event);
    return `${Date.now()}-0`;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const PRODUCT_ID = "00000000-0000-0000-0000-000000000001";
const INITIAL_STOCK = 5;
const PARALLEL_REQUESTS = 20;

describe("allocateInventoryWithLock — concurrency stress", () => {
  let inventory: FakeInventoryRow[];
  let pool: Pool;
  let redis: FakeRedisClient;

  beforeEach(() => {
    inventory = [
      {
        id: "inv-1",
        product_id: PRODUCT_ID,
        available_stock: INITIAL_STOCK,
        reserved_stock: 0,
      },
    ];
    pool = buildFakePool(inventory);
    redis = new FakeRedisClient();
  });

  it("allows exactly 5 of 20 parallel requests to succeed when stock is 5", async () => {
    const request = (i: number): InventoryDeductionRequest => ({
      orderId: `order-${i}`,
      items: [{ productId: PRODUCT_ID, requestedQuantity: 1 }],
    });

    const outcomes = await Promise.allSettled(
      Array.from({ length: PARALLEL_REQUESTS }, (_, i) =>
        allocateInventoryWithLock(request(i), pool, redis),
      ),
    );

    // No promise should ever reject — failures come back as
    // `{ success: false }`, not thrown errors.
    const rejected = outcomes.filter((o) => o.status === "rejected");
    expect(rejected, "no promise should reject").toHaveLength(0);

    const results = outcomes
      .filter((o): o is PromiseFulfilledResult<InventoryDeductionResult> =>
        o.status === "fulfilled",
      )
      .map((o) => o.value);

    const succeeded = results.filter((r) => r.success);
    const failed = results.filter((r) => !r.success);

    expect(succeeded).toHaveLength(INITIAL_STOCK);
    expect(failed).toHaveLength(PARALLEL_REQUESTS - INITIAL_STOCK);
  });

  it("stock count never drops below zero", async () => {
    const request = (i: number): InventoryDeductionRequest => ({
      orderId: `order-${i}`,
      items: [{ productId: PRODUCT_ID, requestedQuantity: 1 }],
    });

    await Promise.allSettled(
      Array.from({ length: PARALLEL_REQUESTS }, (_, i) =>
        allocateInventoryWithLock(request(i), pool, redis),
      ),
    );

    expect(inventory[0].available_stock).toBeGreaterThanOrEqual(0);
    expect(inventory[0].available_stock).toBe(0);
    expect(inventory[0].reserved_stock).toBe(INITIAL_STOCK);
  });

  it("rejected allocations carry the exact out-of-stock product ID", async () => {
    const request = (i: number): InventoryDeductionRequest => ({
      orderId: `order-${i}`,
      items: [{ productId: PRODUCT_ID, requestedQuantity: 1 }],
    });

    const outcomes = await Promise.allSettled(
      Array.from({ length: PARALLEL_REQUESTS }, (_, i) =>
        allocateInventoryWithLock(request(i), pool, redis),
      ),
    );

    const failedResults = outcomes
      .filter((o): o is PromiseFulfilledResult<InventoryDeductionResult> =>
        o.status === "fulfilled",
      )
      .map((o) => o.value)
      .filter((r) => !r.success);

    for (const result of failedResults) {
      expect(result.failedProductIds).toBeDefined();
      expect(result.failedProductIds).toContain(PRODUCT_ID);
    }
  });

  it("publishes exactly one stock-deduction event per successful allocation", async () => {
    const request = (i: number): InventoryDeductionRequest => ({
      orderId: `order-${i}`,
      items: [{ productId: PRODUCT_ID, requestedQuantity: 1 }],
    });

    await Promise.allSettled(
      Array.from({ length: PARALLEL_REQUESTS }, (_, i) =>
        allocateInventoryWithLock(request(i), pool, redis),
      ),
    );

    // One XADD per successful deduction.
    expect(redis.xaddCalls).toHaveLength(INITIAL_STOCK);
    for (const event of redis.xaddCalls) {
      expect(event.productId).toBe(PRODUCT_ID);
      expect(Number(event.deductedQuantity)).toBe(1);
      expect(Number(event.remainingStock)).toBeGreaterThanOrEqual(0);
    }
  });

  it("rejects non-positive quantities with a thrown error before touching the DB", async () => {
    const badRequest: InventoryDeductionRequest = {
      orderId: "order-bad",
      items: [{ productId: PRODUCT_ID, requestedQuantity: 0 }],
    };
    await expect(
      allocateInventoryWithLock(badRequest, pool, redis),
    ).rejects.toThrow(/positive integer/);
  });

  it("returns success with empty allocatedItems for an empty items list", async () => {
    const emptyRequest: InventoryDeductionRequest = {
      orderId: "order-empty",
      items: [],
    };
    const result = await allocateInventoryWithLock(
      emptyRequest,
      pool,
      redis,
    );
    expect(result.success).toBe(true);
    expect(result.allocatedItems).toHaveLength(0);
  });

  it("rolls back and marks all items failed when one is short on stock", async () => {
    // Drain the stock to 1, then attempt a 2-item request where one
    // product simply doesn't exist — expect full rollback.
    const MISSING_PRODUCT = "00000000-0000-0000-0000-000000000099";

    const result = await allocateInventoryWithLock(
      {
        orderId: "order-multi",
        items: [
          { productId: PRODUCT_ID, requestedQuantity: 1 },
          { productId: MISSING_PRODUCT, requestedQuantity: 1 },
        ],
      },
      pool,
      redis,
    );

    expect(result.success).toBe(false);
    expect(result.failedProductIds).toContain(MISSING_PRODUCT);
    // The existing product should NOT have been decremented.
    expect(inventory[0].available_stock).toBe(INITIAL_STOCK);
  });
});
