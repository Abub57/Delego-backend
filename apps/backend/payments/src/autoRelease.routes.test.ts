import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { escrowCoordinator } from "./escrowCoordinator/index.js";
import { resetAutoReleaseConfigStore, setAutoReleaseConfig } from "./autoRelease/configStore.js";
import { resetConfirmationTracker } from "./autoRelease/confirmationTracker.js";
import { resetReleaseQueue } from "./autoRelease/releaseQueue.js";
import { resetWebhookIdempotencyCache } from "./autoRelease/idempotency.js";
import { registerRoutes } from "./routes.js";
import { enqueueAutoRelease } from "./workers/autoRelease.js";
import type { Route } from "@delegolabs/utils";

vi.mock("./escrowCoordinator/index.js", () => ({
  escrowCoordinator: {
    getEscrowStatus: vi.fn(),
    releaseEscrow: vi.fn(),
    fundEscrow: vi.fn(),
    refundEscrow: vi.fn(),
    disputeEscrow: vi.fn(),
  },
}));
vi.mock("./workers/autoRelease.js", () => ({
  enqueueAutoRelease: vi.fn(),
}));

const SECRET = "test-webhook-secret";

type MockResponse = ServerResponse & { statusCode: number; body: string };

function createMockReq(body: string, headers: Record<string, string> = {}): IncomingMessage {
  const req = new EventEmitter() as unknown as IncomingMessage;
  req.headers = { "content-type": "application/json", "x-idempotency-key": "test-idempotency-key", ...headers };
  process.nextTick(() => {
    req.emit("data", Buffer.from(body));
    req.emit("end");
  });
  return req;
}

function createMockRes(): MockResponse {
  const res = {
    statusCode: 0,
    body: "",
    writeHead(status: number) {
      this.statusCode = status;
    },
    end(body?: string) {
      if (body !== undefined) this.body = body;
    },
  };
  return res as MockResponse;
}

function sign(body: string, secret = SECRET): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

function findDeliveryConfirmedRoute(): Route {
  const route = registerRoutes().find(
    (r) => r.method === "POST" && r.pattern.test("/escrow/42/delivery-confirmed")
  );
  if (!route) throw new Error("delivery-confirmed route not registered");
  return route;
}

function payload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    orderId: "order-1",
    deliveryProof: { deliveredAt: new Date().toISOString() },
    confirmedBy: "merchant-1",
    timestamp: new Date().toISOString(),
    ...overrides,
  });
}

