import { fetchWithCorrelation } from "../middleware/correlation.js";

/**
 * Circuit Breaker for downstream service calls (Issue #364)
 *
 * Protects the gateway from cascading failures when a downstream service
 * (orchestrator, wallet, payments) is unhealthy. Implements the standard
 * circuit breaker pattern:
 * - CLOSED: normal operation, requests pass through
 * - OPEN: after the failure threshold is reached, requests are rejected
 *   immediately without hitting the downstream service
 * - HALF_OPEN: after the cooldown elapses, a single test request is allowed
 *   through to probe recovery
 */

import { createLogger } from "@delegolabs/utils";

const log = createLogger("gateway:circuit-breaker", process.env.LOG_LEVEL ?? "info");

export type CircuitState = "closed" | "open" | "half_open";

export interface CircuitBreakerConfig {
  /** Number of consecutive failures before opening the circuit. Default: 5. */
  failureThreshold: number;
  /** Time in ms to wait before transitioning from open to half-open. Default: 30000 (30s). */
  cooldownMs: number;
  /** Number of successful calls in half-open state before closing. Default: 2. */
  halfOpenSuccessThreshold: number;
}

export interface CircuitBreakerStats {
  state: CircuitState;
  failureCount: number;
  successCount: number;
  lastFailureAt: Date | null;
  lastSuccessAt: Date | null;
  lastStateChange: Date | null;
  totalRequests: number;
  totalFailures: number;
  totalRejections: number;
}

export class CircuitBreakerOpenError extends Error {
  constructor(service: string, cooldownMs: number) {
    super(`Circuit breaker for "${service}" is open. Retry after ${cooldownMs}ms.`);
    this.name = "CircuitBreakerOpenError";
  }
}

export class CircuitBreaker {
  private state: CircuitState = "closed";
  private failureCount = 0;
  private successCount = 0;
  private lastFailureAt: Date | null = null;
  private lastSuccessAt: Date | null = null;
  private lastStateChange: Date = new Date();
  private totalRequests = 0;
  private totalFailures = 0;
  private totalRejections = 0;
  private readonly config: CircuitBreakerConfig;

  constructor(
    private readonly serviceName: string,
    config?: Partial<CircuitBreakerConfig>
  ) {
    this.config = {
      failureThreshold: config?.failureThreshold ?? 5,
      cooldownMs: config?.cooldownMs ?? 30_000,
      halfOpenSuccessThreshold: config?.halfOpenSuccessThreshold ?? 2,
    };
  }

  getState(): CircuitState {
    if (this.state === "open") {
      const elapsed = Date.now() - this.lastStateChange.getTime();
      if (elapsed >= this.config.cooldownMs) {
        this.transitionTo("half_open");
      }
    }
    return this.state;
  }

  /**
   * Execute a function through the circuit breaker.
   * @throws {CircuitBreakerOpenError} when the circuit is open.
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const currentState = this.getState();
    this.totalRequests++;

    if (currentState === "open") {
      this.totalRejections++;
      throw new CircuitBreakerOpenError(this.serviceName, this.config.cooldownMs);
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  private onSuccess(): void {
    this.successCount++;
    this.lastSuccessAt = new Date();

    if (this.state === "half_open") {
      if (this.successCount >= this.config.halfOpenSuccessThreshold) {
        log.info("Circuit breaker closed - recovery successful", {
          service: this.serviceName,
          successCount: this.successCount,
        });
        this.transitionTo("closed");
      }
    } else if (this.state === "closed") {
      this.failureCount = 0;
    }
  }

  private onFailure(): void {
    this.failureCount++;
    this.totalFailures++;
    this.lastFailureAt = new Date();

    if (this.state === "half_open") {
      log.warn("Circuit breaker re-opened - test request failed", {
        service: this.serviceName,
      });
      this.transitionTo("open");
    } else if (this.state === "closed" && this.failureCount >= this.config.failureThreshold) {
      log.warn("Circuit breaker opened - failure threshold reached", {
        service: this.serviceName,
        failureCount: this.failureCount,
        threshold: this.config.failureThreshold,
      });
      this.transitionTo("open");
    }
  }

  private transitionTo(newState: CircuitState): void {
    const prevState = this.state;
    this.state = newState;
    this.lastStateChange = new Date();

    if (newState === "closed") {
      this.failureCount = 0;
      this.successCount = 0;
    } else if (newState === "half_open") {
      this.successCount = 0;
    }

    log.info("Circuit breaker state transition", {
      service: this.serviceName,
      from: prevState,
      to: newState,
    });
  }

  getStats(): CircuitBreakerStats {
    return {
      state: this.getState(),
      failureCount: this.failureCount,
      successCount: this.successCount,
      lastFailureAt: this.lastFailureAt,
      lastSuccessAt: this.lastSuccessAt,
      lastStateChange: this.lastStateChange,
      totalRequests: this.totalRequests,
      totalFailures: this.totalFailures,
      totalRejections: this.totalRejections,
    };
  }

  /** Manually reset the circuit breaker to closed state. */
  reset(): void {
    this.transitionTo("closed");
  }
}

// ---------------------------------------------------------------------------
// Per-downstream-service registry
// ---------------------------------------------------------------------------

export type DownstreamService = "orchestrator" | "wallet" | "payments";

const breakers = new Map<DownstreamService, CircuitBreaker>();

