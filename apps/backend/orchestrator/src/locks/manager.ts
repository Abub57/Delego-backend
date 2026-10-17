import type { CacheRedisClient } from "@delegolabs/cache";
import {
  redisLockAcquire,
  redisLockInspect,
  redisLockRelease,
  redisLockRenew,
  redisLockScan,
} from "@delegolabs/cache";
import { createLogger, type Logger } from "@delegolabs/utils";
import { lockKeyForStep, lockKeyForWorkflow, lockLevelFromKey } from "./keys.js";
import { LockMetrics } from "./metrics.js";
import type { DistributedLock, HeldLockRecord, LockOptions, LockResult } from "./types.js";

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_WAIT_MS = 30_000;
const DEFAULT_BACKOFF_MS = 20;

export interface DistributedLockManagerOptions {
  client: CacheRedisClient;
  owner: string;
  metrics?: LockMetrics;
  log?: Logger;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class DistributedLockManager {
  private readonly client: CacheRedisClient;
  readonly owner: string;
  readonly metrics: LockMetrics;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly held = new Map<string, HeldLockRecord>();
  private readonly renewers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly stolenKeys = new Set<string>();

  constructor(options: DistributedLockManagerOptions) {
    this.client = options.client;
    this.owner = options.owner;
    this.metrics = options.metrics ?? new LockMetrics();
    this.log = options.log ?? createLogger("orchestrator:locks");
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? sleep;
  }

  wasStolen(key: string): boolean {
    return this.stolenKeys.has(key) || this.held.get(key)?.stolen === true;
  }

  listHeld(): DistributedLock[] {
    return [...this.held.values()].map(({ stolen: _stolen, ttlMs: _ttl, autoRenew: _ar, ...lock }) => lock);
  }

  async acquire(key: string, options: LockOptions): Promise<LockResult> {
    const ttlMs = options.ttlMs > 0 ? options.ttlMs : DEFAULT_TTL_MS;
    const waitTimeoutMs = options.waitTimeoutMs ?? DEFAULT_WAIT_MS;
    const started = this.now();
    const level = lockLevelFromKey(key);
    let attempt = 0;

    while (true) {
      const once = await redisLockAcquire(this.client, key, this.owner, ttlMs, options.metadata ?? {});
      if (once.acquired && once.payload) {
        const lock = this.remember(key, once.payload, ttlMs, options);
        this.startRenew(key, options, ttlMs);
        this.refreshHeldGauges();
        const waitTimeMs = this.now() - started;
        this.metrics.recordAcquire(level, "acquired", waitTimeMs, waitTimeMs > 0);
        return { acquired: true, lock, waitTimeMs };
      }

      const waited = this.now() - started;
      if (waitTimeoutMs <= 0 || waited >= waitTimeoutMs) {
        const timeout = waitTimeoutMs > 0 && waited >= waitTimeoutMs;
        this.metrics.recordAcquire(level, timeout ? "timeout" : "contended", waited, waited > 0);
        return {
          acquired: false,
          lock: once.payload
            ? {
                key,
                owner: once.payload.owner,
                acquiredAt: once.payload.acquiredAt,
                expiresAt: once.payload.expiresAt,
                metadata: once.payload.metadata,
                fence: once.payload.fence,
              }
            : undefined,
          error: timeout ? "DEADLOCK_TIMEOUT" : "LOCK_CONTENDED",
          waitTimeMs: waited,
        };
      }

      attempt += 1;
      const delay = Math.min(DEFAULT_BACKOFF_MS * attempt, 200);
      await this.sleep(delay);
    }
  }

  async acquireHierarchy(
    workflowId: string,
    stepName: string | undefined,
    options: LockOptions,
  ): Promise<LockResult> {
    const workflowKey = lockKeyForWorkflow(workflowId);
    const workflow = await this.acquire(workflowKey, options);
    if (!workflow.acquired) return workflow;
    if (!stepName) return workflow;

    const step = await this.acquire(lockKeyForStep(workflowId, stepName), options);
    if (!step.acquired) {
      await this.release(workflowKey);
      return step;
    }
    return step;
  }

  async release(key: string): Promise<boolean> {
    this.stopRenew(key);
    const ok = await redisLockRelease(this.client, key, this.owner);
    this.held.delete(key);
    this.refreshHeldGauges();
    return ok;
  }

  async releaseAll(): Promise<void> {
    const keys = [...this.held.keys()];
    for (const key of keys) {
      await this.release(key);
    }
  }

  /**
   * Renew a held lock's TTL.
   *
   * Issue #340: during a Redis Sentinel failover, a renewal command can be
   * left hanging on a connection that is mid-reconnect to the newly
   * promoted master. `withRenewTimeout` bounds every renewal attempt so a
   * stuck connection fails fast — exactly like an explicit "stolen" result —
   * instead of leaving the lock (and the renewal interval) stuck
   * indefinitely, which is what caused worker threads to hang rather than
   * release the lock and let the job be reclaimed.
   */
  async renew(key: string): Promise<boolean> {
    const record = this.held.get(key);
    if (!record) return false;
    const level = lockLevelFromKey(key);

    let result: Awaited<ReturnType<typeof redisLockRenew>> | "timeout" | "connection_error";
    try {
      result = await this.withRenewTimeout(
        redisLockRenew(this.client, key, this.owner, record.ttlMs, record.metadata, record.fence),
        record.ttlMs,
      );
    } catch (error) {
      this.log.warn("Lock renew errored — treating as stolen (fail-fast)", {
        key,
        owner: this.owner,
        error: error instanceof Error ? error.message : String(error),
      });
      result = "connection_error";
    }

    if (result === "ok") {
      this.metrics.recordRenew("ok", level);
      record.expiresAt = new Date(this.now() + record.ttlMs).toISOString();
      return true;
    }

    record.stolen = true;
    this.stolenKeys.add(key);
    this.stopRenew(key);
    this.metrics.recordRenew(result === "stolen" ? "stolen" : "error", level);
    this.log.warn("Lock renew failed — treating as stolen", { key, result, owner: this.owner });
    return false;
  }

  /**
   * Race a renewal call against a bounded timeout so a Redis command stuck
   * on a stale connection (e.g. mid Sentinel failover) cannot hang the
   * renewal interval forever. The timeout is capped well below the lock's
   * own TTL so a timed-out renewal still has time to be treated as "stolen"
   * and release ownership before the lock would have expired anyway.
   */
  private withRenewTimeout<T>(promise: Promise<T>, ttlMs: number): Promise<T | "timeout"> {
    const timeoutMs = Math.max(1000, Math.min(5000, Math.floor(ttlMs / 2)));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve("timeout"), timeoutMs);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  async inspect(key: string): Promise<{ lock: DistributedLock | null; pttlMs: number }> {
    const { payload, pttlMs } = await redisLockInspect(this.client, key);
    if (!payload) return { lock: null, pttlMs };
    return {
      pttlMs,
      lock: {
        key,
        owner: payload.owner,
        acquiredAt: payload.acquiredAt,
        expiresAt: payload.expiresAt,
        metadata: payload.metadata,
        fence: payload.fence,
      },
    };
  }

  async scan(prefix: string, limit: number): Promise<string[]> {
    const match = prefix.endsWith("*") ? prefix : `${prefix}*`;
    return redisLockScan(this.client, match, limit);
  }

  async withLock<T>(key: string, options: LockOptions, fn: () => Promise<T>): Promise<T> {
    const result = await this.acquire(key, options);
    if (!result.acquired) {
      throw new Error(result.error ?? "LOCK_CONTENDED");
    }
    try {
      return await fn();
    } finally {
      await this.release(key);
    }
  }

  private remember(
    key: string,
    payload: { owner: string; acquiredAt: string; expiresAt: string; fence: number; metadata: Record<string, unknown> },
    ttlMs: number,
    options: LockOptions,
  ): DistributedLock {
    const lock: HeldLockRecord = {
      key,
      owner: payload.owner,
      acquiredAt: payload.acquiredAt,
      expiresAt: payload.expiresAt,
      metadata: payload.metadata,
      fence: payload.fence,
      stolen: false,
      ttlMs,
      autoRenew: options.autoRenew !== false,
    };
    this.held.set(key, lock);
    this.stolenKeys.delete(key);
    return lock;
  }

  private startRenew(key: string, options: LockOptions, ttlMs: number): void {
    if (options.autoRenew === false) return;
    this.stopRenew(key);
    const interval = options.renewIntervalMs ?? Math.max(50, Math.floor(ttlMs / 3));
    const timer = setInterval(() => {
      void this.renew(key);
    }, interval);
    if (typeof timer.unref === "function") timer.unref();
    this.renewers.set(key, timer);
  }

  private stopRenew(key: string): void {
    const timer = this.renewers.get(key);
    if (timer) {
      clearInterval(timer);
      this.renewers.delete(key);
    }
  }

  private refreshHeldGauges(): void {
    let workflow = 0;
    let step = 0;
    for (const key of this.held.keys()) {
      if (lockLevelFromKey(key) === "step") step += 1;
      else workflow += 1;
    }
    this.metrics.setHeld("workflow", workflow);
    this.metrics.setHeld("step", step);
  }
}