describe("POST /escrow/:escrowId/delivery-confirmed", () => {
  beforeEach(() => {
    process.env.ESCROW_WEBHOOK_SECRET = SECRET;
    process.env.ESCROW_CONTRACT_ID = "CCONTRACTID000000000000000000000000000000000000000000000000";
    process.env.ESCROW_AUTO_RELEASE_CALLER_ADDRESS = "GCALLERADDRESS0000000000000000000000000000000000000000000";
    resetAutoReleaseConfigStore();
    resetConfirmationTracker();
    resetReleaseQueue();
    resetWebhookIdempotencyCache();
    vi.mocked(escrowCoordinator.getEscrowStatus).mockReset();
    vi.mocked(escrowCoordinator.releaseEscrow).mockReset();
    vi.mocked(enqueueAutoRelease).mockReset().mockResolvedValue({
      jobId: "queued-1", scheduledFor: "2026-09-27T14:00:00.000Z",
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.ESCROW_WEBHOOK_SECRET;
    delete process.env.ESCROW_CONTRACT_ID;
    delete process.env.ESCROW_AUTO_RELEASE_CALLER_ADDRESS;
  });

  it("returns 401 when the signature is invalid", async () => {
    const route = findDeliveryConfirmedRoute();
    const body = payload();
    const req = createMockReq(body, { "x-signature": "0".repeat(64) });
    const res = createMockRes();

    await route.handler(req, res, { escrowId: "42" });

    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error.code).toBe("UNAUTHORIZED");
    expect(escrowCoordinator.releaseEscrow).not.toHaveBeenCalled();
  });

  it("returns 400 when the idempotency key is missing", async () => {
    const body = payload();
    const req = createMockReq(body, { "x-signature": sign(body) });
    delete req.headers["x-idempotency-key"];
    const res = createMockRes();

    await findDeliveryConfirmedRoute().handler(req, res, { escrowId: "42" });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    expect(escrowCoordinator.releaseEscrow).not.toHaveBeenCalled();
  });

  it("returns 401 when the signature header is missing", async () => {
    const route = findDeliveryConfirmedRoute();
    const body = payload();
    const req = createMockReq(body);
    const res = createMockRes();

    await route.handler(req, res, { escrowId: "42" });

    expect(res.statusCode).toBe(401);
  });

  it("returns 503 when the webhook secret is not configured", async () => {
    delete process.env.ESCROW_WEBHOOK_SECRET;
    const route = findDeliveryConfirmedRoute();
    const body = payload();
    const req = createMockReq(body, { "x-signature": sign(body) });
    const res = createMockRes();

    await route.handler(req, res, { escrowId: "42" });

    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).error.code).toBe("CONFIG_ERROR");
  });

  it("processes a validly signed request and releases a funded escrow", async () => {
    vi.mocked(escrowCoordinator.getEscrowStatus).mockResolvedValue({
      escrowId: "42",
      buyer: "GBUYER",
      seller: "GSELLER",
      amount: "1000",
      status: "funded",
      createdAt: Date.now(),
    });
    vi.mocked(escrowCoordinator.releaseEscrow).mockResolvedValue({
      txHash: "tx-webhook",
      ledger: 4,
      status: "released",
      sellerAddress: "GSELLER",
      amount: "1000",
    });

    const route = findDeliveryConfirmedRoute();
    const body = payload();
    const req = createMockReq(body, { "x-signature": sign(body) });
    const res = createMockRes();

    await route.handler(req, res, { escrowId: "42" });

    expect(res.statusCode).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(parsed.data.success).toBe(true);
    expect(parsed.data.transactionHash).toBe("tx-webhook");
  });

  it("returns the cached response for a duplicate idempotency key", async () => {
    vi.mocked(escrowCoordinator.getEscrowStatus).mockResolvedValue({
      escrowId: "42", buyer: "GBUYER", seller: "GSELLER", amount: "1000",
      status: "funded", createdAt: Date.now(),
    });
    vi.mocked(escrowCoordinator.releaseEscrow).mockResolvedValue({
      txHash: "tx-webhook", ledger: 4, status: "released", sellerAddress: "GSELLER", amount: "1000",
    });

    const route = findDeliveryConfirmedRoute();
    const body = payload();
    const headers = { "x-signature": sign(body), "x-idempotency-key": "duplicate-request" };
    const firstResponse = createMockRes();
    const secondResponse = createMockRes();

    await route.handler(createMockReq(body, headers), firstResponse, { escrowId: "42" });
    await route.handler(createMockReq(body, headers), secondResponse, { escrowId: "42" });

    expect(firstResponse.statusCode).toBe(200);
    expect(secondResponse.statusCode).toBe(200);
    expect(secondResponse.body).toBe(firstResponse.body);
    expect(escrowCoordinator.releaseEscrow).toHaveBeenCalledTimes(1);
  });

  it("queues a verified delivery until the configured grace window ends", async () => {
    await setAutoReleaseConfig({
      escrowId: "42", enabled: true, delayMinutes: 5,
      partialReleaseEnabled: false, requiredConfirmations: 1,
    });
    vi.mocked(escrowCoordinator.getEscrowStatus).mockResolvedValue({
      escrowId: "42", buyer: "GBUYER", seller: "GSELLER", amount: "1000",
      status: "funded", createdAt: Date.now(),
    });
    const body = payload();
    const signature = sign(body);
    const res = createMockRes();
    await findDeliveryConfirmedRoute().handler(
      createMockReq(body, { "x-signature": signature }), res, { escrowId: "42" }
    );

    expect(res.statusCode).toBe(202);
    expect(enqueueAutoRelease).toHaveBeenCalledWith(expect.objectContaining({
      escrowId: "42", orderId: "order-1",
      signedProof: expect.objectContaining({ signature, confirmedBy: "merchant-1" }),
      graceExpiresAt: expect.any(Number),
    }));
    expect(escrowCoordinator.releaseEscrow).not.toHaveBeenCalled();
  });

  it("returns 409 when the escrow is disputed", async () => {
    vi.mocked(escrowCoordinator.getEscrowStatus).mockResolvedValue({
      escrowId: "42",
      buyer: "GBUYER",
      seller: "GSELLER",
      amount: "1000",
      status: "disputed",
      createdAt: Date.now(),
    });

    const route = findDeliveryConfirmedRoute();
    const body = payload();
    const req = createMockReq(body, { "x-signature": sign(body) });
    const res = createMockRes();

    await route.handler(req, res, { escrowId: "42" });

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error.code).toBe("ESCROW_DISPUTED");
    expect(escrowCoordinator.releaseEscrow).not.toHaveBeenCalled();
  });

  it("returns 400 when the escrow is not in a Funded state", async () => {
    vi.mocked(escrowCoordinator.getEscrowStatus).mockResolvedValue({
      escrowId: "42",
      buyer: "GBUYER",
      seller: "GSELLER",
      amount: "1000",
      status: "released",
      createdAt: Date.now(),
    });

    const route = findDeliveryConfirmedRoute();
    const body = payload();
    const req = createMockReq(body, { "x-signature": sign(body) });
    const res = createMockRes();

    await route.handler(req, res, { escrowId: "42" });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe("ESCROW_NOT_RELEASABLE");
  });

  it("returns 400 when required fields are missing from the payload", async () => {
    const route = findDeliveryConfirmedRoute();
    const body = JSON.stringify({ confirmedBy: "merchant-1" });
    const req = createMockReq(body, { "x-signature": sign(body) });
    const res = createMockRes();

    await route.handler(req, res, { escrowId: "42" });

    expect(res.statusCode).toBe(400);
  });

  it("returns 400 when the body escrowId does not match the URL path", async () => {
    const route = findDeliveryConfirmedRoute();
    const body = payload({ escrowId: "999" });
    const req = createMockReq(body, { "x-signature": sign(body) });
    const res = createMockRes();

    await route.handler(req, res, { escrowId: "42" });

    expect(res.statusCode).toBe(400);
  });
});
