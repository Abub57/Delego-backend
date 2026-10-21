/**
 * Integration test for POST /api/v1/courier/webhooks/:carrier (Issue #577).
 *
 * Runs the route on a real HTTP server behind the real bodyLimitMiddleware and
 * an async middleware, because the gateway chain consumes the request stream
 * before routes run and unit tests with fake requests cannot see that.
 */
import { createHmac } from "node:crypto";
import { request } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { route, startHttpServer } from "@delegolabs/utils";
import { bodyLimitMiddleware } from "./api-v1.js";
import { courierWebhookBodyCapture } from "./webhookBody.js";
import { createCourierWebhookHandler } from "./webhooks.js";

const SECRET = "integration-secret";
const BODY = JSON.stringify({ trackingNumber: "794600000001", statusCode: "OD" });
const SIGNATURE = createHmac("sha256", SECRET).update(BODY, "utf8").digest("hex");

type Middleware = NonNullable<Parameters<typeof startHttpServer>[0]["middleware"]>[number];

// Stands in for the awaits on Redis in rateLimitMiddleware.
const asyncDelay: Middleware = async (_req, _res, next) => {
  await new Promise((resolve) => setTimeout(resolve, 50));
  next();
};

let server: Server | undefined;

function start(middleware: Middleware[], xadd: ReturnType<typeof vi.fn>): Promise<number> {
  return new Promise((resolve) => {
    const s = startHttpServer({
      port: 0,
      host: "127.0.0.1",
      serviceName: "webhook-integration-test",
      middleware,
      routes: [
        route(
          "POST",
          "/api/v1/courier/webhooks/:carrier",
          createCourierWebhookHandler({ redis: { xadd }, secrets: { fedex: SECRET } }),
        ),
      ],
    });
    server = s;
    s.once("listening", () => resolve((s.address() as AddressInfo).port));
  });
}

async function post(port: number): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/courier/webhooks/fedex`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-fedex-signature": SIGNATURE },
    body: BODY,
    signal: AbortSignal.timeout(2000),
  });
  return res.status;
}

afterEach(() => {
  server?.closeAllConnections();
  server?.close();
  server = undefined;
});

describe("courier webhook behind the real gateway middleware", () => {
  it("accepts a signed event after bodyLimitMiddleware and an async middleware", async () => {
    const xadd = vi.fn().mockResolvedValue("1-0");
    const port = await start([courierWebhookBodyCapture(), bodyLimitMiddleware(), asyncDelay], xadd);
    expect(await post(port)).toBe(200);
    expect(xadd).toHaveBeenCalledTimes(1);
  }, 10_000);

  it("control: accepts the same event when only the async middleware runs", async () => {
    const xadd = vi.fn().mockResolvedValue("1-0");
    const port = await start([asyncDelay], xadd);
    expect(await post(port)).toBe(200);
    expect(xadd).toHaveBeenCalledTimes(1);
  }, 10_000);
});


function rawPost(
  port: number,
  headers: Record<string, string>,
  chunks: Buffer[],
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/api/v1/courier/webhooks/fedex",
        headers: { "content-type": "application/json", "x-fedex-signature": SIGNATURE, ...headers },
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        res.on("error", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.setTimeout(3000, () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    for (const chunk of chunks) req.write(chunk);
    req.end();
  });
}

describe("courier webhook body limit (capture middleware)", () => {
  const chain = () => [courierWebhookBodyCapture(), bodyLimitMiddleware(), asyncDelay];

  it("returns 413 when content-length exceeds 100 KiB", async () => {
    const xadd = vi.fn().mockResolvedValue("1-0");
    const port = await start(chain(), xadd);
    const big = Buffer.alloc(101 * 1024, "a");
    const res = await rawPost(port, { "content-length": String(big.length) }, [big]);
    expect(res.status).toBe(413);
    expect(JSON.parse(res.body).error.code).toBe("PAYLOAD_TOO_LARGE");
    expect(xadd).not.toHaveBeenCalled();
  }, 10_000);

  it("returns 413 when a chunked body (no content-length) exceeds 100 KiB", async () => {
    const xadd = vi.fn().mockResolvedValue("1-0");
    const port = await start(chain(), xadd);
    const half = Buffer.alloc(60 * 1024, "a");
    const res = await rawPost(port, {}, [half, half]);
    expect(res.status).toBe(413);
    expect(JSON.parse(res.body).error.code).toBe("PAYLOAD_TOO_LARGE");
    expect(xadd).not.toHaveBeenCalled();
  }, 10_000);
});
// END-OF-FILE-MARKER
