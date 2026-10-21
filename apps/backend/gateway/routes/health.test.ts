import { describe, expect, it, afterEach, vi } from "vitest";
import type { Route } from "@delegolabs/utils";
import {
  createGatewayHealthRegistry,
  type GatewayHealthOptions,
} from "../src/health.js";
import { createGatewayHealthRoutes } from "./health.js";

type RouteHandler = (
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  params: Record<string, string>,
) => void | Promise<void>;

function findHandler(routes: Route[], path: string): RouteHandler {
  const route = routes.find((r) => r.pattern.test(path));
  if (!route) throw new Error(`No route matches ${path}`);
  return route.handler;
}

function capture(handler: RouteHandler, path: string): () => Promise<{ status: number; body: string }> {
  const res = {
    statusCode: 0,
    body: "",
    headersSent: false,
    headers: {} as Record<string, string>,
    writeHead(status: number, headers?: Record<string, string>) {
      this.statusCode = status;
      this.headersSent = true;
      if (headers) Object.assign(this.headers, headers);
    },
    end(body?: string) {
      if (body !== undefined) this.body = body;
    },
  } as unknown as import("node:http").ServerResponse;

  const promise = handler({ url: path } as import("node:http").IncomingMessage, res, {});
  const settled = Promise.resolve(promise).then(() => ({
    status: res.statusCode,
    body: res.body,
  }));
  return () => settled;
}

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

function makeRoutes(overrides: GatewayHealthOptions = {}): Route[] {
  const registry = createGatewayHealthRegistry({
    checkDatabase: async () => 2,
    checkRedis: async () => ({ status: "ok", pingMs: 1 }),
    fetchImpl: healthyFetch(),
    ...overrides,
  });
  return createGatewayHealthRoutes(registry);
}

describe("gateway health routes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers live, ready, aggregate, dashboard, metrics and config routes once each", () => {
    const routes = makeRoutes();
    for (const path of [
      "/health/live",
      "/health/ready",
      "/health",
      "/health/dashboard",
      "/health/metrics",
      "/health/config",
    ]) {
      expect(routes.filter((r) => r.pattern.test(path))).toHaveLength(1);
    }
  });

  it("/health/live returns 200 with a healthy report and no dependency probing", async () => {
    const routes = makeRoutes();
    const result = await capture(findHandler(routes, "/health/live"), "/health/live")();
    expect(result.status).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.data.status).toBe("healthy");
    expect(body.data.checks.process).toEqual({ status: true, latencyMs: 0 });
    expect(body.error).toBeNull();
  });

  it("/health/ready returns 200 and the HealthCheckReport shape when dependencies are healthy", async () => {
    const routes = makeRoutes();
    const result = await capture(findHandler(routes, "/health/ready"), "/health/ready")();
    expect(result.status).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.data.status).toBe("healthy");
    expect(Object.keys(body.data.checks).sort()).toEqual([
      "horizon",
      "orchestrator",
      "payments",
      "postgresql",
      "redis",
      "sorobanRpc",
      "wallet",
    ]);
    expect(body.data.checks.postgresql.status).toBe(true);
    expect(typeof body.data.checks.postgresql.latencyMs).toBe("number");
  });

  it("/health/ready returns 503 when a critical dependency is unhealthy", async () => {
    const routes = makeRoutes({
      checkDatabase: async () => {
        throw new Error("connection refused");
      },
    });
    const result = await capture(findHandler(routes, "/health/ready"), "/health/ready")();
    expect(result.status).toBe(503);
    const body = JSON.parse(result.body);
    expect(body.data.status).toBe("unhealthy");
    expect(body.data.checks.postgresql.status).toBe(false);
  });

  it("/health/ready degrades (200) when only Stellar dependencies are down", async () => {
    const routes = makeRoutes({
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as typeof fetch,
    });
    const result = await capture(findHandler(routes, "/health/ready"), "/health/ready")();
    expect(result.status).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.data.status).toBe("degraded");
    expect(body.data.checks.horizon.status).toBe(false);
    expect(body.data.checks.sorobanRpc.status).toBe(false);
  });
});
