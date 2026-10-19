import { randomUUID } from "node:crypto";
import { describe, it, expect, vi, beforeEach } from "vitest";
// @ts-ignore -- ioredis-mock has no first-party types
import MockRedis from "ioredis-mock";
import type { LowStockAlertPayload } from "@delegolabs/types";
import {
  BullMqLowStockAlertPublisher,
  LowStockAlertService,
  lowStockDebounceKey,
  type DebounceRedis,
  type InventoryLevel,
  type LowStockAlertPublisher,
} from "./lowStockAlerts.js";
import { InventoryReservationService } from "./reservation.js";

const NOW = new Date("2026-10-19T12:00:00.000Z");

function level(overrides: Partial<InventoryLevel> = {}): InventoryLevel {
  return {
    merchantId: "merchant-1",
    productId: `product-${randomUUID()}`,
    availableStock: 3,
    lowStockThreshold: 5,
    ...overrides,
  };
}

describe("LowStockAlertService", () => {
  let redis: DebounceRedis & { get(key: string): Promise<string | null> };
  let published: LowStockAlertPayload[];
  let publisher: LowStockAlertPublisher;
  let service: LowStockAlertService;

  beforeEach(() => {
    redis = new MockRedis();
    published = [];
    publisher = { publish: vi.fn(async (payload) => void published.push(payload)) };
    service = new LowStockAlertService(
      redis,
      { getProductDetails: async () => ({ sku: "SKU-1", title: "Trail Runner" }) },
      publisher,
      { debounceSeconds: 3600, now: () => NOW },
    );
  });

  it("publishes a full payload when stock drops to the threshold", async () => {
    const lvl = level({ availableStock: 5, lowStockThreshold: 5 });

    await service.onStockLevelsChanged([lvl]);

    expect(published).toEqual([
      {
        merchantId: "merchant-1",
        productId: lvl.productId,
        sku: "SKU-1",
        title: "Trail Runner",
        currentStock: 5,
        threshold: 5,
        triggeredAt: NOW.toISOString(),
      },
    ]);
  });

  it("ignores rows above the threshold or without one", async () => {
    await service.onStockLevelsChanged([
      level({ availableStock: 6, lowStockThreshold: 5 }),
      level({ availableStock: 0, lowStockThreshold: null }),
    ]);

    expect(published).toHaveLength(0);
  });

  it("debounces repeated decrements on the same item", async () => {
    const productId = `product-${randomUUID()}`;

    await service.onStockLevelsChanged([level({ productId, availableStock: 4 })]);
    await service.onStockLevelsChanged([level({ productId, availableStock: 3 })]);
    await service.onStockLevelsChanged([level({ productId, availableStock: 2 })]);

    expect(published).toHaveLength(1);
    expect(published[0].currentStock).toBe(4);
  });

  it("re-arms the alert once stock recovers above the threshold", async () => {
    const productId = `product-${randomUUID()}`;

    await service.onStockLevelsChanged([level({ productId, availableStock: 2 })]);
    await service.onStockLevelsChanged([level({ productId, availableStock: 20 })]);
    await service.onStockLevelsChanged([level({ productId, availableStock: 1 })]);

    expect(published.map((p) => p.currentStock)).toEqual([2, 1]);
  });

  it("releases the debounce claim when publishing fails so the next decrement retries", async () => {
    const productId = `product-${randomUUID()}`;
    vi.mocked(publisher.publish).mockRejectedValueOnce(new Error("redis down"));

    const first = await service.onStockLevelsChanged([level({ productId, availableStock: 2 })]);
    expect(first).toHaveLength(0);
    expect(await redis.get(lowStockDebounceKey("merchant-1", productId))).toBeNull();

    await service.onStockLevelsChanged([level({ productId, availableStock: 1 })]);
    expect(published).toHaveLength(1);
  });
});

describe("BullMqLowStockAlertPublisher", () => {
  it("enqueues a high-priority webhook job and a transactional email job", async () => {
    const addBulk = vi.fn(async () => []);
    const publisher = new BullMqLowStockAlertPublisher({ addBulk } as never);
    const payload: LowStockAlertPayload = {
      merchantId: "m",
      productId: "p",
      sku: "S",
      title: "T",
      currentStock: 1,
      threshold: 2,
      triggeredAt: NOW.toISOString(),
    };

    await publisher.publish(payload);

    const jobs = (addBulk.mock.calls[0] as unknown[])[0] as Array<{
      name: string;
      data: unknown;
      opts: { priority: number };
    }>;
    expect(jobs.map((j) => j.name)).toEqual(["dispatch-webhook", "send-email"]);
    expect(jobs.every((j) => j.data === payload)).toBe(true);
    expect(jobs[0].opts.priority).toBeLessThan(jobs[1].opts.priority);
  });
});

describe("InventoryReservationService low-stock hook", () => {
  it("reports post-commit stock levels from the decrement", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.startsWith("SELECT")) {
        return { rows: [{ id: "inv-1", available_stock: 6, reserved_stock: 0, low_stock_threshold: 5 }] };
      }
      return { rows: [] };
    });
    const pool = { connect: async () => ({ query, release: vi.fn() }) };
    const redlock = { acquire: async () => ({ release: async () => undefined }) };
    const observer = { onStockLevelsChanged: vi.fn(async () => undefined) };

    const service = new InventoryReservationService(pool as never, redlock, observer);
    await service.reserve([{ merchantId: "m-1", productId: "p-1", quantity: 2 }]);

    expect(observer.onStockLevelsChanged).toHaveBeenCalledWith([
      { merchantId: "m-1", productId: "p-1", availableStock: 4, lowStockThreshold: 5 },
    ]);
  });

  it("does not report levels when the transaction rolls back", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.startsWith("SELECT")) {
        return { rows: [{ id: "inv-1", available_stock: 1, reserved_stock: 0, low_stock_threshold: 5 }] };
      }
      return { rows: [] };
    });
    const pool = { connect: async () => ({ query, release: vi.fn() }) };
    const redlock = { acquire: async () => ({ release: async () => undefined }) };
    const observer = { onStockLevelsChanged: vi.fn(async () => undefined) };

    const service = new InventoryReservationService(pool as never, redlock, observer);
    await expect(
      service.reserve([{ merchantId: "m-1", productId: "p-1", quantity: 2 }]),
    ).rejects.toThrow(/Insufficient stock/);

    expect(observer.onStockLevelsChanged).not.toHaveBeenCalled();
  });
});
