import { describe, it, expect } from "vitest";
import { processRestockJob, RestockDeferredError } from "./worker.js";
import { TokenBucketRateLimiter } from "./rateLimiter.js";
import type { RestockNotifier, RestockNotifyResult } from "./notifier.js";
import type {
  RestockBatchOutcome,
  RestockProduct,
  RestockRepository,
  RestockWaitlistEntry,
} from "./repository.js";

type Status = "pending" | "notified" | "failed";

class InMemoryRestockRepository implements RestockRepository {
  readonly statuses = new Map<string, Status>();

  constructor(
    public product: RestockProduct | null,
    private readonly entries: RestockWaitlistEntry[],
  ) {
    for (const entry of entries) this.statuses.set(entry.id, "pending");
  }

  async getProduct(): Promise<RestockProduct | null> {
    return this.product ? { ...this.product } : null;
  }

  async processPendingBatch(
    _productId: string,
    limit: number,
    handler: (entries: RestockWaitlistEntry[]) => Promise<RestockBatchOutcome>,
  ): Promise<RestockBatchOutcome | null> {
    const pending = this.entries
      .filter((entry) => this.statuses.get(entry.id) === "pending")
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .slice(0, limit);
    if (pending.length === 0) return null;

    const outcome = await handler(pending);
    for (const id of outcome.notifiedIds) this.statuses.set(id, "notified");
    for (const id of outcome.failedIds) this.statuses.set(id, "failed");
    return outcome;
  }
}

class RecordingNotifier implements RestockNotifier {
  readonly calls: string[] = [];

  constructor(
    private readonly results: Record<string, RestockNotifyResult> = {},
    private readonly onNotify?: (entryId: string) => void,
  ) {}

  async notify(entry: RestockWaitlistEntry): Promise<RestockNotifyResult> {
    this.calls.push(entry.id);
    this.onNotify?.(entry.id);
    return this.results[entry.id] ?? "sent";
  }
}

const PRODUCT: RestockProduct = {
  id: "prod-1",
  title: "Trail Runner",
  stockQuantity: 10,
  imageUrl: null,
  merchantName: "Acme",
};

function entry(id: string, minutesAgo: number): RestockWaitlistEntry {
  return {
    id,
    productId: PRODUCT.id,
    email: `${id}@example.com`,
    buyerAddress: null,
    createdAt: new Date(Date.now() - minutesAgo * 60_000),
  };
}

const JOB = {
  productId: PRODUCT.id,
  previousStock: 0,
  currentStock: 10,
  triggeredAt: new Date().toISOString(),
};

describe("processRestockJob", () => {
  it("notifies every pending subscriber in signup order across batches", async () => {
    const repository = new InMemoryRestockRepository(PRODUCT, [
      entry("c", 1),
      entry("a", 30),
      entry("d", 0),
      entry("b", 10),
      entry("e", 0.5),
    ]);
    const notifier = new RecordingNotifier();

    const result = await processRestockJob(JOB, { repository, notifier, batchSize: 2 });

    expect(notifier.calls).toEqual(["a", "b", "c", "e", "d"]);
    expect(result).toEqual({ notified: 5, failed: 0, stoppedReason: "drained" });
    expect([...repository.statuses.values()].every((s) => s === "notified")).toBe(true);
  });

  it("marks permanent failures as failed and keeps going", async () => {
    const repository = new InMemoryRestockRepository(PRODUCT, [entry("a", 2), entry("b", 1)]);
    const notifier = new RecordingNotifier({ a: "permanent_failure" });

    const result = await processRestockJob(JOB, { repository, notifier });

    expect(result).toEqual({ notified: 1, failed: 1, stoppedReason: "drained" });
    expect(repository.statuses.get("a")).toBe("failed");
    expect(repository.statuses.get("b")).toBe("notified");
  });

  it("defers to a BullMQ retry on a transient failure, keeping the rest pending", async () => {
    const repository = new InMemoryRestockRepository(PRODUCT, [
      entry("a", 3),
      entry("b", 2),
      entry("c", 1),
    ]);
    const notifier = new RecordingNotifier({ b: "transient_failure" });

    await expect(processRestockJob(JOB, { repository, notifier })).rejects.toBeInstanceOf(
      RestockDeferredError,
    );
    expect(repository.statuses.get("a")).toBe("notified");
    expect(repository.statuses.get("b")).toBe("pending");
    expect(repository.statuses.get("c")).toBe("pending");
  });

  it("stops between batches when the product sells out again", async () => {
    const repository = new InMemoryRestockRepository(PRODUCT, [
      entry("a", 4),
      entry("b", 3),
      entry("c", 2),
      entry("d", 1),
    ]);
    const notifier = new RecordingNotifier({}, (id) => {
      if (id === "b") repository.product = { ...PRODUCT, stockQuantity: 0 };
    });

    const result = await processRestockJob(JOB, { repository, notifier, batchSize: 2 });

    expect(result).toEqual({ notified: 2, failed: 0, stoppedReason: "out_of_stock" });
    expect(repository.statuses.get("c")).toBe("pending");
    expect(repository.statuses.get("d")).toBe("pending");
  });

  it("does nothing when the product no longer exists", async () => {
    const repository = new InMemoryRestockRepository(null, [entry("a", 1)]);
    const notifier = new RecordingNotifier();

    const result = await processRestockJob(JOB, { repository, notifier });

    expect(result.stoppedReason).toBe("product_missing");
    expect(notifier.calls).toHaveLength(0);
  });
});

describe("TokenBucketRateLimiter", () => {
  it("paces acquisitions to the configured rate after the burst is spent", async () => {
    let clock = 0;
    const sleeps: number[] = [];
    const limiter = new TokenBucketRateLimiter(
      5,
      2,
      () => clock,
      async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
    );

    for (let i = 0; i < 4; i += 1) await limiter.acquire();

    // Burst of 2 is free; the next two each wait one token interval (200ms).
    expect(sleeps).toEqual([200, 200]);
    expect(clock).toBe(400);
  });
});
