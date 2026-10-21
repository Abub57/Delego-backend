// Issue #302 — Transaction risk scoring & fraud detection pipeline.

/** Input for scoring one order (shape from #302). */
export interface FraudEvaluationRequest {
  orderId: string;
  userId: string;
  merchantAddress: string;
  amountStroops: string;
  ipAddress: string;
  deviceFingerprint?: string;
}

/** Scoring verdict (shape from #302). */
export interface FraudEvaluationScore {
  riskScore: number; // 0 to 100
  recommendation: "allow" | "challenge" | "block";
  riskFactors: string[];
}

/** What the scorer knows about the merchant being paid. */
export interface MerchantProfile {
  createdAt: Date;
  /** 0 (worst) to 100 (best); merchants start at 100. */
  reputationScore: number;
}

export interface MerchantInfoSource {
  /** Null when the merchant address is not registered. */
  getMerchant(merchantAddress: string): Promise<MerchantProfile | null>;
}

export interface OrderHistorySource {
  /** Orders the user placed in the window `(asOf - windowMs, asOf]`. */
  countOrders(userId: string, windowMs: number, asOf: Date): Promise<number>;
  /** The user's average order amount in stroops, or null with no history. */
  getAverageOrderAmountStroops(userId: string): Promise<bigint | null>;
}

/** Notifies the user that one of their orders was blocked. */
export interface UserAlerter {
  alertBlocked(request: FraudEvaluationRequest, score: FraudEvaluationScore): Promise<void>;
}
