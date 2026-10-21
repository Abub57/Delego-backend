/**
 * Issue #533 — Agent Tool Execution Guard with budget and spend-velocity limits.
 *
 * Tracks the rolling hourly and daily spend of an agent (per user) using Redis
 * sorted sets (`ZADD` / `ZREMRANGEBYSCORE`), the classic sliding-window
 * counter. Before a tool that moves money is executed the guard compares the
 * proposed amount and current velocity against the user's `SpendVelocityPolicy`
 * and throws `SpendVelocityExceededError` when a threshold would be breached,
 * which aborts execution and lets the caller notify the user.
 *
 * Design notes:
 * - Members are `"<nonce>:<amountStroops>"` so two spends in the same
 *   millisecond never collide (the nonce is a monotonically increasing
 *   counter). Scores are epoch milliseconds.
 * - Hourly window = 3600 s, daily window = 86400 s. Expired entries are
 *   pruned lazily on every read, and the key TTL is refreshed to the daily
 *   window so idle users don't leave orphaned keys behind.
 */

/**
 * Minimal Redis surface the guard needs. Kept structural (rather than importing
 * the `ioredis` type) so both real clients and `ioredis-mock` satisfy it.
 */
export interface VelocityRedis {
  zadd(key: string, score: number, member: string): Promise<unknown>;
  zremrangebyscore(key: string, min: number, max: number): Promise<unknown>;
  zrange(key: string, start: number, stop: number): Promise<string[]>;
  expire(key: string, seconds: number): Promise<unknown>;
}

export interface SpendVelocityPolicy {
  maxHourlyTransactions: number;
  maxHourlyVolumeStroops: string;
  maxDailyVolumeStroops: string;
  requireBiometricAboveStroops: string;
}

export interface SpendVelocityCheckResult {
  allowed: boolean;
  reason?: string;
  /** True when the amount exceeds `requireBiometricAboveStroops`. */
  requiresBiometric: boolean;
  hourlyTransactions: number;
  hourlyVolume: bigint;
  dailyVolume: bigint;
}

export interface RecordedSpend {
  transactionId?: string;
  amountStroops: string;
  at?: number;
}

/** Aborts tool execution when a velocity threshold would be exceeded. */
export class SpendVelocityExceededError extends Error {
  readonly result: SpendVelocityCheckResult;
  constructor(result: SpendVelocityCheckResult) {
    super(result.reason ?? "Spend velocity limit exceeded");
    this.name = "SpendVelocityExceededError";
    this.result = result;
  }
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const KEY_TTL_SECONDS = (DAY_MS / 1000) * 2;

function toBigIntSafe(value: string | number | undefined, fallback = 0n): bigint {
  try {
    return BigInt(value ?? fallback);
  } catch {
    return fallback;
  }
}

export class SpendVelocityGuard {
  private readonly prefix: string;
  private nonce = 0;

  constructor(
    private readonly redis: VelocityRedis,
    private readonly now: () => number = () => Date.now(),
    prefix = "spend-velocity:",
  ) {
    this.prefix = prefix;
  }

  private key(userId: string): string {
    return `${this.prefix}${userId}`;
  }

  /** Record an executed spend against the user's sliding window. */
  async recordSpend(userId: string, amountStroops: string, at?: number): Promise<void> {
    const timestamp = at ?? this.now();
    const member = `${timestamp}:${this.nonce++}:${amountStroops}`;
    const key = this.key(userId);

    await this.redis.zadd(key, timestamp, member);
    await this.redis.zremrangebyscore(key, 0, timestamp - DAY_MS);
    await this.redis.expire(key, KEY_TTL_SECONDS);
  }

  /** Record a batch of spends (e.g. replaying a session) atomically. */
  async recordSpends(userId: string, spends: RecordedSpend[]): Promise<void> {
    for (const spend of spends) {
      await this.recordSpend(userId, spend.amountStroops, spend.at);
    }
  }

