import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { globalRateLimitPlugin } from "./fastifyPlugin.js";
import { GlobalTokenBucket } from "./globalTokenBucket.js";
import { generateAccessToken } from "../auth/authService.js";
import { Redis } from "ioredis";
import { randomUUID } from "node:crypto";

// Token-key logging is incidental to these HTTP/authentication assertions.
vi.mock("../logger.js", () => ({
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

async function gateway(limiter: GlobalTokenBucket) {
  const app = Fastify();
  apps.push(app);
  await app.register(globalRateLimitPlugin, { limiter });
  app.get("/orders", async () => ({ ok: true }));
  app.get("/payments", async () => ({ ok: true }));
  app.get("/health", async () => ({ ok: true }));
  return app;
}

describe("Fastify global rate limiting adapter", () => {
  it.skipIf(!process.env.RATE_LIMIT_TEST_REDIS_URL)(
    "handles 1000 concurrent HTTP requests across two gateways with one Redis quota", async () => {
      const prefix = `test:539:http:${randomUUID()}:`;
      const clients = [0, 1].map(() => new Redis(process.env.RATE_LIMIT_TEST_REDIS_URL!, {
        lazyConnect: true, maxRetriesPerRequest: 0,
      }));
      try {
        await Promise.all(clients.map((client) => client.connect()));
        const replicas = await Promise.all(clients.map((client) =>
          gateway(new GlobalTokenBucket(client, prefix, () => 1000))));
        const replies = await Promise.all(Array.from({ length: 1000 }, (_, i) =>
          replicas[i % 2].inject(i % 3 ? "/orders" : "/payments")));
        expect(replies.filter((reply) => reply.statusCode === 200)).toHaveLength(60);
        expect(replies.filter((reply) => reply.statusCode === 429)).toHaveLength(940);
        expect(replies.every((reply) => reply.headers["x-ratelimit-limit"] === "60")).toBe(true);
      } finally {
        if (clients[0].status === "ready") {
          const keys = await clients[0].keys(`${prefix}*`);
          if (keys.length) await clients[0].del(...keys);
        }
        clients.forEach((client) => client.disconnect());
      }
    }, 20000,
  );
  it("shares identity across routes and returns 429 without running the handler", async () => {
    const evalScript = vi.fn().mockResolvedValueOnce([1, 0, 0]).mockResolvedValue([0, 0, 1000]);
    const app = await gateway(new GlobalTokenBucket({ eval: evalScript }));
    const first = await app.inject("/orders");
    expect(first.statusCode).toBe(200);
    expect(first.headers["x-ratelimit-remaining"]).toBe("0");
    const second = await app.inject("/payments");
    expect(second.statusCode).toBe(429);
    expect(second.headers["retry-after"]).toBe("1");
    expect(second.json().error.code).toBe("RATE_LIMIT_EXCEEDED");
    expect(evalScript.mock.calls[0][2]).toBe(evalScript.mock.calls[1][2]);
  });

  it("derives tier and identity from a signed token, ignoring forged tier headers", async () => {
    const evalScript = vi.fn().mockResolvedValue([1, 0, 0]);
    const app = await gateway(new GlobalTokenBucket({ eval: evalScript }));
    const token = generateAccessToken("merchant-539", "merchant@example.test", ["merchant"]);
    const verified = await app.inject({
      url: "/orders", headers: { authorization: `Bearer ${token}`, "x-tier": "enterprise" },
    });
    expect(verified.headers["x-ratelimit-limit"]).toBe("600");
    const forged = await app.inject({
      url: "/orders", headers: { authorization: "Bearer invalid", "x-tier": "enterprise", "x-merchant-id": "new-id" },
    });
    expect(forged.headers["x-ratelimit-limit"]).toBe("60");
    expect(evalScript.mock.calls[0][2]).not.toBe(evalScript.mock.calls[1][2]);
  });

  it("returns 503 on Redis failure while keeping health checks available", async () => {
    const evalScript = vi.fn().mockRejectedValue(new Error("Redis offline"));
    const app = await gateway(new GlobalTokenBucket({ eval: evalScript }));
    const response = await app.inject("/orders");
    expect(response.statusCode).toBe(503);
    expect(response.headers["retry-after"]).toBe("1");
    expect(response.json().error.code).toBe("RATE_LIMIT_UNAVAILABLE");
    expect((await app.inject("/health")).statusCode).toBe(200);
    expect(evalScript).toHaveBeenCalledTimes(1);
  });
});
