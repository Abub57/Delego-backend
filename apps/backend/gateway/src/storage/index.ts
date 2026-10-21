/**
 * Storage utilities for pre-signed URL generation (Issue #112).
 *
 * Provides short-lived pre-signed URLs for uploading product photos
 * and dispute evidence directly to Cloudflare R2 / AWS S3.
 */

export {
  generatePresignedUrl,
  validatePresignedUrlRequest,
  validatePresignedUrlRequestOrThrow,
  checkStorageConfig,
  getS3Client,
  getPublicUrl,
  ALLOWED_CONTENT_TYPES,
  DISPUTE_EVIDENCE_ALLOWED_MIME_TYPES,
  ALLOWED_EXTENSIONS_BY_MIME,
  MAX_FILE_SIZE_BYTES,
  PRESIGNED_URL_EXPIRY_SECONDS,
} from "./presignedUrl.js";
export type {
  PresignedUrlRequest,
  PresignedUrlResponse,
  AllowedContentType,
  DisputeEvidenceAllowedMimeType,
  UploadPurpose,
} from "./presignedUrl.js";

export {
  validateUploadedFile,
  deleteS3Object,
  type ValidateUploadedFileOptions,
} from "./uploadValidator.js";
