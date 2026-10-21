/**
 * Circuit Breaker for DLQ replay
 * Prevents retry storms when target service is down
 * Issue #310
 */

import type { CircuitBreakerConfig, CircuitBreakerState } from './types.js';

export class CircuitBreaker {
  private state: CircuitBreakerState = {
    state: 'CLOSED',
    failures: 0,
    successes: 0,
    lastFailureTime: null,
    nextAttemptTime: null,
  };

  constructor(
    private config: CircuitBreakerConfig = {
      failureThreshold: 5,
      successThreshold: 2,
      timeout: 60000, // 1 minute
    }
  ) {}

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state.state === 'OPEN') {
      const now = Date.now();
      if (this.state.nextAttemptTime && now < this.state.nextAttemptTime) {
        throw new Error(
          `Circuit breaker is OPEN. Next attempt at ${new Date(this.state.nextAttemptTime).toISOString()}`
        );
      }
      // Transition to HALF_OPEN to try again
      this.state.state = 'HALF_OPEN';
      this.state.successes = 0;
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess(): void {
    this.state.failures = 0;

    if (this.state.state === 'HALF_OPEN') {
      this.state.successes++;
      if (this.state.successes >= this.config.successThreshold) {
        this.state.state = 'CLOSED';
        this.state.successes = 0;
        this.state.lastFailureTime = null;
        this.state.nextAttemptTime = null;
      }
    }
  }

  private onFailure(): void {
    this.state.failures++;
    this.state.lastFailureTime = Date.now();

    if (this.state.state === 'HALF_OPEN') {
      this.state.state = 'OPEN';
      this.state.nextAttemptTime = Date.now() + this.config.timeout;
    } else if (this.state.failures >= this.config.failureThreshold) {
      this.state.state = 'OPEN';
      this.state.nextAttemptTime = Date.now() + this.config.timeout;
    }
  }

  getState(): CircuitBreakerState {
    return { ...this.state };
  }

  reset(): void {
    this.state = {
      state: 'CLOSED',
      failures: 0,
      successes: 0,
      lastFailureTime: null,
      nextAttemptTime: null,
    };
  }
}
