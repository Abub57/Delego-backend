/**
 * Bulk catalog import endpoints.
 *
 *   POST /api/v1/merchant/catalog/imports   → 202 { jobId, statusUrl }
 *   GET  /api/v1/merchant/catalog/jobs/:id  → job state + progress (poll)
 */

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Route } from "@delegolabs/utils";
import { route, createLogger } from "@delegolabs/utils";
import { extractAuth } from "../../../middleware/auth.js";
import { readJsonBody, InvalidJsonError, BodyTooLargeError } from "../../request.js";
import { badRequest, forbidden, notFound, unauthorized, sendApiError } from "../../errors.js";
import { Merchant } from "../../models/index.js";
import { BulkCatalogProgressStore } from "./progressStore.js";
import { DEFAULT_BATCH_SIZE, MAX_BATCH_SIZE, MIN_BATCH_SIZE } from "./processor.js";
import { enqueueBulkCatalogImport, getProgressStore } from "./queue.js";
import type { BulkCatalogJobData } from "./types.js";

const log = createLogger("gateway:catalog:bulk-import", process.env.LOG_LEVEL ?? "info");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function ownsMerchant(userId: string, merchantId: string): Promise<boolean> {
  const merchant = await Merchant.findOne({
    where: { id: merchantId, ownerUserId: userId },
    attributes: ["id"],
  });
  return merchant !== null;
}

export async function createBulkCatalogImportHandler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const auth = extractAuth(req);
    if (!auth.userId) {
      unauthorized(res, "Authentication required", req);
      return;
    }

    const body = await readJsonBody(req);
    const merchantId = typeof body.merchantId === "string" ? body.merchantId : "";
    if (!UUID_RE.test(merchantId)) {
      badRequest(res, "merchantId must be a valid UUID", req);
      return;
    }

    let csvFileUrl: string;
    try {
      const url = new URL(String(body.csvFileUrl ?? ""));
      if (url.protocol !== "https:") throw new Error("not https");
      csvFileUrl = url.toString();
    } catch {
      badRequest(res, "csvFileUrl must be a valid https URL", req);
      return;
    }

    const batchSize = body.batchSize === undefined ? DEFAULT_BATCH_SIZE : body.batchSize;
    if (!Number.isInteger(batchSize) || batchSize < MIN_BATCH_SIZE || batchSize > MAX_BATCH_SIZE) {
      badRequest(res, `batchSize must be an integer between ${MIN_BATCH_SIZE} and ${MAX_BATCH_SIZE}`, req);
      return;
    }

    if (!(await ownsMerchant(auth.userId, merchantId))) {
      forbidden(res, "You do not own this merchant store", req);
      return;
    }

    const data: BulkCatalogJobData = { jobId: randomUUID(), merchantId, csvFileUrl, batchSize };

    // Seed the status first so a poll immediately after the 202 never 404s.
    await getProgressStore().save(BulkCatalogProgressStore.initial(data.jobId, merchantId));
    await enqueueBulkCatalogImport(data);

    log.info("Bulk catalog import queued", { jobId: data.jobId, merchantId, userId: auth.userId, batchSize });

    res.writeHead(202, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        data: {
          jobId: data.jobId,
          state: "queued",
          statusUrl: `/api/v1/merchant/catalog/jobs/${data.jobId}`,
        },
        error: null,
      }),
    );
  } catch (err) {
    if (err instanceof InvalidJsonError || err instanceof BodyTooLargeError) {
      badRequest(res, err.message, req);
      return;
    }
    log.error("Failed to queue bulk catalog import", {
      error: err instanceof Error ? err.message : String(err),
    });
    sendApiError(res, 500, "CATALOG_IMPORT_QUEUE_FAILED", "Failed to queue catalog import", req);
  }
}

export async function getBulkCatalogImportJobHandler(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
): Promise<void> {
  try {
    const auth = extractAuth(req);
    if (!auth.userId) {
      unauthorized(res, "Authentication required", req);
      return;
    }

    const jobId = params.id;
    if (!jobId || !UUID_RE.test(jobId)) {
      badRequest(res, "id must be a valid UUID", req);
      return;
    }

    const status = await getProgressStore().get(jobId);
    // Same 404 for "missing" and "someone else's job" so job ids can't be probed.
    if (!status || !(await ownsMerchant(auth.userId, status.merchantId))) {
      notFound(res, "Import job not found", req);
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: status, error: null }));
  } catch (err) {
    log.error("Failed to fetch bulk catalog import job", {
      jobId: params.id,
      error: err instanceof Error ? err.message : String(err),
    });
    sendApiError(res, 500, "CATALOG_IMPORT_STATUS_FAILED", "Failed to fetch import job status", req);
  }
}

export function registerBulkCatalogImportRoutes(): Route[] {
  return [
    route("POST", "/api/v1/merchant/catalog/imports", createBulkCatalogImportHandler),
    route("GET", "/api/v1/merchant/catalog/jobs/:id", getBulkCatalogImportJobHandler),
  ];
}
