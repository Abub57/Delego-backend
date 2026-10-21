import { describe, expect, it } from "vitest";
import {
  InsufficientStockError,
  InventoryReservationService,
  type InventoryReservationItem,
} from "./reservation.js";

describe("InventoryReservationService", () => {
  it("prevents overselling under concurrent checkout load", async () => {
    let availableStock = 40;
    let reservedStock = 0;
    let rowLock = Promise.resolve();

    const pool = {
      async connect() {
        let releaseRowLock: (() => void) | undefined;
        let transactionLock: Promise<void> | undefined;
        return {
          async query(sql: string, values?: unknown[]) {
            if (sql === "BEGIN") {
              transactionLock = new Promise<void>((resolve) => {
                releaseRowLock = resolve;
              });
              const priorLock = rowLock;
              rowLock = priorLock.then(() => transactionLock);
              await priorLock;
              return { rows: [] };
            }
            if (sql.includes("SELECT id, available_stock")) {
              return { rows: [{ id: "inventory-1", available_stock: availableStock, reserved_stock: reservedStock }] };
            }
            if (sql.startsWith("UPDATE merchant_inventory")) {
              const quantity = Number(values?.[1]);
              availableStock -= quantity;
              reservedStock += quantity;
              return { rows: [] };
            }
            if (sql === "COMMIT" || sql === "ROLLBACK") {
              releaseRowLock?.();
              return { rows: [] };
            }
            throw new Error(`Unexpected query: ${sql}`);
          },
          release() {},
        } as unknown as PoolClient;
      },
    };
    const lock = { async release() {} };
    const redlock = { async acquire() { return lock; } };
    const service = new InventoryReservationService(pool, redlock);
    const item: InventoryReservationItem = {
      merchantId: "merchant-1",
      productId: "product-1",
      quantity: 1,
    };

    const outcomes = await Promise.allSettled(
      Array.from({ length: 100 }, () => service.reserve([item])),
    );

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(40);
    expect(outcomes.filter(
      (outcome) => outcome.status === "rejected" && outcome.reason instanceof InsufficientStockError,
    )).toHaveLength(60);
    expect(availableStock).toBe(0);
    expect(reservedStock).toBe(40);
  });
});