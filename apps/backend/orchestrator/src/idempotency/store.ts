import { randomUUID } from "node:crypto";
import type { IdempotencyRecord } from "./types.js";

/** Mutex lease for an in-flight checkout. A crashed handler frees it after this. */
export const DEFAULT_LEASE_TTL_SECONDS = 60;

/** How long a completed response stays replayable. */
export const DEFAULT_RECORD_TTL_SECONDS = 24 * 60 * 60;

/**
 * Compare-and-delete: only the holder of the lease token may release it, so a
 * slow request whose lease already expired can't free a newer holder's lock.
 */
const RELEASE_LEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`;

/** Minimal Redis surface used by the store (subset of ioredis). */
export interface IdempotencyRedis {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: Array<string | number>): Promise<unknown>;
  del(key: string): Promise<unknown>;
  eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>;
}

export interface IdempotencyStoreOptions {
  namespace?: string;
  leaseTtlSeconds?: number;
  recordTtlSeconds?: number;
}

/**
 * Redis-backed idempotency records plus a distributed mutex per fingerprint.
 *
 * Two keys per fingerprint:
 *  - `<ns>:lock:<id>`   — `SET NX EX` lease; holding it is the right to execute.
 *  - `<ns>:record:<id>` — the {@link IdempotencyRecord} duplicates read/replay.
 */
export class IdempotencyStore {
  private readonly namespace: string;
  readonly leaseTtlSeconds: number;
  private readonly recordTtlSeconds: number;

  constructor(
    private readonly redis: IdempotencyRedis,
    options: IdempotencyStoreOptions = {},
  ) {
    this.namespace = options.namespace ?? "idempotency:checkout";
    this.leaseTtlSeconds = options.leaseTtlSeconds ?? DEFAULT_LEASE_TTL_SECONDS;
    this.recordTtlSeconds = options.recordTtlSeconds ?? DEFAULT_RECORD_TTL_SECONDS;
  }

  async getRecord(id: string): Promise<IdempotencyRecord | null> {
    const raw = await this.redis.get(this.recordKey(id));
    return raw ? (JSON.parse(raw) as IdempotencyRecord) : null;
  }

  /** Try to take the mutex. Returns the lease token, or null if another request holds it. */
  async acquireLease(id: string): Promise<string | null> {
    const token = randomUUID();
    const result = await this.redis.set(this.lockKey(id), token, "EX", this.leaseTtlSeconds, "NX");
    return result === "OK" ? token : null;
  }

  async releaseLease(id: string, token: string): Promise<void> {
    await this.redis.eval(RELEASE_LEASE_SCRIPT, 1, this.lockKey(id), token);
  }

  async markInProgress(id: string, fingerprint: string, requestHash: string): Promise<void> {
    const record: IdempotencyRecord = {
      fingerprint,
      status: "in_progress",
      createdAt: Date.now(),
      requestHash,
    };
    // Shares the lease TTL so an orphaned in_progress marker never outlives the lock.
    await this.redis.set(this.recordKey(id), JSON.stringify(record), "EX", this.leaseTtlSeconds);
  }

  async complete(
    id: string,
    fingerprint: string,
    requestHash: string,
    statusCode: number,
    responseBody: string,
  ): Promise<void> {
    const record: IdempotencyRecord = {
      fingerprint,
      status: "completed",
      statusCode,
      responseBody,
      createdAt: Date.now(),
      requestHash,
    };
    await this.redis.set(this.recordKey(id), JSON.stringify(record), "EX", this.recordTtlSeconds);
  }

  /** Drop the record so the next submission re-executes (used for 5xx outcomes). */
  async discard(id: string): Promise<void> {
    await this.redis.del(this.recordKey(id));
  }

  private recordKey(id: string): string {
    return `${this.namespace}:record:${id}`;
  }

  private lockKey(id: string): string {
    return `${this.namespace}:lock:${id}`;
  }
}
