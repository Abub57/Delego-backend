import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Route } from "@delegolabs/utils";
import { escrowCoordinator } from "./escrowCoordinator/index.js";
import { resetAuditLogStore } from "./disputes/auditLog.js";
import { resetDisputeStore } from "./disputes/disputeStore.js";
import { resetReputationStore } from "./disputes/reputationStore.js";
import { registerRoutes } from "./routes.js";
import { findPaymentRecordByEscrowId } from "./escrowCoordinator/paymentRecordStore.js";

// Issue #350 — IDOR mitigation on GET /disputes/:disputeId. Mocked so these
// tests never touch a real Postgres pool.
vi.mock("./escrowCoordinator/paymentRecordStore.js", () => ({
  findPaymentRecordByEscrowId: vi.fn(),
}));

vi.mock("./escrowCoordinator/index.js", async () => {
  const actual = await vi.importActual<typeof import("./escrowCoordinator/index.js")>("./escrowCoordinator/index.js");
  return {
    ...actual,
    escrowCoordinator: {
      getEscrowStatus: vi.fn(),
      getRemainingBalance: vi.fn(),
      releaseEscrow: vi.fn(),
      refundEscrow: vi.fn(),
      disputeEscrow: vi.fn(),
      partialRefundEscrow: vi.fn(),
      partialReleaseEscrow: vi.fn(),
      fundEscrow: vi.fn(),
    },
  };
});

type MockResponse = ServerResponse & { statusCode: number; body: string };

