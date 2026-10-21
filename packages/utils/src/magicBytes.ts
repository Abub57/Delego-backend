/**
 * Magic bytes / file binary signature inspection utility (Issue #357).
 *
 * Inspects binary buffers / byte headers to detect true MIME types and
 * identifies malicious payloads masquerading as images (e.g. executables, HTML/SVG XSS).
 */

export interface MagicByteRule {
  mime: string;
  extension: string;
  signature: number[];
  offset?: number;
}

export const ALLOWED_EVIDENCE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "application/pdf",
] as const;

export type AllowedEvidenceMimeType = typeof ALLOWED_EVIDENCE_MIME_TYPES[number];

export const ALLOWED_FILE_EXTENSIONS: Record<AllowedEvidenceMimeType, string[]> = {
  "image/jpeg": ["jpg", "jpeg"],
  "image/png": ["png"],
  "application/pdf": ["pdf"],
};

/**
 * Known binary file signatures (magic numbers).
 */
const MAGIC_SIGNATURES: Array<{ mime: AllowedEvidenceMimeType; bytes: number[]; offset?: number }> = [
  // JPEG: FF D8 FF
  { mime: "image/jpeg", bytes: [0xff, 0xd8, 0xff], offset: 0 },
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  { mime: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], offset: 0 },
  // PDF: %PDF- (25 50 44 46 2D)
  { mime: "application/pdf", bytes: [0x25, 0x50, 0x44, 0x46], offset: 0 },
];

/**
 * Malicious signatures and executable binary headers.
 */
const DANGEROUS_SIGNATURES: Array<{ name: string; bytes: number[]; offset?: number }> = [
  // Windows DOS/PE executable (MZ header)
  { name: "Windows Executable (MZ/PE)", bytes: [0x4d, 0x5a], offset: 0 },
  // Linux ELF executable
  { name: "Linux ELF Executable", bytes: [0x7f, 0x45, 0x4c, 0x46], offset: 0 },
  // Mach-O binary (macOS 32-bit & 64-bit)
  { name: "Mach-O Executable", bytes: [0xfe, 0xed, 0xfa, 0xce], offset: 0 },
  { name: "Mach-O Executable (64-bit)", bytes: [0xfe, 0xed, 0xfa, 0xcf], offset: 0 },
  { name: "Mach-O Executable (reverse)", bytes: [0xce, 0xfa, 0xed, 0xfe], offset: 0 },
  { name: "Mach-O Executable (64-bit reverse)", bytes: [0xcf, 0xfa, 0xed, 0xfe], offset: 0 },
  // Java class file / Mach-O universal binary
  { name: "Java Class File", bytes: [0xca, 0xfe, 0xba, 0xbe], offset: 0 },
  // Shell script shebang (#!)
  { name: "Shell Script", bytes: [0x23, 0x21], offset: 0 },
];

/**
 * Patterns in ASCII/UTF-8 content that indicate HTML/SVG or script payloads disguised as images.
 */
const DANGEROUS_TEXT_PATTERNS = [
  /<html\b/i,
  /<script\b/i,
  /<svg\b/i,
  /<\?xml\b/i,
  /<!doctype\s+html/i,
  /javascript:/i,
  /<iframe\b/i,
  /<embed\b/i,
  /<object\b/i,
  /onload\s*=/i,
  /onerror\s*=/i,
];

/**
 * Detect the MIME type from header bytes using magic byte signatures.
 */
export function detectMimeTypeFromMagicBytes(header: Uint8Array): AllowedEvidenceMimeType | null {
  for (const sig of MAGIC_SIGNATURES) {
    const offset = sig.offset ?? 0;
    if (header.length >= offset + sig.bytes.length) {
      const match = sig.bytes.every((expected, i) => header[offset + i] === expected);
      if (match) {
        return sig.mime;
      }
    }
  }
  return null;
}

/**
 * Checks if the buffer starts with known dangerous executable headers.
 */
