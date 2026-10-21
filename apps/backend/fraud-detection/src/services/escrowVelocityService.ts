import Redis from "ioredis";

export interface FraudVelocityMetric {
  accountAddress: string;
  escrowsPastHour: number;
  riskScore: number;
  isFlagged: boolean;
}

export class EscrowVelocityService {
  private readonly redis: Redis;
  private readonly prefix = "fraud:escrow-velocity:";

  constructor(
    redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379",
    private readonly reviewThreshold = Number(
      process.env.FRAUD_ESCROW_VELOCITY_THRESHOLD ?? "10",
    ),
  ) {
    this.redis = new Redis(redisUrl);
  }

  async recordEscrowCreation(accountAddress: string): Promise<void> {
    const key = this.getKey(accountAddress);
    const now = Date.now();
    const member = `${now}:${crypto.randomUUID()}`;

    await this.redis
      .multi()
      .zadd(key, now, member)
      .zremrangebyscore(key, 0, now - 60 * 60 * 1000)
      .expire(key, 60 * 60 * 2)
      .exec();
  }

  async getVelocity(accountAddress: string): Promise<FraudVelocityMetric> {
    const key = this.getKey(accountAddress);
    const now = Date.now();
    const cutoff = now - 60 * 60 * 1000;

    await this.redis.zremrangebyscore(key, 0, cutoff);

    const escrowsPastHour = await this.redis.zcount(
      key,
      cutoff + 1,
      now,
    );

    const riskScore = Math.min(
      100,
      (escrowsPastHour / this.reviewThreshold) * 100,
    );

    return {
      accountAddress,
      escrowsPastHour,
      riskScore,
      isFlagged: escrowsPastHour >= this.reviewThreshold,
    };
  }

  async isPaused(accountAddress: string): Promise<boolean> {
    return (await this.redis.exists(this.getPauseKey(accountAddress))) === 1;
  }

  /** Returns true only the first time, so one review is opened per pause. */
  async pauseAccount(accountAddress: string): Promise<boolean> {
    const res = await this.redis.set(this.getPauseKey(accountAddress), "1", "NX");
    return res === "OK";
  }

  async clearPause(accountAddress: string): Promise<void> {
    await this.redis.del(this.getPauseKey(accountAddress));
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }

  private getKey(accountAddress: string): string {
    return `${this.prefix}${accountAddress}`;
  }

  private getPauseKey(accountAddress: string): string {
    return `fraud:escrow-paused:${accountAddress}`;
  }
}