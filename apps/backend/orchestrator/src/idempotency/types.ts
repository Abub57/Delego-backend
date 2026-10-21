/**
 * Checkout idempotency record stored in Redis.
 *
 * `in_progress` marks a fingerprint whose first execution is still running;
 * `completed` carries the exact status code and serialized body that every
 * duplicate submission replays.
 */
export interface IdempotencyRecord {
  fingerprint: string;
  status: "in_progress" | "completed";
  statusCode?: number;
  responseBody?: string;
  createdAt: number;
  /**
   * SHA-256 of the canonical request (wallet + items + nonce). Lets an
   * `Idempotency-Key` that is reused with a different payload be rejected
   * instead of silently replaying an unrelated order.
   */
  requestHash?: string;
}
