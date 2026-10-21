/**
 * Circuit Breaker for exchange-rate oracle calls (Issue #379)
 *
 * Protects the payments service from hammering an unreachable rate oracle
 * when it is down or degraded. Implements the standard circuit breaker
 * pattern, mirroring the existing per-dependency breakers in this repo
 * (apps/backend/payments/escrow/circuitBreaker.ts, gateway/src/circuitBreaker.ts):
 * - CLOSED: normal operation, oracle calls pass through
 * - OPEN: after the failure threshold is reached, oracle calls are rejected
 *   immediately and callers fall back to last-known-good cached rates
 * - HALF_OPEN: after the recovery timeout, a single test call is allowed
 *   through to probe oracle recovery
 */

import { createLogger } from "@delegolabs/utils";

const log = createLogger(
  "payments:exchange-rate:circuit-breaker",
  process.env.LOG_LEVEL ?? "info"
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CircuitState = "closed" | "open" | "half_open";

export interface CircuitBreakerConfig {
  /** Number of consecutive failures before opening the circuit. Default: 5. */
  failureThreshold: number;
  /** Time in ms to wait before transitioning from open to half-open. Default: 30000 (30s). */
  recoveryTimeoutMs: number;
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

// ---------------------------------------------------------------------------
// Circuit Breaker
// ---------------------------------------------------------------------------

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

  constructor(config?: Partial<CircuitBreakerConfig>) {
    this.config = {
      failureThreshold: config?.failureThreshold ?? 5,
      recoveryTimeoutMs: config?.recoveryTimeoutMs ?? 30_000,
      halfOpenSuccessThreshold: config?.halfOpenSuccessThreshold ?? 2,
    };
  }

  getState(): CircuitState {
    if (this.state === "open") {
      const elapsed = Date.now() - this.lastStateChange.getTime();
      if (elapsed >= this.config.recoveryTimeoutMs) {
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
      throw new CircuitBreakerOpenError(
        `Rate oracle circuit breaker is open. Retry after ${this.config.recoveryTimeoutMs}ms.`
      );
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
          successCount: this.successCount,
        });
        this.transitionTo("closed");
      }
    } else if (this.state === "closed") {
      // Reset the consecutive-failure counter on success
      this.failureCount = 0;
    }
  }

  private onFailure(): void {
    this.failureCount++;
    this.totalFailures++;
    this.lastFailureAt = new Date();

    if (this.state === "half_open") {
      log.warn("Circuit breaker re-opened - test request failed", {
        failureCount: this.failureCount,
      });
      this.transitionTo("open");
    } else if (
      this.state === "closed" &&
      this.failureCount >= this.config.failureThreshold
    ) {
      log.warn("Circuit breaker opened - failure threshold reached", {
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
// Errors
// ---------------------------------------------------------------------------

export class CircuitBreakerOpenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CircuitBreakerOpenError";
  }
}

// ---------------------------------------------------------------------------
// Singleton circuit breaker for rate oracle calls
// ---------------------------------------------------------------------------

let rateOracleCircuitBreaker: CircuitBreaker | null = null;

export function getRateOracleCircuitBreaker(): CircuitBreaker {
  if (!rateOracleCircuitBreaker) {
    rateOracleCircuitBreaker = new CircuitBreaker({
      failureThreshold: parseInt(
        process.env.EXCHANGE_RATE_CIRCUIT_BREAKER_FAILURE_THRESHOLD ?? "5",
        10
      ),
      recoveryTimeoutMs: parseInt(
        process.env.EXCHANGE_RATE_CIRCUIT_BREAKER_RECOVERY_TIMEOUT_MS ?? "30000",
        10
      ),
      halfOpenSuccessThreshold: parseInt(
        process.env.EXCHANGE_RATE_CIRCUIT_BREAKER_HALF_OPEN_SUCCESS ?? "2",
        10
      ),
    });
  }
  return rateOracleCircuitBreaker;
}

export function setRateOracleCircuitBreaker(breaker: CircuitBreaker): void {
  rateOracleCircuitBreaker = breaker;
}

export function resetRateOracleCircuitBreakerForTesting(): void {
  rateOracleCircuitBreaker = null;
}