export function isExecutableBinary(header: Uint8Array): { isExecutable: boolean; format?: string } {
  for (const sig of DANGEROUS_SIGNATURES) {
    const offset = sig.offset ?? 0;
    if (header.length >= offset + sig.bytes.length) {
      const match = sig.bytes.every((expected, i) => header[offset + i] === expected);
      if (match) {
        return { isExecutable: true, format: sig.name };
      }
    }
  }
  return { isExecutable: false };
}

/**
 * Checks if header bytes contain disguised HTML, SVG, or XSS payloads.
 */
export function containsDisguisedScriptOrHtml(header: Uint8Array): { containsDangerousText: boolean; pattern?: string } {
  // Convert first portion of header to ASCII/UTF-8 string to check for disguised markup
  const sampleLength = Math.min(header.length, 4096);
  const textSample = new TextDecoder("utf-8", { fatal: false }).decode(header.subarray(0, sampleLength));

  for (const pattern of DANGEROUS_TEXT_PATTERNS) {
    if (pattern.test(textSample)) {
      return { containsDangerousText: true, pattern: pattern.source };
    }
  }

  return { containsDangerousText: false };
}

/**
 * Inspect file content bytes and check against the claimed / expected MIME type.
 */
export function validateFileContentMagicBytes(
  header: Uint8Array,
  expectedMimeType: AllowedEvidenceMimeType,
): { isSafe: boolean; detectedMimeType: string; reason?: string } {
  // 1. Check for executable binary headers
  const execCheck = isExecutableBinary(header);
  if (execCheck.isExecutable) {
    return {
      isSafe: false,
      detectedMimeType: "application/x-executable",
      reason: `File starts with executable binary header (${execCheck.format})`,
    };
  }

  // 2. Detect actual MIME type from magic bytes
  const detected = detectMimeTypeFromMagicBytes(header);
  if (!detected) {
    // Check if it's text/html/svg disguised
    const textCheck = containsDisguisedScriptOrHtml(header);
    if (textCheck.containsDangerousText) {
      return {
        isSafe: false,
        detectedMimeType: "text/html",
        reason: "Disguised HTML/SVG or script payload detected",
      };
    }

    return {
      isSafe: false,
      detectedMimeType: "application/octet-stream",
      reason: "Unrecognized or invalid file header signature",
    };
  }

  // 3. For image types, ensure no disguised XSS/HTML polyglot payload
  if (detected === "image/jpeg" || detected === "image/png") {
    const textCheck = containsDisguisedScriptOrHtml(header);
    if (textCheck.containsDangerousText) {
      return {
        isSafe: false,
        detectedMimeType: detected,
        reason: "Polyglot image containing disguised HTML/script payload detected",
      };
    }
  }

  // 4. Verify detected type matches expected MIME type
  if (detected !== expectedMimeType) {
    return {
      isSafe: false,
      detectedMimeType: detected,
      reason: `File content magic bytes match "${detected}", but expected "${expectedMimeType}"`,
    };
  }

  return {
    isSafe: true,
    detectedMimeType: detected,
  };
}

/**
 * Validate that the file extension matches the expected MIME type.
 */
export function validateFileExtension(
  filename: string,
  expectedMimeType: AllowedEvidenceMimeType,
): { valid: boolean; error?: string } {
  const parts = filename.split(".");
  if (parts.length < 2) {
    return { valid: false, error: "File must have a valid extension" };
  }

  const ext = parts.pop()?.toLowerCase() ?? "";
  const allowed = ALLOWED_FILE_EXTENSIONS[expectedMimeType];

  if (!allowed || !allowed.includes(ext)) {
    return {
      valid: false,
      error: `File extension ".${ext}" does not match allowed extensions for ${expectedMimeType}: ${allowed?.map((e) => `.${e}`).join(", ") ?? "none"}`,
    };
  }

  return { valid: true };
}
