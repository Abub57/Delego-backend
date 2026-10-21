import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { HealthRegistry, requireAuth, startHttpServer } from "@delegolabs/utils";
import { createOrchestratorHealthRoutes } from "./health.js";

const servers: Server[] = [];

afterEach(() => {
  for (const server of servers) server.close();
  servers.length = 0;
});

describe("orchestrator GET /health", () => {
  it("returns the health status without requiring authentication", async () => {
    const registry = new HealthRegistry();
    registry.register("postgres", async () => ({ status: "healthy" }), { type: "database", critical: true });
    registry.register("redis", async () => ({ status: "healthy" }), { type: "redis" });
    const server = startHttpServer({
      port: 0,
      host: "127.0.0.1",
      serviceName: "orchestrator",
      middleware: [requireAuth()],
      routes: createOrchestratorHealthRoutes(registry),
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Health test server did not bind a TCP port");

    const response = await fetch(`http://127.0.0.1:${address.port}/health`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      data: {
        service: "orchestrator",
        version: "0.0.1",
        status: "ok",
        checks: [{ name: "postgres", status: "healthy" }, { name: "redis", status: "healthy" }],
      },
      error: null,
    });
  });
});
