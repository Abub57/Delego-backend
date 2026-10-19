import type { BulkCatalogJobStatus, RowError } from "./types.js";

/** Job status stays pollable for a week after the last update. */
const STATUS_TTL_SECONDS = 7 * 24 * 60 * 60;

/** Bound the stored error list so a fully broken 1M-row file can't bloat Redis. */
export const MAX_STORED_ERRORS = 500;

export interface ProgressRedis {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "EX", ttlSeconds: number): Promise<unknown>;
}

export class BulkCatalogProgressStore {
  constructor(private readonly redis: ProgressRedis) {}

  static key(jobId: string): string {
    return `catalog:bulk_import:job:${jobId}`;
  }

  async get(jobId: string): Promise<BulkCatalogJobStatus | null> {
    const raw = await this.redis.get(BulkCatalogProgressStore.key(jobId));
    return raw ? (JSON.parse(raw) as BulkCatalogJobStatus) : null;
  }

  async save(status: BulkCatalogJobStatus): Promise<void> {
    await this.redis.set(
      BulkCatalogProgressStore.key(status.jobId),
      JSON.stringify(status),
      "EX",
      STATUS_TTL_SECONDS,
    );
  }

  static initial(jobId: string, merchantId: string): BulkCatalogJobStatus {
    return {
      jobId,
      merchantId,
      state: "queued",
      progress: { totalRows: 0, processedRows: 0, successCount: 0, errorCount: 0, errors: [] },
      errorsTruncated: false,
      createdAt: new Date().toISOString(),
    };
  }
}

/** Record row errors on a status object, keeping only the first MAX_STORED_ERRORS. */
export function appendRowErrors(status: BulkCatalogJobStatus, errors: RowError[]): void {
  status.progress.errorCount += errors.length;
  for (const error of errors) {
    if (status.progress.errors.length < MAX_STORED_ERRORS) {
      status.progress.errors.push(error);
    } else {
      status.errorsTruncated = true;
    }
  }
}