function envConfigFor(service: DownstreamService): Partial<CircuitBreakerConfig> {
  const prefix = service.toUpperCase();
  return {
    failureThreshold: parseInt(
      process.env[`CIRCUIT_BREAKER_${prefix}_FAILURE_THRESHOLD`] ??
        process.env.CIRCUIT_BREAKER_FAILURE_THRESHOLD ??
        "5",
      10
    ),
    cooldownMs: parseInt(
      process.env[`CIRCUIT_BREAKER_${prefix}_COOLDOWN_MS`] ??
        process.env.CIRCUIT_BREAKER_COOLDOWN_MS ??
        "30000",
      10
    ),
    halfOpenSuccessThreshold: parseInt(
      process.env[`CIRCUIT_BREAKER_${prefix}_HALF_OPEN_SUCCESS`] ??
        process.env.CIRCUIT_BREAKER_HALF_OPEN_SUCCESS ??
        "2",
      10
    ),
  };
}

export function getCircuitBreaker(service: DownstreamService): CircuitBreaker {
  let breaker = breakers.get(service);
  if (!breaker) {
    breaker = new CircuitBreaker(service, envConfigFor(service));
    breakers.set(service, breaker);
  }
  return breaker;
}

export function setCircuitBreaker(service: DownstreamService, breaker: CircuitBreaker): void {
  breakers.set(service, breaker);
}

export function resetAllCircuitBreakers(): void {
  breakers.clear();
}

export function getAllCircuitBreakerStats(): Record<DownstreamService, CircuitBreakerStats> {
  const services: DownstreamService[] = ["orchestrator", "wallet", "payments"];
  const stats = {} as Record<DownstreamService, CircuitBreakerStats>;
  for (const service of services) {
    stats[service] = getCircuitBreaker(service).getStats();
  }
  return stats;
}

// ---------------------------------------------------------------------------
// Bulkhead pattern — resource isolation per downstream service
// ---------------------------------------------------------------------------

export interface BulkheadConfig {
  maxConcurrent: number;
  maxQueued: number;
}

export class BulkheadFullError extends Error {
  constructor(service: string) {
    super(`Bulkhead for "${service}" is full — too many concurrent/queued requests`);
    this.name = "BulkheadFullError";
  }
}

export class Bulkhead {
  private running = 0;
  private queue: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];
  private readonly config: BulkheadConfig;

  constructor(
    private readonly serviceName: string,
    config?: Partial<BulkheadConfig>,
  ) {
    this.config = {
      maxConcurrent: config?.maxConcurrent ?? 10,
      maxQueued: config?.maxQueued ?? 20,
    };
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.running < this.config.maxConcurrent) {
      this.running++;
      return Promise.resolve();
    }

    if (this.queue.length >= this.config.maxQueued) {
      return Promise.reject(new BulkheadFullError(this.serviceName));
    }

    return new Promise<void>((resolve, reject) => {
      this.queue.push({ resolve, reject });
    });
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) {
      next.resolve();
    } else {
      this.running--;
    }
  }

  getStats(): { running: number; queued: number; maxConcurrent: number; maxQueued: number } {
    return {
      running: this.running,
      queued: this.queue.length,
      maxConcurrent: this.config.maxConcurrent,
      maxQueued: this.config.maxQueued,
    };
  }
}

const bulkheads = new Map<DownstreamService, Bulkhead>();

export function getBulkhead(service: DownstreamService): Bulkhead {
  let bulkhead = bulkheads.get(service);
  if (!bulkhead) {
    const prefix = service.toUpperCase();
    bulkhead = new Bulkhead(service, {
      maxConcurrent: parseInt(process.env[`BULKHEAD_${prefix}_MAX_CONCURRENT`] ?? "10", 10),
      maxQueued: parseInt(process.env[`BULKHEAD_${prefix}_MAX_QUEUED`] ?? "20", 10),
    });
    bulkheads.set(service, bulkhead);
  }
  return bulkhead;
}

// ---------------------------------------------------------------------------
// Automatic recovery with health checks
// ---------------------------------------------------------------------------

export interface HealthCheckResult {
  service: DownstreamService;
  healthy: boolean;
  latencyMs: number;
  error?: string;
}

export async function healthCheckService(service: DownstreamService): Promise<HealthCheckResult> {
  const breaker = getCircuitBreaker(service);
  const start = Date.now();

  try {
    await breaker.execute(async () => {
      const url = getServiceHealthUrl(service);
      const res = await fetchWithCorrelation(url, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) throw new Error(`Health check returned ${res.status}`);
    });
    return { service, healthy: true, latencyMs: Date.now() - start };
  } catch (err) {
    return {
      service,
      healthy: false,
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function getServiceHealthUrl(service: DownstreamService): string {
  const urls: Record<DownstreamService, string> = {
    orchestrator: process.env.ORCHESTRATOR_SERVICE_URL ?? "http://localhost:3013",
    wallet: process.env.WALLET_SERVICE_URL ?? "http://localhost:3012",
    payments: process.env.PAYMENTS_SERVICE_URL ?? "http://localhost:3014",
  };
  return `${urls[service]}/health`;
}

export async function healthCheckAll(): Promise<HealthCheckResult[]> {
  const services: DownstreamService[] = ["orchestrator", "wallet", "payments"];
  return Promise.all(services.map(healthCheckService));
}
