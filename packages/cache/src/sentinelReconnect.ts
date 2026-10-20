/**
 * Sentinel reconnect backoff (#563).
 *
 * A Redis master failover drops every socket at once. If each dropped socket
 * schedules its own reconnect, the freshly promoted master receives a
 * thundering herd before it has finished promoting. This module provides:
 *
 * - exponential backoff with configurable jitter and a hard cap, and
 * - a single-flight manager so concurrent failover events share one
 *   reconnect loop per cache client instead of starting one per socket.
 */

export interface SentinelReconnectConfig {
  /** First retry delay; each attempt doubles it. */
  readonly baseMs: number;
  /** Hard ceiling for any single delay. */
  readonly maxMs: number;
  /** 0 = no jitter, 1 = full jitter (delay uniformly in [0, capped]). */
  readonly jitterRatio: number;
  /** Give up after this many attempts. */
  readonly maxAttempts: number;
}

export const DEFAULT_SENTINEL_RECONNECT_CONFIG: SentinelReconnectConfig = {
  baseMs: 100,
  maxMs: 30_000,
  jitterRatio: 1,
  maxAttempts: 10,
};

/**
 * Capped exponential backoff with jitter.
 *
 * `attempt` is zero-based. With `jitterRatio = 1` the delay is uniform in
 * `[0, capped]`; with `0` it is exactly `capped`. The cap is applied before
 * jitter, so the result never exceeds `maxMs`.
 */
export function sentinelReconnectDelay(
  attempt: number,
  config: SentinelReconnectConfig = DEFAULT_SENTINEL_RECONNECT_CONFIG,
  random: () => number = Math.random
): number {
  const exponent = Math.max(0, Math.floor(attempt));
  const capped = Math.min(config.maxMs, config.baseMs * 2 ** exponent);
  const jitterRatio = Math.min(1, Math.max(0, config.jitterRatio));
  if (jitterRatio === 0) return Math.round(capped);
  const jittered = capped * (1 - jitterRatio + jitterRatio * random());
  return Math.max(0, Math.round(Math.min(config.maxMs, jittered)));
}

type Sleep = (ms: number) => Promise<void>;

const defaultSleep: Sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Single-flight reconnect executor.
 *
 * Concurrent `schedule()` calls share the same promise, so N dropped sockets
 * from one failover produce one reconnect loop. A failed attempt is retried
 * with the next backoff step inside that same promise; callers all observe
 * the same outcome.
 */
export class SentinelReconnectManager {
  readonly #config: SentinelReconnectConfig;
  readonly #sleep: Sleep;
  readonly #random: () => number;
  #inFlight: Promise<void> | null = null;
  #attempts = 0;

  constructor(
    config: SentinelReconnectConfig = DEFAULT_SENTINEL_RECONNECT_CONFIG,
    sleep: Sleep = defaultSleep,
    random: () => number = Math.random
  ) {
    this.#config = config;
    this.#sleep = sleep;
    this.#random = random;
  }

  /** Number of attempts made in the current (or last) reconnect run. */
  get attempts(): number {
    return this.#attempts;
  }

  /** True while a reconnect loop is running. */
  get inFlight(): boolean {
    return this.#inFlight !== null;
  }

  /**
   * Run `reconnect`, retrying with jittered exponential backoff until it
   * succeeds or `maxAttempts` is reached. Concurrent calls return the same
   * promise and do not start a second loop.
   */
  schedule(reconnect: () => Promise<void> | void): Promise<void> {
    if (this.#inFlight) return this.#inFlight;

    this.#inFlight = this.#run(reconnect).finally(() => {
      this.#inFlight = null;
    });
    return this.#inFlight;
  }

  /** Reset counters after an operator-forced reconnect or shutdown. */
  reset(): void {
    this.#attempts = 0;
    this.#inFlight = null;
  }

  async #run(reconnect: () => Promise<void> | void): Promise<void> {
    for (;;) {
      const delay = sentinelReconnectDelay(
        this.#attempts,
        this.#config,
        this.#random
      );
      this.#attempts += 1;
      await this.#sleep(delay);

      try {
        await reconnect();
        this.#attempts = 0;
        return;
      } catch (error) {
        if (this.#attempts >= this.#config.maxAttempts) {
          throw error;
        }
      }
    }
  }
}
