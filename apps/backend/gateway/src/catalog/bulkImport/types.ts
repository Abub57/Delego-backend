export interface BulkCatalogJobData {
  jobId: string;
  merchantId: string;
  csvFileUrl: string;
  batchSize: number;
}

export interface BulkCatalogJobProgress {
  totalRows: number;
  processedRows: number;
  successCount: number;
  errorCount: number;
  errors: Array<{ rowNumber: number; reason: string }>;
}

export type BulkCatalogJobState = "queued" | "processing" | "completed" | "failed";

/** What GET /api/v1/merchant/catalog/jobs/:id returns (stored in Redis). */
export interface BulkCatalogJobStatus {
  jobId: string;
  merchantId: string;
  state: BulkCatalogJobState;
  progress: BulkCatalogJobProgress;
  /** True once more errors occurred than are retained in `progress.errors`. */
  errorsTruncated: boolean;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  failureReason?: string;
}

/** A CSV row that passed type validation and is ready to upsert. */
export interface CatalogProductInput {
  rowNumber: number;
  sku: string;
  title: string;
  description: string | null;
  priceStroops: string;
  assetCode: string;
  stockQuantity: number;
  isListed: boolean;
  imageUrl: string | null;
  metadata: Record<string, unknown>;
}

export interface RowError {
  rowNumber: number;
  reason: string;
}
