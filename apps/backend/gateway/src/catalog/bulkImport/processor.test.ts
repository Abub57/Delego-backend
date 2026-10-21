import { Readable } from "node:stream";
import { describe, it, expect, vi } from "vitest";
import {
  BulkImportFatalError,
  clampBatchSize,
  processBulkCatalogImport,
  type BulkImportDeps,
} from "./processor.js";
import { BulkCatalogProgressStore, MAX_STORED_ERRORS, type ProgressRedis } from "./progressStore.js";
import type { CatalogRepository, UpsertBatchResult } from "./repository.js";
import { validateCatalogRow } from "./rowValidation.js";
import type { BulkCatalogJobData, CatalogProductInput } from "./types.js";

const HEADER = "sku,title,description,price_stroops,asset_code,stock_quantity,is_listed,image_url\n";

function memoryRedis(): ProgressRedis & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    async get(key) {
      return data.get(key) ?? null;
    },
    async set(key, value) {
      data.set(key, value);
      return "OK";
    },
  };
}

class RecordingRepository implements CatalogRepository {
  readonly batches: CatalogProductInput[][] = [];
  constructor(private readonly respond?: (batch: CatalogProductInput[]) => Partial<UpsertBatchResult>) {}

  async upsertBatch(_merchantId: string, products: CatalogProductInput[]): Promise<UpsertBatchResult> {
    this.batches.push(products);
    return { successCount: products.length, failed: [], stockTransitions: [], ...this.respond?.(products) };
  }
}

function job(overrides: Partial<BulkCatalogJobData> = {}): BulkCatalogJobData {
  return {
    jobId: "11111111-1111-4111-8111-111111111111",
    merchantId: "22222222-2222-4222-8222-222222222222",
    csvFileUrl: "https://files.example/catalog.csv",
    batchSize: 2,
    ...overrides,
  };
}

function deps(csv: string, overrides: Partial<BulkImportDeps> = {}): BulkImportDeps & {
  repository: RecordingRepository;
  progressStore: BulkCatalogProgressStore;
} {
  return {
    openCsvStream: async () => Readable.from([csv]),
    repository: new RecordingRepository(),
    imageVerifier: { verify: vi.fn(async () => null) },
    progressStore: new BulkCatalogProgressStore(memoryRedis()),
    ...overrides,
  } as BulkImportDeps & { repository: RecordingRepository; progressStore: BulkCatalogProgressStore };
}

