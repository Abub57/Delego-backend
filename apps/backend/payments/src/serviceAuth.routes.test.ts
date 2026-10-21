import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SERVICE_AUTH_HEADER, type Route } from "@delegolabs/utils";
import { escrowService } from "../escrow/index.js";
import { registerRoutes } from "./routes.js";

const originalServiceToken = process.env.ORCHESTRATOR_PAYMENTS_SERVICE_TOKEN;
const originalEscrowContractId = process.env.ESCROW_CONTRACT_ID;

type MockResponse = ServerResponse & { statusCode: number; body: string };

function createMockReq(
  body: string,
  headers: Record<string, string> = {},
): IncomingMessage & { userId?: string } {
  const req = new EventEmitter() as unknown as IncomingMessage & { userId?: string };
  req.headers = { "content-type": "application/json", ...headers };
  process.nextTick(() => {
    req.emit("data", Buffer.from(body));
    req.emit("end");
  });
  return req;
}

function createMockRes(): MockResponse {
  return {
    statusCode: 0,
    body: "",
    writeHead(status: number) {
      this.statusCode = status;
    },
    setHeader() {},
    end(body?: string) {
      if (body !== undefined) this.body = body;
    },
  } as MockResponse;
}

function findDepositRoute(): Route {
  const route = registerRoutes().find(
    (candidate) => candidate.method === "POST" && candidate.pattern.test("/escrow/deposit"),
  );
  if (!route) throw new Error("POST /escrow/deposit route is not registered");
  return route;
}

describe("POST /escrow/deposit service authentication", () => {
  beforeEach(() => {
    process.env.ORCHESTRATOR_PAYMENTS_SERVICE_TOKEN = "orchestrator-payments-test-token";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalServiceToken === undefined) delete process.env.ORCHESTRATOR_PAYMENTS_SERVICE_TOKEN;
    else process.env.ORCHESTRATOR_PAYMENTS_SERVICE_TOKEN = originalServiceToken;
    if (originalEscrowContractId === undefined) delete process.env.ESCROW_CONTRACT_ID;
    else process.env.ESCROW_CONTRACT_ID = originalEscrowContractId;
  });

  it.each([undefined, "invalid-token"])("rejects missing or invalid service credentials (%s)", async (token) => {
    const headers = token === undefined ? {} : { [SERVICE_AUTH_HEADER]: token };
    const req = createMockReq("{}", {
      ...headers,
      "x-delego-user-id": "authenticated-user",
      "idempotency-key": "checkout-order-1",
    });
    const res = createMockRes();

    await findDepositRoute().handler(req, res, {});

    expect(res.statusCode).toBe(401);
    expect((req as IncomingMessage & { userId?: string }).userId).toBeUndefined();
  });

  it("fails closed when the expected service token is not configured", async () => {
    delete process.env.ORCHESTRATOR_PAYMENTS_SERVICE_TOKEN;
    const req = createMockReq("{}", { [SERVICE_AUTH_HEADER]: "" });
    const res = createMockRes();

    await findDepositRoute().handler(req, res, {});

    expect(res.statusCode).toBe(503);
    expect((req as IncomingMessage & { userId?: string }).userId).toBeUndefined();
  });

  it("reads user identity only after service authentication succeeds", async () => {
    const req = createMockReq("{}", {
      [SERVICE_AUTH_HEADER]: "orchestrator-payments-test-token",
      "x-delego-user-id": "authenticated-user",
      "idempotency-key": "checkout-order-1",
    });
    const res = createMockRes();

    await findDepositRoute().handler(req, res, {});

    // Authentication passed and populated the trusted request context; then
    // the existing deposit validation rejects the intentionally empty body.
    expect((req as IncomingMessage & { userId?: string }).userId).toBe("authenticated-user");
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects a missing user context after authenticating the service", async () => {
    const req = createMockReq("{}", {
      [SERVICE_AUTH_HEADER]: "orchestrator-payments-test-token",
      "idempotency-key": "checkout-order-1",
    });
    const res = createMockRes();

    await findDepositRoute().handler(req, res, {});

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.message).toContain("X-Delego-User-Id");
  });

  it("passes only the service-authenticated user ID into the escrow workflow", async () => {
    process.env.ESCROW_CONTRACT_ID = `C${"A".repeat(55)}`;
    const deposit = vi.spyOn(escrowService, "deposit").mockResolvedValue({
      txHash: "tx-hash",
      ledger: 5,
      success: true,
    });
    const req = createMockReq(JSON.stringify({
      sourceAddress: `G${"A".repeat(55)}`,
      buyerAddress: `G${"B".repeat(55)}`,
      sellerAddress: `G${"C".repeat(55)}`,
      userId: "attacker-user",
    }), {
      [SERVICE_AUTH_HEADER]: "orchestrator-payments-test-token",
      "x-delego-user-id": "authenticated-user",
      "idempotency-key": "checkout-order-2",
    });
    const res = createMockRes();

    await findDepositRoute().handler(req, res, {});

    expect(res.statusCode).toBe(200);
    expect(deposit).toHaveBeenCalledWith(expect.objectContaining({
      sourceAddress: `G${"A".repeat(55)}`,
      userId: "authenticated-user",
    }));
    expect(deposit.mock.calls[0][0]).not.toHaveProperty("userId", "attacker-user");
  });
});
