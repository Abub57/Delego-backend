/**
 * Daily cron that re-verifies merchant domains so revoked SEP-1 listings
 * (or lost domain ownership) demote merchants from `verified_business`.
 *
 * Runs once per UTC day at `hourUtc`. With several wallet replicas, a Redis
 * lock keyed by the date ensures only one of them runs the sweep.
 */

import { createLogger, type Logger } from "@delegolabs/utils";

const log = createLogger("wallet:merchant-domain:cron", process.env.LOG_LEVEL ?? "info");

const DAY_MS = 24 * 60 * 60 * 1000;

export interface DailyLock {
  /** Resolves true if this process won the lock. */
  tryAcquire(key: string, ttlSeconds: number): Promise<boolean>;
}

/** Minimal ioredis surface for the lock. */
export interface RedisSetNx {
  set(key: string, value: string, mode: "EX", seconds: number, flag: "NX"): Promise<string | null>;
}

export function redisDailyLock(redis: RedisSetNx): DailyLock {
  return {
    async tryAcquire(key, ttlSeconds) {
      return (await redis.set(key, String(process.pid), "EX", ttlSeconds, "NX")) === "OK";
    },
  };
}

/** Milliseconds from `now` until the next `hourUtc`:00:00. */
export function msUntilNextRun(now: Date, hourUtc: number): number {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUtc));
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

export interface DomainReverificationCronOptions {
  run: () => Promise<unknown>;
  /** UTC hour of day (0-23). Default 3. */
  hourUtc?: number;
  lock?: DailyLock;
  now?: () => Date;
  logger?: Logger;
}

export interface CronHandle {
  stop(): void;
  /** Runs one sweep now (honouring the lock); exposed for ops and tests. */
  runOnce(): Promise<boolean>;
}

export function startDomainReverificationCron(options: DomainReverificationCronOptions): CronHandle {
  const hourUtc = options.hourUtc ?? 3;
  if (!Number.isInteger(hourUtc) || hourUtc < 0 || hourUtc > 23) {
    throw new Error(`hourUtc must be an integer 0-23, got ${hourUtc}`);
  }
  const now = options.now ?? (() => new Date());
  const logger = options.logger ?? log;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let running = false;

  async function runOnce(): Promise<boolean> {
    if (running) return false;
    const day = now().toISOString().slice(0, 10);
    if (options.lock) {
      // Expire before the next day's run so a crashed holder never blocks it.
      const acquired = await options.lock.tryAcquire(`merchant-domain-reverify:${day}`, 23 * 60 * 60);
      if (!acquired) {
        logger.info("Domain re-verification already claimed by another instance", { day });
        return false;
      }
    }
    running = true;
    try {
      await options.run();
      return true;
    } finally {
      running = false;
    }
  }

  function schedule(): void {
    if (stopped) return;
    const delay = msUntilNextRun(now(), hourUtc);
    timer = setTimeout(() => {
      runOnce()
        .catch((err: unknown) =>
          logger.error("Domain re-verification sweep failed", {
            error: err instanceof Error ? err.message : String(err),
          })
        )
        .finally(schedule);
    }, Math.min(delay, DAY_MS));
    timer.unref?.();
  }

  schedule();
  logger.info("Merchant domain re-verification cron scheduled", { hourUtc });

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    runOnce,
  };
}
