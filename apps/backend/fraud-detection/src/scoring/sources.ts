// Issue #302 — Data sources for transaction risk scoring.

import type {
  FraudEvaluationRequest,
  FraudEvaluationScore,
  MerchantInfoSource,
  MerchantProfile,
  OrderHistorySource,
  UserAlerter,
} from "./types.js";

/** Minimal query interface (satisfied by a `pg` Pool or client). */
export interface SqlQueryable {
  query(text: string, params: unknown[]): Promise<{ rows: unknown[] }>;
}

/** Reads merchant age and reputation from the `merchants` table (040_merchants). */
export class PostgresMerchantInfoSource implements MerchantInfoSource {
  constructor(private readonly db: SqlQueryable) {}

  async getMerchant(merchantAddress: string): Promise<MerchantProfile | null> {
    const result = await this.db.query(
      "SELECT created_at, reputation_score FROM merchants WHERE stellar_address = $1",
      [merchantAddress]
    );
    const row = result.rows[0] as { created_at: Date | string; reputation_score: number } | undefined;
    if (!row) return null;
    return {
      createdAt: new Date(row.created_at),
      reputationScore: Number(row.reputation_score),
    };
  }
}

/** Minimal Redis interface for publishing to a stream (satisfied by ioredis). */
export interface RedisStreamPublisher {
  xadd(key: string, id: string, ...fieldValues: string[]): Promise<string | null>;
}

export const FRAUD_ALERT_STREAM = "fraud:alerts";

export interface FraudBlockedEvent {
  type: "fraud.blocked";
  orderId: string;
  userId: string;
  riskScore: number;
  riskFactors: string[];
  occurredAt: string;
}

/**
 * Alerts the user by publishing a `fraud.blocked` event to the `fraud:alerts`
 * Redis stream, the same way payments publishes to `payments:events`
 * (`XADD <stream> * data <json>`). The notifications service delivers it.
 */
export class RedisStreamUserAlerter implements UserAlerter {
  constructor(
    private readonly redis: RedisStreamPublisher,
    private readonly stream: string = FRAUD_ALERT_STREAM,
    private readonly now: () => Date = () => new Date()
  ) {}

  async alertBlocked(request: FraudEvaluationRequest, score: FraudEvaluationScore): Promise<void> {
    const event: FraudBlockedEvent = {
      type: "fraud.blocked",
      orderId: request.orderId,
      userId: request.userId,
      riskScore: score.riskScore,
      riskFactors: score.riskFactors,
      occurredAt: this.now().toISOString(),
    };
    await this.redis.xadd(this.stream, "*", "data", JSON.stringify(event));
  }
}

export interface RecordedOrder {
  userId: string;
  amountStroops: bigint;
  at: Date;
}

/** Order history kept in memory. Used by tests and for local runs. */
export class InMemoryOrderHistorySource implements OrderHistorySource {
  private readonly orders: RecordedOrder[] = [];

  record(order: RecordedOrder): void {
    this.orders.push(order);
  }

  async countOrders(userId: string, windowMs: number, asOf: Date): Promise<number> {
    const end = asOf.getTime();
    return this.orders.filter(
      (o) => o.userId === userId && o.at.getTime() <= end && o.at.getTime() > end - windowMs
    ).length;
  }

  async getAverageOrderAmountStroops(userId: string): Promise<bigint | null> {
    const mine = this.orders.filter((o) => o.userId === userId);
    if (mine.length === 0) return null;
    const total = mine.reduce((sum, o) => sum + o.amountStroops, 0n);
    return total / BigInt(mine.length);
  }
}

/** Merchant profiles kept in memory. Used by tests and for local runs. */
export class InMemoryMerchantInfoSource implements MerchantInfoSource {
  private readonly merchants = new Map<string, MerchantProfile>();

  set(merchantAddress: string, profile: MerchantProfile): void {
    this.merchants.set(merchantAddress, profile);
  }

  async getMerchant(merchantAddress: string): Promise<MerchantProfile | null> {
    return this.merchants.get(merchantAddress) ?? null;
  }
}
