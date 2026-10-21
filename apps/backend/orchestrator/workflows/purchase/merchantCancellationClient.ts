/**
 * #35 — HTTP client for cancelling a confirmed merchant order during escrow
 * compensation. No merchant microservice exists in this monorepo yet
 * (apps/backend only has gateway, notifications, orchestrator, payments, wallet),
 * so this follows the same adapter + stub-default shape as order-lookup.ts's
 * PaymentsOrderLookupClient: a real HTTP implementation callers can wire once a
 * merchant service exists, and a stub default so compensation logic and its
 * tests never depend on one being reachable.
 */
import type { ApiResponse } from "@delegolabs/types";
import { createLogger, tracedFetch } from "@delegolabs/utils";

const log = createLogger("orchestrator:merchant-cancellation-client", process.env.LOG_LEVEL ?? "info");

const DEFAULT_MERCHANT_URL = "http://localhost:3015";

export function getMerchantServiceUrl(): string {
  return process.env.MERCHANT_SERVICE_URL ?? DEFAULT_MERCHANT_URL;
}

export type MerchantCancellationStatus = "cancelled" | "already_cancelled" | "not_cancellable" | "failed";

export interface MerchantCancellationOutcome {
  merchantOrderId: string;
  status: MerchantCancellationStatus;
  reason?: string;
}

export interface MerchantCancellationClient {
  cancel(merchantOrderId: string, reasonCode: string): Promise<MerchantCancellationOutcome>;
}

/** Stub client — replace with createHttpMerchantCancellationClient() once a merchant service exists. */
export const defaultMerchantCancellationClient: MerchantCancellationClient = {
  async cancel() {
    throw new Error("MerchantCancellationClient not configured");
  },
};

export function createHttpMerchantCancellationClient(
  baseUrl: string = getMerchantServiceUrl()
): MerchantCancellationClient {
  return {
    async cancel(merchantOrderId: string, reasonCode: string): Promise<MerchantCancellationOutcome> {
      const url = `${baseUrl}/api/v1/merchant-orders/${encodeURIComponent(merchantOrderId)}/cancel`;

      let response: Response;
      try {
        response = await tracedFetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ reasonCode }),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to reach merchant service";
        log.error("Merchant cancellation request failed", { url, error: message });
        throw new Error(`Merchant service unavailable: ${message}`);
      }

      const rawBody = await response.text();
      let parsed: ApiResponse<MerchantCancellationOutcome>;
      try {
        parsed = rawBody ? (JSON.parse(rawBody) as ApiResponse<MerchantCancellationOutcome>) : ({} as ApiResponse<MerchantCancellationOutcome>);
      } catch {
        throw new Error(`Merchant service returned invalid response (status ${response.status})`);
      }

      if (!response.ok || parsed.error) {
        const message = parsed.error?.message ?? `Merchant service returned status ${response.status}`;
        throw new Error(message);
      }

      if (!parsed.data) {
        throw new Error("Merchant service returned an empty cancellation result");
      }

      return parsed.data;
    },
  };
}
