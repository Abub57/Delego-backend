/**
 * Downstream service client with circuit breaker + graceful degradation (Issue #364)
 *
 * Wraps `fetch` calls to internal services (orchestrator, wallet, payments)
 * behind a per-service circuit breaker so that an unhealthy dependency fails
 * fast instead of piling up timed-out requests at the gateway.
 */

import { createLogger, tracedFetch } from "@delegolabs/utils";
import { CircuitBreakerOpenError, getCircuitBreaker, type DownstreamService } from "./circuitBreaker.js";
import { fetchWithCorrelation } from "../middleware/correlation.js";

const log = createLogger("gateway:service-client", process.env.LOG_LEVEL ?? "info");

export interface DegradedResponse {
  degraded: true;
  service: DownstreamService;
  message: string;
}

export type ServiceCallResult<T> =
  | { degraded: false; data: T }
  | { degraded: true; data: DegradedResponse };

const SERVICE_URLS: Record<DownstreamService, string> = {
  orchestrator: process.env.ORCHESTRATOR_SERVICE_URL ?? "http://localhost:3013",
  wallet: process.env.WALLET_SERVICE_URL ?? "http://localhost:3012",
  payments: process.env.PAYMENTS_SERVICE_URL ?? "http://localhost:3014",
};

function defaultFallbackMessage(service: DownstreamService): string {
  return `${service} service is temporarily unavailable. Please try again shortly.`;
}

export interface CallDownstreamOptions {
  method?: string;
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

/**
 * Calls a downstream service through its circuit breaker.
 *
 * When the circuit is open, or the request fails/times out, this resolves
 * to a `{ degraded: true, ... }` result instead of throwing — callers should
 * render a graceful fallback response rather than propagating a 5xx.
 */
export async function callDownstreamService<T = unknown>(
  service: DownstreamService,
  options: CallDownstreamOptions
): Promise<ServiceCallResult<T>> {
  const breaker = getCircuitBreaker(service);
  const { method = "GET", path, body, headers, timeoutMs = 5000 } = options;
  const url = `${SERVICE_URLS[service]}${path}`;

  try {
    const data = await breaker.execute(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetchWithCorrelation(url, {
          method,
          headers: { "Content-Type": "application/json", ...headers },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        }, tracedFetch as typeof fetch);
        if (!res.ok) {
          throw new Error(`${service} responded with status ${res.status}`);
        }
        return (await res.json()) as T;
      } finally {
        clearTimeout(timer);
      }
    });

    return { degraded: false, data };
  } catch (err) {
    if (err instanceof CircuitBreakerOpenError) {
      log.warn("Downstream call short-circuited", { service, path });
    } else {
      log.error("Downstream call failed", {
        service,
        path,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return {
      degraded: true,
      data: {
        degraded: true,
        service,
        message: defaultFallbackMessage(service),
      },
    };
  }
}
