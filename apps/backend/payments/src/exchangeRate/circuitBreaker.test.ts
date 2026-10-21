/**
 * Unit tests for the Issue #379 circuit breaker for rate oracle calls.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  CircuitBreaker,
  CircuitBreakerOpenError,
  getRateOracleCircuitBreaker,
  setRateOracleCircuitBreaker,
  resetRateOracleCircuitBreakerForTesting,
} from "./circuitBreaker.js";

describe("Rate oracle CircuitBreaker", () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    resetRateOracleCircuitBreakerForTesting();
    breaker = new CircuitBreaker({ failureThreshold: 3, recoveryTimeoutMs: 100 });
  });

  it("starts closed and passes calls through", async () => {
    expect(breaker.getState()).toBe("closed");
    await expect(breaker.execute(async () => 42)).resolves.toBe(42);
    expect(breaker.getStats().totalRequests).toBe(1);
    expect(breaker.getStats().totalFailures).toBe(0);
  });

  it("opens after the failure threshold is reached", async () => {
    const failing = async () => {
      throw new Error("oracle down");
    };

    for (let i = 0; i < 3; i++) {
      await expect(breaker.execute(failing)).rejects.toThrow("oracle down");
    }

    expect(breaker.getState()).toBe("open");
    expect(breaker.getStats().totalFailures).toBe(3);
  });

  it("rejects immediately with CircuitBreakerOpenError while open", async () => {
    const failing = async (): Promise<number> => {
      throw new Error("oracle down");
    };
    for (let i = 0; i < 3; i++) {
      await expect(breaker.execute(failing)).rejects.toThrow("oracle down");
    }

    const oracleFn = vi.fn(async () => 1);
    await expect(breaker.execute(oracleFn)).rejects.toThrow(CircuitBreakerOpenError);
    expect(oracleFn).not.toHaveBeenCalled();
    expect(breaker.getStats().totalRejections).toBe(1);
  });

  it("transitions to half_open after the recovery timeout and closes on success", async () => {
    const failing = async (): Promise<number> => {
      throw new Error("oracle down");
    };
    for (let i = 0; i < 3; i++) {
      await expect(breaker.execute(failing)).rejects.toThrow("oracle down");
    }
    expect(breaker.getState()).toBe("open");

    await new Promise((r) => setTimeout(r, 120));

    expect(breaker.getState()).toBe("half_open");
    await expect(breaker.execute(async () => 1)).resolves.toBe(1);
    // halfOpenSuccessThreshold defaults to 2
    await expect(breaker.execute(async () => 1)).resolves.toBe(1);
    expect(breaker.getState()).toBe("closed");
    expect(breaker.getStats().failureCount).toBe(0);
  });

  it("re-opens when the half-open test call fails", async () => {
    const failing = async (): Promise<number> => {
      throw new Error("oracle down");
    };
    for (let i = 0; i < 3; i++) {
      await expect(breaker.execute(failing)).rejects.toThrow("oracle down");
    }

    await new Promise((r) => setTimeout(r, 120));
    expect(breaker.getState()).toBe("half_open");

    await expect(breaker.execute(failing)).rejects.toThrow("oracle down");
    expect(breaker.getState()).toBe("open");
  });

  it("resets the failure counter on success while closed", async () => {
    const failing = async (): Promise<number> => {
      throw new Error("oracle down");
    };
    await expect(breaker.execute(failing)).rejects.toThrow();
    await expect(breaker.execute(failing)).rejects.toThrow();

    await expect(breaker.execute(async () => 1)).resolves.toBe(1);
    expect(breaker.getStats().failureCount).toBe(0);

    // Two more failures stay below the (reset) threshold of 3
    await expect(breaker.execute(failing)).rejects.toThrow();
    await expect(breaker.execute(failing)).rejects.toThrow();
    expect(breaker.getState()).toBe("closed");
  });

  it("manually resets to closed", async () => {
    const failing = async (): Promise<number> => {
      throw new Error("oracle down");
    };
    for (let i = 0; i < 3; i++) {
      await expect(breaker.execute(failing)).rejects.toThrow();
    }
    expect(breaker.getState()).toBe("open");

    breaker.reset();
    expect(breaker.getState()).toBe("closed");
    await expect(breaker.execute(async () => 1)).resolves.toBe(1);
  });

  it("uses env-driven defaults for the singleton", () => {
    const singleton = getRateOracleCircuitBreaker();
    expect(getRateOracleCircuitBreaker()).toBe(singleton);

    const custom = new CircuitBreaker({ failureThreshold: 10 });
    setRateOracleCircuitBreaker(custom);
    expect(getRateOracleCircuitBreaker()).toBe(custom);
  });
});
