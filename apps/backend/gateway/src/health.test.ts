import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServiceHealth } from "@delegolabs/utils";
import {
  buildGatewayHealthReport,
  createGatewayHealthRegistry,
  toHealthCheckReport,
} from "./health.js";

/** Responds like every dependency being up (Horizon, Soroban RPC, downstreams). */
function healthyFetch(): typeof fetch {
  return (async (input: unknown) => {
    const url = String(input);
    if (url.includes("rpc") || url.includes("soroban")) {
      return new Response(JSON.stringify({ result: { status: "healthy" } }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: { status: "ok" } }), { status: 200 });
  }) as unknown as typeof fetch;
}

function failingFetch(): typeof fetch {
  return (async () => {
    throw new Error("ECONNREFUSED");
  }) as typeof fetch;
}

describe("createGatewayHealthRegistry", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("registers postgresql, redis, horizon, soroban RPC and the downstream services", () => {
    const registry = createGatewayHealthRegistry({});
    expect(registry.names).toEqual([
      "postgresql",
      "redis",
      "horizon",
      "sorobanRpc",
      "orchestrator",
      "wallet",
      "payments",
    ]);
  });

  it("reports healthy when all dependencies are healthy", async () => {
    const registry = createGatewayHealthRegistry({
      checkDatabase: async () => 3,
      checkRedis: async () => ({ status: "ok", pingMs: 1 }),
      fetchImpl: healthyFetch(),
    });
    const report = await buildGatewayHealthReport(registry);

    expect(report.status).toBe("healthy");
    expect(report.checks.postgresql.status).toBe(true);
    expect(Number.isFinite(report.checks.postgresql.latencyMs)).toBe(true);
    expect(report.checks.redis.status).toBe(true);
    expect(report.checks.horizon.status).toBe(true);
    expect(report.checks.sorobanRpc.status).toBe(true);
    // The DB probe still exposes the query latency measured by checkDatabaseHealth.
    expect(registry.peek("postgresql")?.details?.latencyMs).toBe(3);
  });

  it("fails readiness when the database is down (critical)", async () => {
    const registry = createGatewayHealthRegistry({
      checkDatabase: async () => {
        throw new Error("connection refused");
      },
      checkRedis: async () => ({ status: "ok", pingMs: 1 }),
      fetchImpl: healthyFetch(),
    });
    const report = await buildGatewayHealthReport(registry);

    expect(report.status).toBe("unhealthy");
    expect(report.checks.postgresql.status).toBe(false);
  });

  it("degrades (but stays ready) when only Stellar dependencies are unreachable", async () => {
    const registry = createGatewayHealthRegistry({
      checkDatabase: async () => 2,
      checkRedis: async () => ({ status: "ok", pingMs: 1 }),
      fetchImpl: failingFetch(),
    });
    const report = await buildGatewayHealthReport(registry);

    expect(report.status).toBe("degraded");
    expect(report.checks.horizon.status).toBe(false);
    expect(report.checks.sorobanRpc.status).toBe(false);
  });

  it("reports degraded for redis failures", async () => {
    const registry = createGatewayHealthRegistry({
      checkDatabase: async () => 2,
      checkRedis: async () => ({ status: "degraded", error: "timeout" }),
      fetchImpl: healthyFetch(),
    });
    const report = await buildGatewayHealthReport(registry);

    expect(report.status).toBe("degraded");
    expect(report.checks.redis.status).toBe(false);
    expect(registry.peek("redis")?.details?.error).toBe("timeout");
  });

  it("times out a dependency that never responds", async () => {
    vi.useFakeTimers();
    const registry = createGatewayHealthRegistry({
      checkDatabase: () => new Promise<number>(() => {}),
      checkRedis: async () => ({ status: "ok", pingMs: 1 }),
      fetchImpl: healthyFetch(),
    });

    const pending = buildGatewayHealthReport(registry);
    await vi.advanceTimersByTimeAsync(2100);
    const report = await pending;

    expect(report.checks.postgresql.status).toBe(false);
    expect(report.status).toBe("unhealthy");
  });
});

describe("toHealthCheckReport", () => {
  it("maps ServiceHealth checks to booleans with the measured latency", () => {
    const health: ServiceHealth = {
      service: "gateway",
      version: "0.0.1",
      status: "degraded",
      uptimeSeconds: 5,
      checks: [
        { name: "postgresql", status: "healthy", latencyMs: 4, checkedAt: new Date().toISOString() },
        { name: "horizon", status: "degraded", latencyMs: 12, checkedAt: new Date().toISOString() },
        { name: "sorobanRpc", status: "unhealthy", latencyMs: 2000, checkedAt: new Date().toISOString() },
      ],
    };

    expect(toHealthCheckReport(health)).toEqual({
      status: "degraded",
      checks: {
        postgresql: { status: true, latencyMs: 4 },
        horizon: { status: false, latencyMs: 12 },
        sorobanRpc: { status: false, latencyMs: 2000 },
      },
    });
  });
});
