import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  validatePresignedUrlRequest,
  validatePresignedUrlRequestOrThrow,
  MAX_FILE_SIZE_BYTES,
  ALLOWED_CONTENT_TYPES,
} from "./presignedUrl.js";

describe("validatePresignedUrlRequest", () => {
  it("validates a correct request", () => {
    const request = {
      filename: "product.jpg",
      contentType: "image/jpeg",
      fileSizeBytes: 1024 * 1024, // 1MB
      purpose: "product_image",
    };

    const result = validatePresignedUrlRequest(request);
    expect(result.valid).toBe(true);
  });

  it("rejects missing filename", () => {
    const request = {
      filename: "",
      contentType: "image/jpeg",
      fileSizeBytes: 1024,
      purpose: "product_image",
    };

    const result = validatePresignedUrlRequest(request);
    expect(result.valid).toBe(false);
    expect(result.error).toBe("filename is required");
  });

  it("rejects filename with path traversal", () => {
    const request = {
      filename: "../etc/passwd",
      contentType: "image/jpeg",
      fileSizeBytes: 1024,
      purpose: "product_image",
    };

    const result = validatePresignedUrlRequest(request);
    expect(result.valid).toBe(false);
    expect(result.error).toBe("filename cannot contain path separators");
  });

  it("rejects filename with path separator", () => {
    const request = {
      filename: "images/product.jpg",
      contentType: "image/jpeg",
      fileSizeBytes: 1024,
      purpose: "product_image",
    };

    const result = validatePresignedUrlRequest(request);
    expect(result.valid).toBe(false);
    expect(result.error).toBe("filename cannot contain path separators");
  });

  it("rejects invalid content type", () => {
    const request = {
      filename: "product.exe",
      contentType: "application/exe" as any,
      fileSizeBytes: 1024,
      purpose: "product_image",
    };

    const result = validatePresignedUrlRequest(request);
    expect(result.valid).toBe(false);
    expect(result.error).toBe(`Invalid contentType. Must be one of: ${ALLOWED_CONTENT_TYPES.join(", ")}`);
  });

  it("rejects zero file size", () => {
    const request = {
      filename: "product.jpg",
      contentType: "image/jpeg",
      fileSizeBytes: 0,
      purpose: "product_image",
    };

    const result = validatePresignedUrlRequest(request);
    expect(result.valid).toBe(false);
    expect(result.error).toBe("fileSizeBytes must be positive");
  });

  it("rejects negative file size", () => {
    const request = {
      filename: "product.jpg",
      contentType: "image/jpeg",
      fileSizeBytes: -100,
      purpose: "product_image",
    };

    const result = validatePresignedUrlRequest(request);
    expect(result.valid).toBe(false);
    expect(result.error).toBe("fileSizeBytes must be positive");
  });

  it("rejects file size exceeding 10MB", () => {
    const request = {
      filename: "product.jpg",
      contentType: "image/jpeg",
      fileSizeBytes: MAX_FILE_SIZE_BYTES + 1,
      purpose: "product_image",
    };

    const result = validatePresignedUrlRequest(request);
    expect(result.valid).toBe(false);
    expect(result.error).toBe(`fileSizeBytes exceeds maximum of ${MAX_FILE_SIZE_BYTES} bytes (10MB)`);
  });

  it("rejects invalid purpose", () => {
    const request = {
      filename: "product.jpg",
      contentType: "image/jpeg",
      fileSizeBytes: 1024,
      purpose: "invalid_purpose" as any,
    };

    const result = validatePresignedUrlRequest(request);
    expect(result.valid).toBe(false);
    expect(result.error).toBe("purpose must be 'product_image' or 'dispute_evidence'");
  });

  it("accepts dispute_evidence purpose", () => {
    const request = {
      filename: "evidence.pdf",
      contentType: "application/pdf",
      fileSizeBytes: 1024 * 1024,
      purpose: "dispute_evidence",
    };

    const result = validatePresignedUrlRequest(request);
    expect(result.valid).toBe(true);
  });

  it("accepts all allowed content types with matching extensions", () => {
    const cases = [
      { filename: "photo.jpg", contentType: "image/jpeg" },
      { filename: "photo.jpeg", contentType: "image/jpeg" },
      { filename: "icon.png", contentType: "image/png" },
      { filename: "document.pdf", contentType: "application/pdf" },
      { filename: "banner.webp", contentType: "image/webp", purpose: "product_image" as const },
    ];

    for (const item of cases) {
      const request = {
        filename: item.filename,
        contentType: item.contentType as any,
        fileSizeBytes: 1024,
        purpose: item.purpose || "dispute_evidence",
      };

      const result = validatePresignedUrlRequest(request);
      expect(result.valid).toBe(true);
    }
  });

  it("supports UploadPreSignRequest interface (fileName, expectedMimeType, contentLength)", () => {
    const request = {
      fileName: "dispute_proof.pdf",
      expectedMimeType: "application/pdf" as const,
      contentLength: 2048,
    };

    const result = validatePresignedUrlRequest(request);
    expect(result.valid).toBe(true);
  });

  it("rejects file extension mismatching declared MIME type", () => {
    const request = {
      filename: "payload.exe",
      contentType: "image/jpeg" as const,
      fileSizeBytes: 1024,
      purpose: "dispute_evidence" as const,
    };

    const result = validatePresignedUrlRequest(request);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('File extension ".exe" does not match allowed extensions');
  });

  it("rejects HTML/SVG file extensions disguised as evidence", () => {
    const request = {
      filename: "xss.html",
      contentType: "image/png" as const,
      fileSizeBytes: 1024,
      purpose: "dispute_evidence" as const,
    };

    const result = validatePresignedUrlRequest(request);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('File extension ".html" does not match allowed extensions');
  });

  it("rejects webp for dispute evidence uploads (strict allowlist)", () => {
    const request = {
      filename: "photo.webp",
      contentType: "image/webp" as const,
      fileSizeBytes: 1024,
      purpose: "dispute_evidence" as const,
    };

    const result = validatePresignedUrlRequest(request);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Invalid contentType for dispute evidence");
  });
});

describe("validatePresignedUrlRequestOrThrow", () => {
  it("does not throw for valid request", () => {
    const request = {
      filename: "product.jpg",
      contentType: "image/jpeg",
      fileSizeBytes: 1024,
      purpose: "product_image",
    };

    expect(() => validatePresignedUrlRequestOrThrow(request)).not.toThrow();
  });

  it("throws for invalid filename", () => {
    const request = {
      filename: "",
      contentType: "image/jpeg",
      fileSizeBytes: 1024,
      purpose: "product_image",
    };

    expect(() => validatePresignedUrlRequestOrThrow(request)).toThrow("filename is required");
  });
});

describe("MAX_FILE_SIZE_BYTES", () => {
  it("should be 10MB", () => {
    expect(MAX_FILE_SIZE_BYTES).toBe(10 * 1024 * 1024);
  });
});
