/**
 * In-process token bucket used to stay under the email provider's send rate.
 * `acquire()` resolves once a token is available; callers simply await it
 * before each provider call.
 */
export class TokenBucketRateLimiter {
  private tokens: number;
  private lastRefillAt: number;

  constructor(
    private readonly ratePerSecond: number,
    private readonly burst: number = ratePerSecond,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {
    if (!(ratePerSecond > 0)) throw new Error("ratePerSecond must be positive");
    this.tokens = burst;
    this.lastRefillAt = now();
  }

  async acquire(): Promise<void> {
    for (;;) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const waitMs = Math.ceil(((1 - this.tokens) / this.ratePerSecond) * 1000);
      await this.sleep(waitMs);
    }
  }

  private refill(): void {
    const now = this.now();
    const elapsedSeconds = (now - this.lastRefillAt) / 1000;
    this.tokens = Math.min(this.burst, this.tokens + elapsedSeconds * this.ratePerSecond);
    this.lastRefillAt = now;
  }
}
