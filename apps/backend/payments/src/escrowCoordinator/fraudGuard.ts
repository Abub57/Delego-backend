import { createLogger, tracedFetch } from "@delegolabs/utils";

const log = createLogger("escrow-fraud-guard");

const FRAUD_URL = process.env.FRAUD_DETECTION_URL ?? "http://localhost:3013";

export interface EscrowVelocityCheck {
  paused: boolean;
  escrowsPastHour?: number;
  riskScore?: number;
}

/**
 * Records the escrow creation and returns whether the buyer is paused.
 * Fails open if the fraud service is unreachable, so an outage there
 * can't block all payments.
 */
export async function checkEscrowVelocity(accountAddress: string): Promise<EscrowVelocityCheck> {
  try {
    const res = await tracedFetch(`${FRAUD_URL}/api/v1/fraud/escrow-velocity`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountAddress }),
    });
    if (!res.ok) throw new Error(`fraud service responded ${res.status}`);
    const body = (await res.json()) as { data?: EscrowVelocityCheck };
    return body.data ?? { paused: false };
  } catch (err) {
    log.warn("Escrow velocity check failed, allowing funding", {
      accountAddress,
      error: err instanceof Error ? err.message : String(err),
    });
    return { paused: false };
  }
}