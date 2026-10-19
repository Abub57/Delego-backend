/**
 * Streaming bulk catalog import.
 *
 * The CSV is never held in memory: rows are pulled one at a time from a
 * csv-parser stream (async iteration applies backpressure to the download),
 * validated, and accumulated into batches of `batchSize`. Each batch then:
 *   1. drops duplicate SKUs within the batch (the last occurrence wins),
 *   2. verifies image URLs with bounded concurrency,
 *   3. upserts the surviving rows in one transaction,
 * and progress is written to Redis for polling.
 */

import { pipeline, Transform, type Readable } from "node:stream";
import csvParser from "csv-parser";
import { validateCatalogRow } from "./rowValidation.js";
import type { ImageVerifier } from "./imageVerifier.js";
import type { CatalogRepository, StockTransition } from "./repository.js";
import { appendRowErrors, BulkCatalogProgressStore } from "./progressStore.js";
import type { BulkCatalogJobData, BulkCatalogJobStatus, CatalogProductInput, RowError } from "./types.js";

export const MIN_BATCH_SIZE = 1;
export const MAX_BATCH_SIZE = 1_000;
export const DEFAULT_BATCH_SIZE = 500;

/** Failures that retrying cannot fix (bad URL, file too large, 4xx download). */
export class BulkImportFatalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BulkImportFatalError";
  }
}

export interface BulkImportDeps {
  openCsvStream(url: string): Promise<Readable>;
  repository: CatalogRepository;
  imageVerifier: ImageVerifier;
  progressStore: BulkCatalogProgressStore;
  onStockTransition?(transition: StockTransition): Promise<void>;
  maxRows?: number;
  imageVerificationConcurrency?: number;
}

export interface BulkImportRunOptions {
  /** On a non-final attempt a failure leaves the job `queued` for BullMQ to retry. */
  isFinalAttempt: boolean;
  onProgress?(status: BulkCatalogJobStatus): Promise<void> | void;
}

export function clampBatchSize(batchSize: number | undefined): number {
  if (!Number.isInteger(batchSize)) return DEFAULT_BATCH_SIZE;
  return Math.min(MAX_BATCH_SIZE, Math.max(MIN_BATCH_SIZE, batchSize as number));
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Aborts the download once it exceeds `maxBytes`. */
export function byteLimit(maxBytes: number): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      seen += chunk.length;
      if (seen > maxBytes) {
        callback(new BulkImportFatalError(`CSV file exceeds the ${maxBytes}-byte limit`));
        return;
      }
      callback(null, chunk);
    },
  });
}

/** Keep only the last row per SKU; earlier duplicates become row errors. */
function dedupeSkus(batch: CatalogProductInput[]): { unique: CatalogProductInput[]; errors: RowError[] } {
  const lastBySku = new Map<string, CatalogProductInput>();
  for (const product of batch) lastBySku.set(product.sku, product);

  const errors: RowError[] = [];
  for (const product of batch) {
    const winner = lastBySku.get(product.sku)!;
    if (winner !== product) {
      errors.push({
        rowNumber: product.rowNumber,
        reason: `duplicate sku "${product.sku}"; superseded by row ${winner.rowNumber}`,
      });
    }
  }
  return { unique: [...lastBySku.values()], errors };
}

export async function processBulkCatalogImport(
  data: BulkCatalogJobData,
  deps: BulkImportDeps,
  options: BulkImportRunOptions,
): Promise<BulkCatalogJobStatus> {
  const batchSize = clampBatchSize(data.batchSize);
  const imageConcurrency = deps.imageVerificationConcurrency ?? 8;

  const existing = await deps.progressStore.get(data.jobId);
  // Upserts are idempotent, so a retried attempt restarts from the top with fresh counters.
  const status: BulkCatalogJobStatus = {
    ...(existing ?? BulkCatalogProgressStore.initial(data.jobId, data.merchantId)),
    state: "processing",
    progress: { totalRows: 0, processedRows: 0, successCount: 0, errorCount: 0, errors: [] },
    errorsTruncated: false,
    startedAt: new Date().toISOString(),
    finishedAt: undefined,
    failureReason: undefined,
  };
  await deps.progressStore.save(status);

  const publish = async () => {
    await deps.progressStore.save(status);
    await options.onProgress?.(status);
  };

  const flush = async (batch: CatalogProductInput[]) => {
    if (batch.length === 0) return;

    const { unique, errors } = dedupeSkus(batch);

    const imageResults = await mapWithConcurrency(unique, imageConcurrency, async (product) =>
      product.imageUrl ? deps.imageVerifier.verify(product.imageUrl) : null,
    );
    const verified: CatalogProductInput[] = [];
    unique.forEach((product, index) => {
      const imageError = imageResults[index];
      if (imageError) errors.push({ rowNumber: product.rowNumber, reason: imageError });
      else verified.push(product);
    });

    const result = await deps.repository.upsertBatch(data.merchantId, verified);
    errors.push(...result.failed);
    errors.sort((a, b) => a.rowNumber - b.rowNumber);

    status.progress.successCount += result.successCount;
    status.progress.processedRows += batch.length;
    appendRowErrors(status, errors);

    for (const transition of result.stockTransitions) {
      await deps.onStockTransition?.(transition);
    }
    await publish();
  };

  try {
    const source = await deps.openCsvStream(data.csvFileUrl);
    const rows = csvParser({ mapHeaders: ({ header }) => header.trim() });
    pipeline(source, rows, (err) => {
      if (err) rows.destroy(err);
    });

    let batch: CatalogProductInput[] = [];
    let rowNumber = 1; // header row

    for await (const raw of rows as AsyncIterable<Record<string, string>>) {
      rowNumber += 1;
      status.progress.totalRows += 1;
      if (deps.maxRows && status.progress.totalRows > deps.maxRows) {
        throw new BulkImportFatalError(`CSV exceeds the ${deps.maxRows}-row limit`);
      }

      const validation = validateCatalogRow(raw, rowNumber);
      if (!validation.ok) {
        status.progress.processedRows += 1;
        appendRowErrors(status, [{ rowNumber, reason: validation.reason }]);
        continue;
      }

      batch.push(validation.product);
      if (batch.length >= batchSize) {
        const full = batch;
        batch = [];
        await flush(full);
      }
    }
    await flush(batch);

    status.state = "completed";
    status.finishedAt = new Date().toISOString();
    await publish();
    return status;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const terminal = options.isFinalAttempt || err instanceof BulkImportFatalError;
    status.state = terminal ? "failed" : "queued";
    status.failureReason = terminal ? message : `Attempt failed, retrying: ${message}`;
    if (terminal) status.finishedAt = new Date().toISOString();
    await deps.progressStore.save(status).catch(() => undefined);
    throw err;
  }
}