describe("processBulkCatalogImport", () => {
  it("streams rows into batches and records completed progress", async () => {
    const csv =
      HEADER +
      "A-1,Alpha,,100,USDC,5,true,\n" +
      "A-2,Beta,,200,USDC,0,false,\n" +
      "A-3,Gamma,,300,,,,\n";
    const d = deps(csv);

    const status = await processBulkCatalogImport(job(), d, { isFinalAttempt: true });

    expect(d.repository.batches.map((b) => b.map((p) => p.sku))).toEqual([["A-1", "A-2"], ["A-3"]]);
    expect(status.state).toBe("completed");
    expect(status.progress).toEqual({
      totalRows: 3,
      processedRows: 3,
      successCount: 3,
      errorCount: 0,
      errors: [],
    });
    expect(await d.progressStore.get(job().jobId)).toEqual(status);
  });

  it("reports invalid rows with their CSV line numbers and keeps going", async () => {
    const csv =
      HEADER +
      "A-1,Alpha,,100,USDC,5,true,\n" +
      ",Missing sku,,100,USDC,1,true,\n" +
      "A-3,Bad price,,-5,USDC,1,true,\n" +
      "A-4,Delta,,400,USDC,1,true,\n";
    const d = deps(csv);

    const status = await processBulkCatalogImport(job(), d, { isFinalAttempt: true });

    expect(status.progress.successCount).toBe(2);
    expect(status.progress.errorCount).toBe(2);
    expect(status.progress.errors.map((e) => e.rowNumber)).toEqual([3, 4]);
    expect(status.progress.errors[0].reason).toMatch(/sku is required/);
    expect(status.progress.errors[1].reason).toMatch(/price_stroops/);
  });

  it("rejects rows whose image URL fails verification", async () => {
    const csv =
      HEADER +
      "A-1,Alpha,,100,USDC,5,true,https://cdn.example/ok.png\n" +
      "A-2,Beta,,200,USDC,5,true,https://cdn.example/broken.png\n";
    const d = deps(csv, {
      imageVerifier: {
        verify: vi.fn(async (url: string) => (url.includes("broken") ? "image_url returned HTTP 404" : null)),
      },
    });

    const status = await processBulkCatalogImport(job(), d, { isFinalAttempt: true });

    expect(d.repository.batches.flat().map((p) => p.sku)).toEqual(["A-1"]);
    expect(status.progress.errors).toEqual([{ rowNumber: 3, reason: "image_url returned HTTP 404" }]);
  });

  it("keeps the last occurrence of a SKU duplicated within a batch", async () => {
    const csv = HEADER + "A-1,First,,100,USDC,1,true,\n" + "A-1,Second,,100,USDC,2,true,\n";
    const d = deps(csv);

    const status = await processBulkCatalogImport(job(), d, { isFinalAttempt: true });

    expect(d.repository.batches[0].map((p) => p.title)).toEqual(["Second"]);
    expect(status.progress.successCount).toBe(1);
    expect(status.progress.errors[0]).toEqual({
      rowNumber: 2,
      reason: 'duplicate sku "A-1"; superseded by row 3',
    });
  });

  it("forwards stock transitions for restock notifications", async () => {
    const onStockTransition = vi.fn(async () => undefined);
    const d = deps(HEADER + "A-1,Alpha,,100,USDC,5,true,\n", {
      repository: new RecordingRepository(() => ({
        stockTransitions: [{ productId: "p-1", previousStock: 0, currentStock: 5 }],
      })),
      onStockTransition,
    });

    await processBulkCatalogImport(job(), d, { isFinalAttempt: true });

    expect(onStockTransition).toHaveBeenCalledWith({ productId: "p-1", previousStock: 0, currentStock: 5 });
  });

  it("caps stored errors while still counting all of them", async () => {
    const badRows = Array.from({ length: MAX_STORED_ERRORS + 10 }, (_, i) => `,No sku ${i},,100,USDC,1,true,\n`);
    const d = deps(HEADER + badRows.join(""));

    const status = await processBulkCatalogImport(job({ batchSize: 100 }), d, { isFinalAttempt: true });

    expect(status.progress.errorCount).toBe(MAX_STORED_ERRORS + 10);
    expect(status.progress.errors).toHaveLength(MAX_STORED_ERRORS);
    expect(status.errorsTruncated).toBe(true);
  });

  it("fails fatally when the row limit is exceeded", async () => {
    const csv = HEADER + "A-1,Alpha,,100,USDC,1,true,\n".repeat(3);
    const d = deps(csv, { maxRows: 2 });

    await expect(processBulkCatalogImport(job(), d, { isFinalAttempt: false })).rejects.toBeInstanceOf(
      BulkImportFatalError,
    );
    const stored = await d.progressStore.get(job().jobId);
    expect(stored?.state).toBe("failed");
  });

  it("leaves the job queued after a retryable failure on a non-final attempt", async () => {
    const d = deps("", {
      openCsvStream: async () => {
        throw new Error("CSV download failed with HTTP 503");
      },
    });

    await expect(processBulkCatalogImport(job(), d, { isFinalAttempt: false })).rejects.toThrow(/503/);
    const stored = await d.progressStore.get(job().jobId);
    expect(stored?.state).toBe("queued");
    expect(stored?.failureReason).toMatch(/retrying/);
  });
});

describe("clampBatchSize", () => {
  it("bounds batch sizes to 1..1000 and defaults invalid input", () => {
    expect(clampBatchSize(0)).toBe(1);
    expect(clampBatchSize(5_000)).toBe(1_000);
    expect(clampBatchSize(1.5)).toBe(500);
    expect(clampBatchSize(undefined)).toBe(500);
  });
});

describe("validateCatalogRow", () => {
  it("accepts camelCase headers and applies defaults", () => {
    const result = validateCatalogRow({ SKU: "X-1", Title: "Thing", priceStroops: "0042" }, 2);

    expect(result).toEqual({
      ok: true,
      product: {
        rowNumber: 2,
        sku: "X-1",
        title: "Thing",
        description: null,
        priceStroops: "42",
        assetCode: "USDC",
        stockQuantity: 0,
        isListed: true,
        imageUrl: null,
        metadata: {},
      },
    });
  });

  it("collects every problem in a row", () => {
    const result = validateCatalogRow(
      { sku: "", title: "", price_stroops: "abc", stock_quantity: "-1", is_listed: "maybe", image_url: "http://x.test/a.png" },
      7,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("sku is required");
      expect(result.reason).toContain("title is required");
      expect(result.reason).toContain("price_stroops must be a positive integer");
      expect(result.reason).toContain("stock_quantity must be a non-negative integer");
      expect(result.reason).toContain("is_listed must be true or false");
      expect(result.reason).toContain("image_url must use https");
    }
  });
});
