import { createHash } from "node:crypto";

export interface CheckoutFingerprintInput {
  /** Buyer wallet address submitting the order. */
  walletAddress: string;
  /** Line items as submitted; normalized so key order / item order don't matter. */
  items: unknown;
  /** Client-generated per-checkout nonce (falls back to the orderId). */
  nonce: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Deterministic JSON: object keys sorted recursively so `{a,b}` and `{b,a}`
 * hash identically.
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Items are a set, not a sequence: sort their canonical forms. */
function canonicalItems(items: unknown): string {
  if (!Array.isArray(items)) return canonicalJson(items ?? []);
  return `[${items.map(canonicalJson).sort().join(",")}]`;
}

/** SHA-256(wallet + items + nonce) — the derived checkout fingerprint. */
export function computeCheckoutFingerprint(input: CheckoutFingerprintInput): string {
  return sha256(`${input.walletAddress}|${canonicalItems(input.items)}|${input.nonce}`);
}

/**
 * Fingerprint for an explicit `Idempotency-Key`. Scoped to the authenticated
 * user so two users choosing the same key can never see each other's replay.
 */
export function computeHeaderKeyFingerprint(userId: string, idempotencyKey: string): string {
  return sha256(`idempotency-key|${userId}|${idempotencyKey}`);
}