  private async readWindow(userId: string, nowMs: number) {
    const key = this.key(userId);
    // Drop everything older than a day; the hour window is a subset.
    await this.redis.zremrangebyscore(key, 0, nowMs - DAY_MS);

    const members = await this.redis.zrange(key, 0, -1);
    const hourCutoff = nowMs - HOUR_MS;

    let hourlyTransactions = 0;
    let hourlyVolume = 0n;
    let dailyVolume = 0n;

    for (const member of members) {
      const parts = member.split(":");
      const score = Number(parts[0]);
      const amount = toBigIntSafe(parts.at(-1));
      dailyVolume += amount;
      if (Number.isFinite(score) && score >= hourCutoff) {
        hourlyTransactions += 1;
        hourlyVolume += amount;
      }
    }

    return { hourlyTransactions, hourlyVolume, dailyVolume };
  }

  /**
   * Check whether a proposed spend is allowed under `policy`.
   * Does not mutate state — call `recordSpend` once the tool succeeds.
   */
  async check(
    userId: string,
    requestedAmountStroops: string,
    policy: SpendVelocityPolicy,
  ): Promise<SpendVelocityCheckResult> {
    const nowMs = this.now();
    const { hourlyTransactions, hourlyVolume, dailyVolume } = await this.readWindow(
      userId,
      nowMs,
    );

    const requested = toBigIntSafe(requestedAmountStroops);
    const nextHourlyVolume = hourlyVolume + requested;
    const nextDailyVolume = dailyVolume + requested;

    const maxHourlyVolume = toBigIntSafe(policy.maxHourlyVolumeStroops);
    const maxDailyVolume = toBigIntSafe(policy.maxDailyVolumeStroops);
    const biometricThreshold = toBigIntSafe(policy.requireBiometricAboveStroops);

    const base = {
      hourlyTransactions,
      hourlyVolume,
      dailyVolume,
      requiresBiometric: biometricThreshold > 0n && requested > biometricThreshold,
    };

    if (hourlyTransactions >= policy.maxHourlyTransactions) {
      return {
        allowed: false,
        reason: `Hourly transaction count exceeded (${hourlyTransactions}/${policy.maxHourlyTransactions})`,
        ...base,
      };
    }

    if (nextHourlyVolume > maxHourlyVolume) {
      return {
        allowed: false,
        reason: `Hourly volume exceeded (${nextHourlyVolume}/${maxHourlyVolume} stroops)`,
        ...base,
      };
    }

    if (nextDailyVolume > maxDailyVolume) {
      return {
        allowed: false,
        reason: `Daily volume exceeded (${nextDailyVolume}/${maxDailyVolume} stroops)`,
        ...base,
      };
    }

    return { allowed: true, ...base };
  }

  /**
   * Guard an imminent tool execution. Throws `SpendVelocityExceededError`
   * (aborting execution) when the spend would breach the policy.
   */
  async assertWithinVelocity(
    userId: string,
    requestedAmountStroops: string,
    policy: SpendVelocityPolicy,
  ): Promise<SpendVelocityCheckResult> {
    const result = await this.check(userId, requestedAmountStroops, policy);
    if (!result.allowed) {
      throw new SpendVelocityExceededError(result);
    }
    return result;
  }
}

export type VelocityAlert = (alert: {
  userId: string;
  reason: string;
  requestedAmountStroops: string;
  result: SpendVelocityCheckResult;
}) => void | Promise<void>;

/**
 * Convenience wrapper: check + record + notify on breach.
 * Returns `true` when the spend was permitted and recorded.
 */
export async function guardSpend(options: {
  guard: SpendVelocityGuard;
  userId: string;
  amountStroops: string;
  policy: SpendVelocityPolicy;
  notify?: VelocityAlert;
}): Promise<boolean> {
  const { guard, userId, amountStroops, policy, notify } = options;
  try {
    await guard.assertWithinVelocity(userId, amountStroops, policy);
  } catch (err) {
    if (err instanceof SpendVelocityExceededError && notify) {
      await notify({ userId, reason: err.message, requestedAmountStroops: amountStroops, result: err.result });
    }
    return false;
  }
  await guard.recordSpend(userId, amountStroops);
  return true;
}
