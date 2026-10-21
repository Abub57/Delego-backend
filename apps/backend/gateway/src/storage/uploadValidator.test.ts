import { describe, it, expect, vi } from "vitest";
import { validateUploadedFile, deleteS3Object } from "./uploadValidator.js";
import { S3Client } from "@aws-sdk/client-s3";

describe("uploadValidator", () => {
  const createMockS3Client = (bytes: Uint8Array, deleteSuccess = true) => {
    return {
      send: vi.fn().mockImplementation(async (command) => {
        if (command.constructor.name === "GetObjectCommand" || command.input?.Range) {
          // Mock async iterable stream for Body
          return {
            Body: (async function* () {
              yield Buffer.from(bytes);
            })(),
          };
        }
        if (command.constructor.name === "DeleteObjectCommand" || command.input?.Key) {
          if (!deleteSuccess) {
            throw new Error("S3 delete failed");
          }
          return {};
        }
        return {};
      }),
    } as unknown as S3Client;
  };

  it("validates and accepts valid JPEG upload in S3", async () => {
    const validJpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
    const mockS3 = createMockS3Client(validJpeg);

    const result = await validateUploadedFile({
      fileKey: "dispute_evidence/12345/receipt.jpg",
      expectedMimeType: "image/jpeg",
      s3Client: mockS3,
    });

    expect(result.isSafe).toBe(true);
    expect(result.detectedMimeType).toBe("image/jpeg");
    expect(result.deleted).toBe(false);
  });

  it("validates and accepts valid PDF upload in S3", async () => {
    const validPdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
    const mockS3 = createMockS3Client(validPdf);

    const result = await validateUploadedFile({
      fileKey: "dispute_evidence/12345/evidence.pdf",
      expectedMimeType: "application/pdf",
      s3Client: mockS3,
    });

    expect(result.isSafe).toBe(true);
    expect(result.detectedMimeType).toBe("application/pdf");
    expect(result.deleted).toBe(false);
  });

  it("detects executable masquerading as JPEG and automatically deletes it from S3", async () => {
    // Windows MZ/PE executable header masquerading as .jpg
    const exeBytes = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]);
    const mockS3 = createMockS3Client(exeBytes);

    const result = await validateUploadedFile({
      fileKey: "dispute_evidence/12345/photo.jpg",
      expectedMimeType: "image/jpeg",
      s3Client: mockS3,
      autoDeleteOnMismatch: true,
    });

    expect(result.isSafe).toBe(false);
    expect(result.detectedMimeType).toBe("application/x-executable");
    expect(result.deleted).toBe(true);
    expect(result.error).toContain("executable binary");
  });

  it("detects disguised HTML/SVG XSS payload masquerading as PNG and deletes it", async () => {
    const xssPayload = new TextEncoder().encode("<svg onload=alert(document.cookie)>");
    const mockS3 = createMockS3Client(xssPayload);

    const result = await validateUploadedFile({
      fileKey: "dispute_evidence/12345/damaged.png",
      expectedMimeType: "image/png",
      s3Client: mockS3,
      autoDeleteOnMismatch: true,
    });

    expect(result.isSafe).toBe(false);
    expect(result.deleted).toBe(true);
    expect(result.error).toContain("Disguised HTML/SVG or script payload");
  });

  it("rejects and deletes file with extension mismatch", async () => {
    const validJpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
    const mockS3 = createMockS3Client(validJpeg);

    const result = await validateUploadedFile({
      fileKey: "dispute_evidence/12345/malicious.exe",
      expectedMimeType: "image/jpeg",
      s3Client: mockS3,
      autoDeleteOnMismatch: true,
    });

    expect(result.isSafe).toBe(false);
    expect(result.deleted).toBe(true);
    expect(result.error).toContain("does not match allowed extensions");
  });
});
