/**
 * Interval scheduler for certificate expiry sweeps (Issue #390).
 * Mirrors RenewalScheduler: `tick()` is exposed for deterministic tests,
 * `start()` runs on a timer, `stop()` cancels it.
 */
import type { CertExpiryChecker } from "./checker.js";

export interface ExpirySchedulerOptions {
  intervalMs?: number;
  /** Overrides the clock for deterministic tests. */
  now?: () => Date;
  onError?: (err: unknown) => void;
  /** Run one sweep immediately on start(). Defaults to false. */
  runOnStart?: boolean;
}

export class ExpiryScheduler {
  private timer: NodeJS.Timeout | null = null;
  private readonly intervalMs: number;
  private readonly onError?: (err: unknown) => void;
  private readonly runOnStart: boolean;

  constructor(
    private readonly checker: CertExpiryChecker,
    options: ExpirySchedulerOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? 1000 * 60 * 60 * 12;
    this.onError = options.onError;
    this.runOnStart = options.runOnStart ?? false;
  }

  async tick() {
    return this.checker.checkAllDomains();
  }

  start(): void {
    if (this.timer) return;
    if (this.runOnStart) {
      this.tick().catch((err) => this.onError?.(err));
    }
    this.timer = setInterval(() => {
      this.tick().catch((err) => this.onError?.(err));
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
