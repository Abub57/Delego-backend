/**
 * Universal PII masking transform (#355).
 *
 * Customer physical addresses, recipient phone numbers, full credit card /
 * bank identifiers, and Stellar secret keys were being logged in cleartext
 * inside Winston-style structured log entries and OpenTelemetry trace span
 * attributes, violating GDPR/CCPA. This module provides a single,
 * content-pattern-based redaction transform that `createLogger` (logger.ts)
 * and the OTLP span exporter (telemetry/exporter.ts) both apply before a
 * log line or span is emitted/published.
 */

export const PII_PATTERNS = {
  email: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
  phone: /\+?[1-9]\d{1,14}/g,
  creditCard: /\b(?:\d[ -]*?){13,16}\b/g,
  // Stellar secret seeds: "S" followed by 55 base32 chars (56 chars total).
  stellarSecret: /S[A-Z0-9]{55}/g,
} as const;

/**
 * Order matters: more specific / higher-signal patterns run first so that,
 * e.g., a Stellar secret or credit card number isn't partially consumed by
 * the much broader `phone` pattern before it gets a chance to match. Each
 * regex is applied with the global flag, and `String.prototype.replace`
 * resets `lastIndex` to 0 for a global pattern before iterating, so reusing
 * the shared regex objects across calls is safe.
 */
const PATTERN_ORDER: Array<keyof typeof PII_PATTERNS> = [
  "stellarSecret",
  "creditCard",
  "email",
  "phone",
];

export const PII_REDACTION_PLACEHOLDER = "[REDACTED]";

/**
 * Replace any PII tokens (emails, phone numbers, credit card / bank
 * identifiers, Stellar secret keys) found in `content` with a redaction
 * placeholder. Non-string input is returned unchanged.
 */
export function maskPii(content: string): string {
  if (typeof content !== "string" || content.length === 0) {
    return content;
  }

  let masked = content;
  for (const key of PATTERN_ORDER) {
    masked = masked.replace(PII_PATTERNS[key], PII_REDACTION_PLACEHOLDER);
  }
  return masked;
}

/**
 * Recursively walk an arbitrary value (log metadata, span attribute maps,
 * etc.) and run {@link maskPii} over every string it contains. Numbers,
 * booleans, null/undefined pass through untouched; arrays and plain objects
 * are walked depth-first.
 */
export function maskPiiDeep<T>(value: T): T {
  if (typeof value === "string") {
    return maskPii(value) as unknown as T;
  }

  if (Array.isArray(value)) {
    return value.map((item) => maskPiiDeep(item)) as unknown as T;
  }

  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      result[key] = maskPiiDeep(val);
    }
    return result as T;
  }

  return value;
}

/** Returns true if `content` contains any recognizable PII token. */
export function containsPii(content: string): boolean {
  if (typeof content !== "string" || content.length === 0) {
    return false;
  }
  // `.test()` on a shared global-flag regex mutates its `lastIndex`, which
  // would corrupt later calls — reset it explicitly rather than relying on
  // engine-specific reuse behavior.
  return PATTERN_ORDER.some((key) => {
    const pattern = PII_PATTERNS[key];
    pattern.lastIndex = 0;
    return pattern.test(content);
  });
}
