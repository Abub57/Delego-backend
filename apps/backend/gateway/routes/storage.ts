/**
 * Storage API routes (Issue #112).
 *
 * Generates short-lived pre-signed URLs for uploading product photos
 * and dispute evidence directly to Cloudflare R2 / AWS S3.
 */

import type { Route, RouteHandler } from "@delegolabs/utils";
import { json, createLogger, route } from "@delegolabs/utils";
import { generatePresignedUrl, checkStorageConfig } from "../src/storage/index.js";
import { readJsonBody } from "../src/request.js";
import { guardPermission } from "../middleware/requirePermission.js";
import type { PresignedUrlRequest, PresignedUrlResponse } from "../src/storage/index.js";

const log = createLogger("gateway:storage", process.env.LOG_LEVEL ?? "info");

/**
 * Storage status handler.
 * Returns configuration status for the storage system.
 */
export const storageStatusHandler: RouteHandler = (_req, res) => {
  const config = checkStorageConfig();

  if (!config.configured) {
    json(res, 503, {
      data: null,
      error: {
        code: "STORAGE_NOT_CONFIGURED",
        message: "Storage is not fully configured",
        missing: config.missing,
      },
    });
    return;
  }

  json(res, 200, {
    data: {
      configured: true,
      bucket: process.env.STORAGE_BUCKET_NAME,
      region: process.env.STORAGE_REGION,
      endpoint: process.env.STORAGE_ENDPOINT || null,
    },
    error: null,
  });
};

/**
 * Generate pre-signed URL handler.
 *
 * POST /api/v1/storage/presigned-url
 */
export const generatePresignedUrlHandler: RouteHandler = async (req, res) => {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    json(res, 400, {
      data: null,
      error: { code: "INVALID_JSON", message: "Invalid JSON body" },
    });
    return;
  }

  if (!body || typeof body !== "object") {
    json(res, 400, {
      data: null,
      error: { code: "INVALID_REQUEST", message: "Request body is required" },
    });
    return;
  }

  const request = body as PresignedUrlRequest;

  const filename = request.fileName || request.filename;
  const contentType = request.expectedMimeType || request.contentType;
  const fileSizeBytes = request.contentLength !== undefined ? request.contentLength : request.fileSizeBytes;
  const purpose = request.purpose || "dispute_evidence";

  // Validate required fields
  if (!filename || typeof filename !== "string") {
    json(res, 400, {
      data: null,
      error: { code: "INVALID_REQUEST", message: "filename is required and must be a string" },
    });
    return;
  }

  if (!contentType || typeof contentType !== "string") {
    json(res, 400, {
      data: null,
      error: { code: "INVALID_REQUEST", message: "contentType is required and must be a string" },
    });
    return;
  }

  if (typeof fileSizeBytes !== "number" || fileSizeBytes < 0) {
    json(res, 400, {
      data: null,
      error: { code: "INVALID_REQUEST", message: "fileSizeBytes is required and must be a non-negative number" },
    });
    return;
  }

  if (purpose && typeof purpose !== "string") {
    json(res, 400, {
      data: null,
      error: { code: "INVALID_REQUEST", message: "purpose must be a string" },
    });
    return;
  }

  try {
    const response = await generatePresignedUrl({
      filename,
      contentType,
      fileSizeBytes,
      purpose,
    });
    json(res, 201, {
      data: response,
      error: null,
    });
  } catch (err) {
    log.error("Failed to generate pre-signed URL", {
      error: err instanceof Error ? err.message : String(err),
    });

    if (err instanceof Error) {
      const error = err.message;

      // Handle validation errors
      if (error.includes("fileSizeBytes exceeds maximum")) {
        json(res, 400, {
          data: null,
          error: { code: "FILE_TOO_LARGE", message: error },
        });
        return;
      }

      if (error.includes("Invalid contentType")) {
        json(res, 400, {
          data: null,
          error: { code: "INVALID_CONTENT_TYPE", message: error },
        });
        return;
      }

      if (error.includes("File extension") || error.includes("file extension")) {
        json(res, 400, {
          data: null,
          error: { code: "INVALID_FILE_EXTENSION", message: error },
        });
        return;
      }

      if (error.includes("filename cannot contain path separators")) {
        json(res, 400, {
          data: null,
          error: { code: "INVALID_FILENAME", message: error },
        });
        return;
      }
    }

    json(res, 500, {
      data: null,
      error: { code: "PRESIGNED_URL_FAILED", message: err instanceof Error ? err.message : "Failed to generate pre-signed URL" },
    });
  }
};

/**
 * Validate uploaded file handler.
 *
 * POST /api/v1/storage/validate-upload
 */
export const validateUploadHandler: RouteHandler = async (req, res) => {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    json(res, 400, {
      data: null,
      error: { code: "INVALID_JSON", message: "Invalid JSON body" },
    });
    return;
  }

  if (!body || typeof body !== "object") {
    json(res, 400, {
      data: null,
      error: { code: "INVALID_REQUEST", message: "Request body is required" },
    });
    return;
  }

  const { fileKey, expectedMimeType, autoDeleteOnMismatch } = body as {
    fileKey?: string;
    expectedMimeType?: string;
    autoDeleteOnMismatch?: boolean;
  };

  if (!fileKey || typeof fileKey !== "string") {
    json(res, 400, {
      data: null,
      error: { code: "INVALID_REQUEST", message: "fileKey is required and must be a string" },
    });
    return;
  }

  if (!expectedMimeType || typeof expectedMimeType !== "string") {
    json(res, 400, {
      data: null,
      error: { code: "INVALID_REQUEST", message: "expectedMimeType is required and must be a string" },
    });
    return;
  }

  try {
    const { validateUploadedFile } = await import("../src/storage/index.js");
    const result = await validateUploadedFile({
      fileKey,
      expectedMimeType: expectedMimeType as any,
      autoDeleteOnMismatch: autoDeleteOnMismatch !== false,
    });

    if (!result.isSafe) {
      json(res, 422, {
        data: result,
        error: {
          code: "FILE_VALIDATION_FAILED",
          message: result.error || "File validation failed",
        },
      });
      return;
    }

    json(res, 200, {
      data: result,
      error: null,
    });
  } catch (err) {
    log.error("Error running post-upload validation", {
      fileKey,
      error: err instanceof Error ? err.message : String(err),
    });
    json(res, 500, {
      data: null,
      error: { code: "VALIDATION_ERROR", message: err instanceof Error ? err.message : "Validation error" },
    });
  }
};

/**
 * Register storage routes.
 */
export function registerStorageRoutes(): Route[] {
  return [
    route("GET", "/api/v1/storage/status", storageStatusHandler),
    route("POST", "/api/v1/storage/presigned-url", guardPermission("catalog:write", generatePresignedUrlHandler)),
    route("POST", "/api/v1/storage/validate-upload", validateUploadHandler),
  ];
}
