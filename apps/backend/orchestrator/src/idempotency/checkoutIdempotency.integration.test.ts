/**
 * Integration test: rapid concurrent identical checkout submissions.
 *
 * Boots a real HTTP server whose checkout handler is guarded by the
 * idempotency pre-handler (backed by ioredis-mock) and fires simultaneous
 * duplicate requests at it, asserting that exactly one order is created and
 * every duplicate receives the byte-identical response.
 */

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
// @ts-ignore -- ioredis-mock has no first-party types
import MockRedis from "ioredis-mock";
import { IdempotencyStore, type IdempotencyRedis } from "./store.js";
import { createCheckoutIdempotencyPreHandler } from "./preHandler.js";

const WALLET = "GBUYERWALLETADDRESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
const ITEMS = [
  { merchantId: "m-1", productId: "p-1", quantity: 2 },
  { merchantId: "m-1", productId: "p-2", quantity: 1 },
];

interface TestServer {
  url: string;
  orders: string[];
  server: Server;
}

interface HarnessOptions {
  handlerDelayMs?: number;
  /** Status codes returned by successive real executions (default: always 201). */
  statusSequence?: number[];
}

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections?.();
          server.close(() => resolve());
        }),
    ),
  );
});

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => resolve(raw ? JSON.parse(raw) : {}));
    req.on("error", reject);
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function startCheckoutServer(options: HarnessOptions = {}): Promise<TestServer> {
  const orders: string[] = [];
  const statusSequence = [...(options.statusSequence ?? [])];
  const store = new IdempotencyStore(new MockRedis() as unknown as IdempotencyRedis, {
    // ioredis-mock shares data between instances; isolate each test.
    namespace: `test:checkout:${randomUUID()}`,
  });
  const preHandler = createCheckoutIdempotencyPreHandler({
    store,
    pollIntervalMs: 10,
    waitForCompletionMs: 3_000,
  });

  const server = createServer(async (req, res) => {
    const body = await readBody(req);
    const outcome = await preHandler(req, res, {
      userId: String(req.headers["x-user-id"] ?? "user-1"),
      walletAddress: String(body.buyerAddress),
      items: body.items,
      nonce: String(body.nonce),
    });
    if (outcome === "replied") return;

    // Simulates the slow part of checkout (saga, escrow, DB insert).
    await sleep(options.handlerDelayMs ?? 100);

    const status = statusSequence.shift() ?? 201;
    if (status >= 500) {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: null, error: { code: "CHECKOUT_SAGA_FAILED" } }));
      return;
    }

    const orderId = randomUUID();
    orders.push(orderId);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: { orderId, createdAt: Date.now() }, error: null }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/checkout`, orders, server };
}

async function submit(
  url: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string; replayed: boolean }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    body: await response.text(),
    replayed: response.headers.get("idempotency-replayed") === "true",
  };
}

describe("checkout idempotency (integration)", () => {
  it("creates exactly one order for rapid concurrent identical submissions", async () => {
    const { url, orders } = await startCheckoutServer({ handlerDelayMs: 150 });
    const payload = { buyerAddress: WALLET, items: ITEMS, nonce: "nonce-1" };

    const responses = await Promise.all(Array.from({ length: 25 }, () => submit(url, payload)));

    expect(orders).toHaveLength(1);
    expect(responses.every((r) => r.status === 201)).toBe(true);
    expect(new Set(responses.map((r) => r.body)).size).toBe(1);
    expect(JSON.parse(responses[0].body).data.orderId).toBe(orders[0]);
    expect(responses.filter((r) => !r.replayed)).toHaveLength(1);
    expect(responses.filter((r) => r.replayed)).toHaveLength(24);
  });

  it("replays the cached response for a retry after completion", async () => {
    const { url, orders } = await startCheckoutServer();
    const payload = { buyerAddress: WALLET, items: ITEMS, nonce: "nonce-retry" };

    const first = await submit(url, payload);
    const retry = await submit(url, payload);

    expect(orders).toHaveLength(1);
    expect(retry.status).toBe(first.status);
    expect(retry.body).toBe(first.body);
    expect(retry.replayed).toBe(true);
  });

  it("treats reordered items and keys as the same fingerprint", async () => {
    const { url, orders } = await startCheckoutServer();

    await submit(url, { buyerAddress: WALLET, items: ITEMS, nonce: "nonce-order" });
    const reordered = await submit(url, {
      nonce: "nonce-order",
      items: [
        { quantity: 1, productId: "p-2", merchantId: "m-1" },
        { quantity: 2, productId: "p-1", merchantId: "m-1" },
      ],
      buyerAddress: WALLET,
    });

    expect(orders).toHaveLength(1);
    expect(reordered.replayed).toBe(true);
  });

  it("creates separate orders for distinct nonces", async () => {
    const { url, orders } = await startCheckoutServer();

    await Promise.all([
      submit(url, { buyerAddress: WALLET, items: ITEMS, nonce: "nonce-a" }),
      submit(url, { buyerAddress: WALLET, items: ITEMS, nonce: "nonce-b" }),
    ]);

    expect(orders).toHaveLength(2);
  });

  it("deduplicates concurrent requests sharing an Idempotency-Key header", async () => {
    const { url, orders } = await startCheckoutServer({ handlerDelayMs: 100 });
    const headers = { "Idempotency-Key": "client-key-1" };
    const payload = { buyerAddress: WALLET, items: ITEMS, nonce: "nonce-header" };

    const responses = await Promise.all(Array.from({ length: 10 }, () => submit(url, payload, headers)));

    expect(orders).toHaveLength(1);
    expect(new Set(responses.map((r) => r.body)).size).toBe(1);
  });

  it("rejects an Idempotency-Key reused with a different payload", async () => {
    const { url, orders } = await startCheckoutServer();
    const headers = { "Idempotency-Key": "client-key-2" };

    await submit(url, { buyerAddress: WALLET, items: ITEMS, nonce: "n-1" }, headers);
    const mismatch = await submit(
      url,
      { buyerAddress: WALLET, items: [{ merchantId: "m-1", productId: "p-9", quantity: 1 }], nonce: "n-1" },
      headers,
    );

    expect(orders).toHaveLength(1);
    expect(mismatch.status).toBe(422);
    expect(JSON.parse(mismatch.body).error.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("scopes header keys per user so one user never replays another's order", async () => {
    const { url, orders } = await startCheckoutServer();
    const payload = { buyerAddress: WALLET, items: ITEMS, nonce: "n-shared" };

    await submit(url, payload, { "Idempotency-Key": "shared", "x-user-id": "user-a" });
    const other = await submit(url, payload, { "Idempotency-Key": "shared", "x-user-id": "user-b" });

    expect(orders).toHaveLength(2);
    expect(other.replayed).toBe(false);
  });

  it("does not cache 5xx responses, so a retry re-executes", async () => {
    const { url, orders } = await startCheckoutServer({ statusSequence: [502, 201] });
    const payload = { buyerAddress: WALLET, items: ITEMS, nonce: "nonce-5xx" };

    const failed = await submit(url, payload);
    const retried = await submit(url, payload);

    expect(failed.status).toBe(502);
    expect(retried.status).toBe(201);
    expect(retried.replayed).toBe(false);
    expect(orders).toHaveLength(1);
  });

  it("rejects Idempotency-Key headers longer than 255 characters", async () => {
    const { url, orders } = await startCheckoutServer();

    const response = await submit(
      url,
      { buyerAddress: WALLET, items: ITEMS, nonce: "n-long" },
      { "Idempotency-Key": "k".repeat(256) },
    );

    expect(response.status).toBe(400);
    expect(orders).toHaveLength(0);
  });
});