function createMockReq(body: string, headers: Record<string, string> = {}): IncomingMessage {
  const req = new EventEmitter() as unknown as IncomingMessage;
  req.headers = { "content-type": "application/json", ...headers };
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

function findRoute(method: string, path: string): Route {
  const route = registerRoutes().find((r) => r.method === method && r.pattern.test(path));
  if (!route) throw new Error(`Route not registered: ${method} ${path}`);
  return route;
}

function balance(overrides: Partial<Awaited<ReturnType<typeof escrowCoordinator.getRemainingBalance>>> = {}) {
  return {
    escrowId: "42",
    orderId: "order-1",
    buyerAddress: "GBUYER",
    sellerAddress: "GSELLER",
    totalAmount: "1000",
    releasedAmount: "0",
    refundedAmount: "0",
    remainingAmount: "1000",
    ...overrides,
  };
}

describe("Partial refund & dispute mediation routes", () => {
  beforeEach(() => {
    process.env.ESCROW_CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    resetDisputeStore();
    resetAuditLogStore();
    resetReputationStore();
    vi.mocked(escrowCoordinator.getRemainingBalance).mockReset().mockResolvedValue(balance());
    vi.mocked(escrowCoordinator.disputeEscrow).mockReset().mockResolvedValue({
      txHash: "tx-dispute",
      ledger: 1,
      status: "disputed",
      disputedBy: "GBUYER",
    });
    vi.mocked(escrowCoordinator.partialRefundEscrow).mockReset();
    vi.mocked(escrowCoordinator.partialReleaseEscrow).mockReset();
    vi.mocked(findPaymentRecordByEscrowId).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.ESCROW_CONTRACT_ID;
  });

  it("POST /escrow/:escrowId/partial-refund executes a valid partial refund", async () => {
    vi.mocked(escrowCoordinator.partialRefundEscrow).mockResolvedValue({
      txHash: "tx-partial",
      ledger: 1,
      status: "partial_refunded",
      buyerAddress: "GBUYER",
      refundedAmount: "300",
      remainingAmount: "700",
    });

    const route = findRoute("POST", "/escrow/42/partial-refund");
    const body = JSON.stringify({ amount: "300", reason: "damaged", requestedBy: "GBUYER" });
    const req = createMockReq(body);
    const res = createMockRes();

    await route.handler(req, res, { escrowId: "42" });

    expect(res.statusCode).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(parsed.data.success).toBe(true);
    expect(parsed.data.transactionHash).toBe("tx-partial");
  });

  it("POST /escrow/:escrowId/partial-refund returns 400 when the amount exceeds the remaining balance", async () => {
    vi.mocked(escrowCoordinator.getRemainingBalance).mockResolvedValue(balance({ remainingAmount: "100" }));

    const route = findRoute("POST", "/escrow/42/partial-refund");
    const body = JSON.stringify({ amount: "300", reason: "damaged", requestedBy: "GBUYER" });
    const req = createMockReq(body);
    const res = createMockRes();

    await route.handler(req, res, { escrowId: "42" });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe("INSUFFICIENT_ESCROW_BALANCE");
  });

  it("POST /escrow/:escrowId/partial-refund returns 400 for a malformed amount", async () => {
    const route = findRoute("POST", "/escrow/42/partial-refund");
    const body = JSON.stringify({ amount: "not-a-number", reason: "x", requestedBy: "GBUYER" });
    const req = createMockReq(body);
    const res = createMockRes();

    await route.handler(req, res, { escrowId: "42" });

    expect(res.statusCode).toBe(400);
  });

  it("POST /escrow/:escrowId/disputes opens a dispute", async () => {
    const route = findRoute("POST", "/escrow/42/disputes");
    const body = JSON.stringify({ initiatedBy: "GBUYER", reason: "Item never arrived" });
    const req = createMockReq(body);
    const res = createMockRes();

    await route.handler(req, res, { escrowId: "42" });

    expect(res.statusCode).toBe(201);
    const parsed = JSON.parse(res.body);
    expect(parsed.data.status).toBe("open");
    expect(parsed.data.escrowId).toBe("42");
  });

  it("full lifecycle: open -> evidence -> mediator -> decision -> resolved via routes", async () => {
    vi.mocked(escrowCoordinator.partialRefundEscrow).mockResolvedValue({
      txHash: "tx-final",
      ledger: 1,
      status: "partial_refunded",
      buyerAddress: "GBUYER",
      refundedAmount: "1000",
      remainingAmount: "0",
    });

    const openRoute = findRoute("POST", "/escrow/42/disputes");
    const openReq = createMockReq(JSON.stringify({ initiatedBy: "GBUYER", reason: "Not delivered" }));
    const openRes = createMockRes();
    await openRoute.handler(openReq, openRes, { escrowId: "42" });
    const disputeId = JSON.parse(openRes.body).data.id as string;

    const evidenceRoute = findRoute("POST", `/disputes/${disputeId}/evidence`);
    const evidenceReq = createMockReq(
      JSON.stringify({ party: "GBUYER", description: "tracking shows no delivery", files: ["ipfs://x"] })
    );
    const evidenceRes = createMockRes();
    await evidenceRoute.handler(evidenceReq, evidenceRes, { disputeId });
    expect(evidenceRes.statusCode).toBe(200);
    expect(JSON.parse(evidenceRes.body).data.status).toBe("evidence_collection");

    const mediatorRoute = findRoute("POST", `/disputes/${disputeId}/mediator`);
    const mediatorReq = createMockReq(JSON.stringify({ mediator: "GMEDIATOR" }));
    const mediatorRes = createMockRes();
    await mediatorRoute.handler(mediatorReq, mediatorRes, { disputeId });
    expect(mediatorRes.statusCode).toBe(200);
    expect(JSON.parse(mediatorRes.body).data.status).toBe("negotiation");

    const decisionRoute = findRoute("POST", `/disputes/${disputeId}/decision`);
    const decisionReq = createMockReq(
      JSON.stringify({
        decision: "full_refund",
        buyerAmount: "1000",
        sellerAmount: "0",
        reasoning: "Confirmed non-delivery",
        mediator: "GMEDIATOR",
      })
    );
    const decisionRes = createMockRes();
    await decisionRoute.handler(decisionReq, decisionRes, { disputeId });
    expect(decisionRes.statusCode).toBe(200);
    expect(JSON.parse(decisionRes.body).data.status).toBe("resolved");

    const getRoute = findRoute("GET", `/disputes/${disputeId}`);
    const getRes = createMockRes();
    await getRoute.handler(createMockReq(""), getRes, { disputeId });
    expect(getRes.statusCode).toBe(200);
    const fetched = JSON.parse(getRes.body).data;
    expect(fetched.status).toBe("resolved");
    expect(Array.isArray(fetched.auditLog)).toBe(true);
    expect(fetched.auditLog.length).toBeGreaterThan(0);
  });

  it("GET /disputes/:disputeId returns 404 for an unknown dispute", async () => {
    const route = findRoute("GET", "/disputes/does-not-exist");
    const res = createMockRes();
    await route.handler(createMockReq(""), res, { disputeId: "does-not-exist" });
    expect(res.statusCode).toBe(404);
  });

  // Issue #350 — IDOR mitigation.
  it("GET /disputes/:disputeId returns 403 when the requester is not a party to the order", async () => {
    const openRoute = findRoute("POST", "/escrow/42/disputes");
    const openReq = createMockReq(JSON.stringify({ initiatedBy: "GBUYER", reason: "Not delivered" }));
    const openRes = createMockRes();
    await openRoute.handler(openReq, openRes, { escrowId: "42" });
    const disputeId = JSON.parse(openRes.body).data.id as string;

    vi.mocked(findPaymentRecordByEscrowId).mockResolvedValue({
      id: "pr-1",
      orderId: "order-1",
      escrowId: "42",
      escrowContractId: "C...",
      buyerAddress: "GBUYER",
      sellerAddress: "GSELLER",
      tokenContractId: "T...",
      amountStroops: "1000",
      status: "disputed",
      fundTxHash: null,
      releaseTxHash: null,
      refundTxHash: null,
      disputeTxHash: null,
      releasedAmountStroops: "0",
      refundedAmountStroops: "0",
      failureReason: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any);

    const getRoute = findRoute("GET", `/disputes/${disputeId}`);
    const res = createMockRes();
    await getRoute.handler(
      createMockReq("", { "x-requester-address": "GATTACKER" }),
      res,
      { disputeId }
    );

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error.code).toBe("FORBIDDEN");
  });

  it("GET /disputes/:disputeId returns 200 when the requester is a party to the order", async () => {
    const openRoute = findRoute("POST", "/escrow/42/disputes");
    const openReq = createMockReq(JSON.stringify({ initiatedBy: "GBUYER", reason: "Not delivered" }));
    const openRes = createMockRes();
    await openRoute.handler(openReq, openRes, { escrowId: "42" });
    const disputeId = JSON.parse(openRes.body).data.id as string;

    vi.mocked(findPaymentRecordByEscrowId).mockResolvedValue({
      id: "pr-1",
      orderId: "order-1",
      escrowId: "42",
      escrowContractId: "C...",
      buyerAddress: "GBUYER",
      sellerAddress: "GSELLER",
      tokenContractId: "T...",
      amountStroops: "1000",
      status: "disputed",
      fundTxHash: null,
      releaseTxHash: null,
      refundTxHash: null,
      disputeTxHash: null,
      releasedAmountStroops: "0",
      refundedAmountStroops: "0",
      failureReason: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any);

    const getRoute = findRoute("GET", `/disputes/${disputeId}`);
    const res = createMockRes();
    await getRoute.handler(
      createMockReq("", { "x-requester-address": "GBUYER" }),
      res,
      { disputeId }
    );

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.id).toBe(disputeId);
  });

  it("POST /disputes/:disputeId/decision returns 409 before the dispute reaches negotiation", async () => {
    const openRoute = findRoute("POST", "/escrow/42/disputes");
    const openReq = createMockReq(JSON.stringify({ initiatedBy: "GBUYER", reason: "x" }));
    const openRes = createMockRes();
    await openRoute.handler(openReq, openRes, { escrowId: "42" });
    const disputeId = JSON.parse(openRes.body).data.id as string;

    const decisionRoute = findRoute("POST", `/disputes/${disputeId}/decision`);
    const decisionReq = createMockReq(
      JSON.stringify({
        decision: "full_refund",
        buyerAmount: "1000",
        sellerAmount: "0",
        reasoning: "x",
        mediator: "GMEDIATOR",
      })
    );
    const decisionRes = createMockRes();
    await decisionRoute.handler(decisionReq, decisionRes, { disputeId });

    expect(decisionRes.statusCode).toBe(409);
    expect(JSON.parse(decisionRes.body).error.code).toBe("INVALID_STATE_TRANSITION");
  });
});
