/**
 * #35 — HTTP client for the payments service's order-level escrow compensation API
 * (settleOrder/refundOrder in apps/backend/payments/settlement/index.ts).
 *
 * Mirrors order-lookup.ts's adapter + HTTP client shape: a thin interface the
 * compensation module depends on, with a default HTTP implementation and a
 * default stub so unit tests never need a live payments service.
 */
import type { ApiResponse } from "@delegolabs/types";
import { createLogger, tracedFetch } from "@delegolabs/utils";

const log = createLogger("orchestrator:payments-compensation-client", process.env.LOG_LEVEL ?? "info");

const DEFAULT_PAYMENTS_URL = "http://localhost:3014";

export function getPaymentsCompensationUrl(): string {
  return process.env.PAYMENTS_URL ?? DEFAULT_PAYMENTS_URL;
}

export type SettlementOutcomeStatus = "released" | "refunded" | "failed" | "no_escrow";

export interface SettlementOutcome {
  orderId: string;
  escrowId: string | null;
  status: SettlementOutcomeStatus;
  txHash: string | null;
  alreadySettled: boolean;
  reason?: string;
}

export type RefundReasonCode =
  | "timeout"
  | "buyer_cancelled"
  | "merchant_cancelled"
  | "dispute_buyer"
  | "system_error";

/** Compensation-facing view of the payments service's release/refund operations. */
export interface PaymentsCompensationClient {
  release(orderId: string): Promise<SettlementOutcome>;
  refund(orderId: string, reasonCode: RefundReasonCode): Promise<SettlementOutcome>;
}

/** Stub client — replace with createHttpPaymentsCompensationClient() in production wiring. */
export const defaultPaymentsCompensationClient: PaymentsCompensationClient = {
  async release() {
    throw new Error("PaymentsCompensationClient not configured");
  },
  async refund() {
    throw new Error("PaymentsCompensationClient not configured");
  },
};

async function postJson<T>(url: string, body: unknown): Promise<T> {
  let response: Response;
  try {
    response = await tracedFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to reach payments service";
    log.error("Payments compensation request failed", { url, error: message });
    throw new Error(`Payments service unavailable: ${message}`);
  }

  const rawBody = await response.text();
  let parsed: ApiResponse<T>;
  try {
    parsed = rawBody ? (JSON.parse(rawBody) as ApiResponse<T>) : ({} as ApiResponse<T>);
  } catch {
    throw new Error(`Payments service returned invalid response (status ${response.status})`);
  }

  if (!response.ok || parsed.error) {
    const message = parsed.error?.message ?? `Payments service returned status ${response.status}`;
    throw new Error(message);
  }

  if (!parsed.data) {
    throw new Error("Payments service returned an empty compensation result");
  }

  return parsed.data;
}

/** Default HTTP client for the payments service's order-level compensation endpoints. */
export function createHttpPaymentsCompensationClient(
  baseUrl: string = getPaymentsCompensationUrl()
): PaymentsCompensationClient {
  return {
    async release(orderId: string): Promise<SettlementOutcome> {
      return postJson<SettlementOutcome>(`${baseUrl}/api/v1/orders/${encodeURIComponent(orderId)}/release`, {});
    },
    async refund(orderId: string, reasonCode: RefundReasonCode): Promise<SettlementOutcome> {
      return postJson<SettlementOutcome>(`${baseUrl}/api/v1/orders/${encodeURIComponent(orderId)}/refund`, {
        refundReasonCode: reasonCode,
      });
    },
  };
}
