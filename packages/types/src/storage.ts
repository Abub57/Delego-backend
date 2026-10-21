/**
 * Storage and Dispute Evidence Upload Types (Issue #357).
 */

export interface UploadPreSignRequest {
  fileName: string;
  contentLength: number;
  expectedMimeType: "image/jpeg" | "image/png" | "application/pdf";
}

export interface PostUploadValidationResult {
  fileKey: string;
  detectedMimeType: string;
  isSafe: boolean;
  deleted?: boolean;
  error?: string;
}
