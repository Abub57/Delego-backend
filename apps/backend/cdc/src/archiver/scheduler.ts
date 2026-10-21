/**
 * Nightly scheduling for the escrow snapshot archiver (Issue #290).
 *
 * The job runs once a day at a fixed UTC hour (default 03:00) rather than on a
 * rolling interval, so the pruner always lands in the low-traffic window and
 * never drifts across the day. Exactly one timer is armed at any moment; an
 * in-flight run suppresses the next tick (re-arming the following slot) instead
 * of stacking, so a slow night can never produce two concurrent archivers.
 */

import { createLogger, type Logger } from "@delegolabs/utils";

import type { EscrowArchiver } from "./escrowArchiver.js";

const log = createLogger("cdc:archiver:scheduler", process.env.LOG_LEVEL ?? "info");

const DEFAULT_HOUR_UTC = 3;

export interface EscrowArchiveSchedulerOptions {
  /** UTC hour (0-23) to run at. Defaults to `ESCROW_ARCHIVE_HOUR_UTC`, else 03:00. */
  hourUtc?: number;
  /** Run a pass immediately on start, in addition to the nightly slot. */
  runOnStart?: boolean;
  /** Clock seam for tests. */
  now?: () => Date;
  /** Logger seam for tests. */
  logger?: Logger;
}

/**
 * Milliseconds from `now` until the next occurrence of `hourUtc` UTC. Returns
 * exactly 24h when `now` sits precisely on the hour, so a run that starts at
 * 03:00:00.000 schedules the following day instead of re-firing immediately.
 */
export function msUntilNextRun(hourUtc: number, now: Date = new Date()): number {
  if (!Number.isInteger(hourUtc) || hourUtc < 0 || hourUtc > 23) {
    throw new Error(`hourUtc must be an integer in 0..23, got "${hourUtc}"`);
  }

  const next = new Date(now.getTime());
  next.setUTCHours(hourUtc, 0, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next.getTime() - now.getTime();
}

/**
 * Arms the nightly archive/prune job and returns a stop function for graceful
 * shutdown. The first run happens at the next `hourUtc` boundary unless
 * `runOnStart` is set.
 */
export function startEscrowArchiveScheduler(
  archiver: EscrowArchiver,
  options: EscrowArchiveSchedulerOptions = {}
): () => void {
  const schedulerLog = options.logger ?? log;
  const now = options.now ?? ((): Date => new Date());
  const hourUtc = options.hourUtc ?? readHourUtc();

  let stopped = false;
  let inFlight = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  /** Arms the next nightly slot. Always leaves exactly one pending timer. */
  const schedule = (): void => {
    if (stopped) return;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    const delayMs = msUntilNextRun(hourUtc, now());
    timer = setTimeout(tick, delayMs);
    schedulerLog.info("Escrow archive scheduler armed", {
      hourUtc,
      nextRunInMs: delayMs,
    });
  };

  const tick = (): void => {
    timer = null;
    if (stopped) return;

    if (inFlight) {
      schedulerLog.warn("Previous escrow archive run is still in flight; skipping this tick");
      schedule();
      return;
    }

    inFlight = true;
    archiver
      .runOnce(now())
      .then((result) => {
        schedulerLog.info("Scheduled escrow archive run finished", {
          pending: result.pending,
          archived: result.archived,
          batches: result.batches,
          skipped: result.skipped,
          durationMs: result.durationMs,
          errors: result.errors.length,
        });
      })
      .catch((err) => {
        schedulerLog.error("Scheduled escrow archive run threw", {
          error: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        inFlight = false;
        schedule();
      });
  };

  schedule();
  if (options.runOnStart) tick();

  schedulerLog.info("Escrow archive scheduler started", {
    hourUtc,
    runOnStart: !!options.runOnStart,
  });

  return () => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    schedulerLog.info("Escrow archive scheduler stopped");
  };
}

function readHourUtc(): number {
  const raw = process.env.ESCROW_ARCHIVE_HOUR_UTC;
  if (raw === undefined || raw === "") return DEFAULT_HOUR_UTC;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 23) {
    throw new Error(`ESCROW_ARCHIVE_HOUR_UTC must be an integer in 0..23, got "${raw}"`);
  }
  return parsed;
}
