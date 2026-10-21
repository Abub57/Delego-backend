/**
 * Post-upload async validation worker for S3 uploads (Issue #357).
 *
 * Inspects magic bytes (e.g. FF D8 FF for JPEG, 89 50 4E 47 for PNG, 25 50 44 46 for PDF),
 * detects disguised executables / HTML / SVG / XSS payloads, and automatically deletes
 * files whose binary headers do not match claimed/expected image or PDF MIME types.
 */

import {
  S3Client,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import {
  createLogger,
  validateFileContentMagicBytes,
  validateFileExtension,
  type AllowedEvidenceMimeType,
} from "@delegolabs/utils";
import type { PostUploadValidationResult } from "@delegolabs/types";
import { getS3Client } from "./presignedUrl.js";

const log = createLogger("gateway:storage:validator", process.env.LOG_LEVEL ?? "info");

const BUCKET_NAME = process.env.STORAGE_BUCKET_NAME || "delego-uploads";

export interface ValidateUploadedFileOptions {
  fileKey: string;
  expectedMimeType: AllowedEvidenceMimeType;
  s3Client?: S3Client;
  bucket?: string;
  autoDeleteOnMismatch?: boolean;
}

/**
 * Validate an uploaded file in S3/R2 by downloading its leading header bytes,
 * verifying magic bytes against expected MIME types, checking for executable/HTML/XSS
 * polyglots, and automatically deleting the file if invalid/unsafe.
 */
export async function validateUploadedFile(
  options: ValidateUploadedFileOptions,
): Promise<PostUploadValidationResult> {
  const {
    fileKey,
    expectedMimeType,
    s3Client = getS3Client(),
    bucket = BUCKET_NAME,
    autoDeleteOnMismatch = true,
  } = options;

  log.info("Starting post-upload validation for file", { fileKey, expectedMimeType });

  // 1. Validate file extension matches expected MIME type
  const filename = fileKey.split("/").pop() || fileKey;
  const extCheck = validateFileExtension(filename, expectedMimeType);
  if (!extCheck.valid) {
    log.warn("File extension validation failed", { fileKey, error: extCheck.error });
    let deleted = false;
    if (autoDeleteOnMismatch) {
      deleted = await deleteS3Object(s3Client, bucket, fileKey);
    }
    return {
      fileKey,
      detectedMimeType: "unknown",
      isSafe: false,
      deleted,
      error: extCheck.error,
    };
  }

  // 2. Read first 4KB chunk (header bytes) from S3/R2
  let headerBytes: Uint8Array;
  try {
    const getCommand = new GetObjectCommand({
      Bucket: bucket,
      Key: fileKey,
      Range: "bytes=0-4095",
    });

    const response = await s3Client.send(getCommand);
    if (!response.Body) {
      throw new Error("Empty body returned from S3 GetObject");
    }

    // Convert stream to Uint8Array
    const chunks: Uint8Array[] = [];
    const stream = response.Body as any;
    for await (const chunk of stream) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    const totalLength = chunks.reduce((acc, c) => acc + c.length, 0);
    const merged = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    headerBytes = merged;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("Failed to read file header from storage", { fileKey, error: msg });
    return {
      fileKey,
      detectedMimeType: "unknown",
      isSafe: false,
      deleted: false,
      error: `Failed to read object from storage: ${msg}`,
    };
  }

  // 3. Inspect magic bytes and check safety
  const validation = validateFileContentMagicBytes(headerBytes, expectedMimeType);

  if (!validation.isSafe) {
    log.warn("Magic bytes validation failed for uploaded file", {
      fileKey,
      expectedMimeType,
      detectedMimeType: validation.detectedMimeType,
      reason: validation.reason,
    });

    let deleted = false;
    if (autoDeleteOnMismatch) {
      deleted = await deleteS3Object(s3Client, bucket, fileKey);
    }

    return {
      fileKey,
      detectedMimeType: validation.detectedMimeType,
      isSafe: false,
      deleted,
      error: validation.reason,
    };
  }

  log.info("Uploaded file passed magic bytes validation", {
    fileKey,
    detectedMimeType: validation.detectedMimeType,
  });

  return {
    fileKey,
    detectedMimeType: validation.detectedMimeType,
    isSafe: true,
    deleted: false,
  };
}

/**
 * Delete an object from S3 storage.
 */
export async function deleteS3Object(
  client: S3Client,
  bucket: string,
  key: string,
): Promise<boolean> {
  try {
    const deleteCommand = new DeleteObjectCommand({
      Bucket: bucket,
      Key: key,
    });
    await client.send(deleteCommand);
    log.info("Successfully deleted invalid/malicious object from storage", { bucket, key });
    return true;
  } catch (err) {
    log.error("Failed to delete object from storage", {
      bucket,
      key,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
