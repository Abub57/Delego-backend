/**
 * Gateway health registry (Issue #76, extended by Issue #376)
 *
 * Registers the gateway's dependency checks:
 *   postgresql  — critical (SELECT 1 against the shared Sequelize pool)
 *   redis       — critical (rate-limiter Redis PING)
 *   horizon     — non-critical Stellar Horizon HTTP API
 *   sorobanRpc  — non-critical Soroban JSON-RPC `getHealth`
 *   orchestrator / wallet / payments — non-critical downstream services,
 *   reported as "degraded" when unreachable so the gateway keeps serving
 *   traffic (graceful degradation) while making the problem visible.
 */

import { HealthRegistry, httpHealthCheck, type HealthCheckFn, type ServiceHealth } from "@delegolabs/utils";
import { checkDatabaseHealth } from "./db.js";
import { getRedisHealth, type RedisHealth } from "./rateLimit/redisClient.js";

const SERVICE_URLS = {
  orchestrator: process.env.ORCHESTRATOR_SERVICE_URL ?? "http://localhost:3013",
  wallet: process.env.WALLET_SERVICE_URL ?? "http://localhost:3012",
  payments: process.env.PAYMENTS_SERVICE_URL ?? "http://localhost:3014",
} as const;

const STELLAR_URLS = {
  horizon: process.env.STELLAR_HORIZON_URL ?? "https://horizon-testnet.stellar.org",
  sorobanRpc: process.env.STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org",
} as const;

export type DownstreamServiceName = keyof typeof SERVICE_URLS;

/**
 * JSON contract emitted by the probe endpoints (Issue #376): the aggregated
 * readiness plus one entry per probed dependency, where `status` is a boolean
 * "reachable and healthy" and `latencyMs` is the probe latency measured by the
 * registry.
 */
export interface HealthCheckReport {
  status: "healthy" | "degraded" | "unhealthy";
  checks: Record<string, { status: boolean; latencyMs: number }>;
}

export interface GatewayHealthOptions {
  checkDatabase?: () => Promise<number>;
  checkRedis?: () => Promise<RedisHealth>;
  fetchImpl?: typeof fetch;
  serviceUrls?: Record<DownstreamServiceName, string>;
  horizonUrl?: string;
  sorobanRpcUrl?: string;
  timeoutMs?: number;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Wraps an HTTP probe so a timeout or network error is reported as `degraded`
 * instead of throwing. Non-critical probes must not fail the whole readiness
 * check (graceful degradation), while still surfacing the problem.
 */
function createTolerantCheck(url: string, probe: HealthCheckFn): HealthCheckFn {
  return async () => {
    try {
      return await probe();
    } catch (err) {
      return { status: "degraded", details: { url, error: describeError(err) } };
    }
  };
}

const SOROBAN_HEALTH_BODY = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" });

/** Maps a ServiceHealth snapshot onto the HealthCheckReport contract. */
export function toHealthCheckReport(health: ServiceHealth): HealthCheckReport {
  const checks: HealthCheckReport["checks"] = {};
  for (const check of health.checks) {
    checks[check.name] = {
      status: check.status === "healthy",
      latencyMs: check.latencyMs,
    };
  }
  return { status: health.status, checks };
}

/** Runs the full readiness probe set and returns the HealthCheckReport. */
export async function buildGatewayHealthReport(
  registry: HealthRegistry,
  version = "0.0.1",
): Promise<HealthCheckReport> {
  const health = await registry.getServiceHealth("gateway", version, { readiness: true });
  return toHealthCheckReport(health);
}

export function createGatewayHealthRegistry(
  options: GatewayHealthOptions = {},
): HealthRegistry {
  const {
    checkDatabase = () => checkDatabaseHealth(2000),
    checkRedis = () => getRedisHealth(),
    fetchImpl = fetch,
    serviceUrls = SERVICE_URLS,
    horizonUrl = STELLAR_URLS.horizon,
    sorobanRpcUrl = STELLAR_URLS.sorobanRpc,
    timeoutMs = 2000,
  } = options;

  const registry = new HealthRegistry();

  registry.register(
    "postgresql",
    async () => {
      const latencyMs = await checkDatabase();
      return { status: "healthy", details: { latencyMs: Math.round(latencyMs) } };
    },
    { type: "database", critical: true },
  );

  registry.register(
    "redis",
    async () => {
      const health = await checkRedis();
      if (health.status === "ok") {
        return { status: "healthy", details: { pingMs: health.pingMs } };
      }
      return { status: "degraded", details: { error: health.error } };
    },
    { type: "redis", critical: true },
  );

  // Stellar Horizon: a 2xx on the API root means the ledger API is reachable.
  registry.register(
    "horizon",
    createTolerantCheck(
      horizonUrl,
      httpHealthCheck({ url: horizonUrl, timeoutMs, fetchImpl }),
    ),
    { type: "http", critical: false },
  );

  // Soroban RPC: JSON-RPC `getHealth` returns { result: { status } } — "healthy"
  // is the only status that counts as up.
  registry.register(
    "sorobanRpc",
    createTolerantCheck(
      sorobanRpcUrl,
      httpHealthCheck({
        url: sorobanRpcUrl,
        method: "POST",
        timeoutMs,
        fetchImpl,
        headers: { "Content-Type": "application/json" },
        body: SOROBAN_HEALTH_BODY,
        bodyStatus: (body) => {
          const status = (body as { result?: { status?: string } } | undefined)?.result?.status;
          return status === "healthy" ? "healthy" : "degraded";
        },
      }),
    ),
    { type: "http", critical: false },
  );

  const downstream: DownstreamServiceName[] = ["orchestrator", "wallet", "payments"];
  for (const name of downstream) {
    registry.register(
      name,
      createTolerantCheck(
        `${serviceUrls[name].replace(/\/$/, "")}/health/ready`,
        httpHealthCheck({
          url: `${serviceUrls[name].replace(/\/$/, "")}/health/ready`,
          timeoutMs,
          fetchImpl,
        }),
      ),
      { type: "http", critical: false },
    );
  }

  return registry;
}
