/**
 * Periodic worker loop for the vacuum/bloat monitor.
 * Issue #382 — Automated Database Vacuum and Bloat Monitoring Worker.
 */
import type { VacuumRunSummary } from "@delegolabs/types";
import type { DatabaseVacuumService } from "../service.js";

export interface VacuumSchedulerOptions {
  /** Tick interval in ms. Default 15 minutes. */
  intervalMs?: number;
  /** Skip the first tick, waiting a full interval first. Default false. */
  skipInitialTick?: boolean;
  onError?: (err: unknown) => void;
  onRun?: (summary: VacuumRunSummary) => void;
}

export const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Runs the service on a timer. `tick()` is exposed so tests can drive the
 * worker deterministically without waiting on a real interval.
 */
export class VacuumScheduler {
  private timer: NodeJS.Timeout | null = null;
  private readonly intervalMs: number;
  private readonly skipInitialTick: boolean;
  private readonly onError?: (err: unknown) => void;
  private readonly onRun?: (summary: VacuumRunSummary) => void;

  constructor(
    private readonly service: DatabaseVacuumService,
    options: VacuumSchedulerOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.skipInitialTick = options.skipInitialTick ?? false;
    this.onError = options.onError;
    this.onRun = options.onRun;
  }

  /** Runs one pass. Overlapping runs are prevented by the service itself. */
  async tick(): Promise<VacuumRunSummary> {
    const summary = await this.service.runOnce();
    this.onRun?.(summary);
    return summary;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((err) => this.onError?.(err));
    }, this.intervalMs);
    // Do not hold the event loop open on shutdown.
    this.timer.unref?.();

    if (!this.skipInitialTick) {
      void this.tick().catch((err) => this.onError?.(err));
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  isRunning(): boolean {
    return this.timer !== null;
  }
}
