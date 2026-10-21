import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Keypair } from "@stellar/stellar-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requireAuth, SERVICE_AUTH_HEADER, type Route } from "@delegolabs/utils";

const { findWallet, submitTransaction } = vi.hoisted(() => ({
  findWallet: vi.fn(),
  submitTransaction: vi.fn(),
}));

vi.mock("./models/Wallet.js", () => ({ Wallet: { findOne: findWallet } }));
vi.mock("../transactions/index.js", () => ({
  transactionService: { submit: submitTransaction, simulate: vi.fn() },
}));

import { registerRoutes } from "./routes.js";

const originalServiceToken = process.env.PAYMENTS_WALLET_SERVICE_TOKEN;
const originalEscrowContractId = process.env.ESCROW_CONTRACT_ID;
const sourceAddress = Keypair.random().publicKey();
const escrowContractId = `C${"A".repeat(55)}`;

type MockResponse = ServerResponse & { statusCode: number; body: string };

function createRequest(body: string, headers: Record<string, string> = {}): IncomingMessage {
  const req = new EventEmitter() as unknown as IncomingMessage;
  req.headers = { "content-type": "application/json", ...headers };
  process.nextTick(() => {
    req.emit("data", Buffer.from(body));
    req.emit("end");
  });
  return req;
}

function createResponse(): MockResponse {
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

function findSubmitRoute(): Route {
  const route = registerRoutes().find(
    (candidate) => candidate.method === "POST" && candidate.pattern.test("/transactions/submit"),
  );
  if (!route) throw new Error("POST /transactions/submit route is not registered");
  return route;
}

function authenticatedHeaders(userId?: string): Record<string, string> {
  return {
    [SERVICE_AUTH_HEADER]: "payments-wallet-test-token",
    ...(userId ? { "x-delego-user-id": userId } : {}),
  };
}

describe("POST /transactions/submit service authentication and ownership", () => {
  beforeEach(() => {
    process.env.PAYMENTS_WALLET_SERVICE_TOKEN = "payments-wallet-test-token";
    process.env.ESCROW_CONTRACT_ID = escrowContractId;
    findWallet.mockReset();
    submitTransaction.mockReset();
    submitTransaction.mockResolvedValue({ hash: "tx-hash", ledger: 1, success: true });
  });

  afterEach(() => {
    if (originalServiceToken === undefined) delete process.env.PAYMENTS_WALLET_SERVICE_TOKEN;
    else process.env.PAYMENTS_WALLET_SERVICE_TOKEN = originalServiceToken;
    if (originalEscrowContractId === undefined) delete process.env.ESCROW_CONTRACT_ID;
    else process.env.ESCROW_CONTRACT_ID = originalEscrowContractId;
  });

  it.each([undefined, "invalid-token"])("rejects missing or invalid service token (%s)", async (token) => {
    const headers = token ? { [SERVICE_AUTH_HEADER]: token } : {};
    const req = createRequest("{}", headers);
    const res = createResponse();

    await findSubmitRoute().handler(req, res, {});

    expect(res.statusCode).toBe(401);
    expect(findWallet).not.toHaveBeenCalled();
    expect(submitTransaction).not.toHaveBeenCalled();
  });

  it("rejects a user JWT alone because this route requires service authentication", async () => {
    const req = createRequest("{}", { authorization: "Bearer user-jwt" });
    const res = createResponse();

    await findSubmitRoute().handler(req, res, {});

    expect(res.statusCode).toBe(401);
    expect(submitTransaction).not.toHaveBeenCalled();
  });

  it("rejects an internal release when its Payments service token is missing", async () => {
    const req = createRequest(JSON.stringify({
      sourceAddress,
      contractId: escrowContractId,
      method: "release",
      args: [1],
    }));
    const res = createResponse();

    await findSubmitRoute().handler(req, res, {});

    expect(res.statusCode).toBe(401);
    expect(submitTransaction).not.toHaveBeenCalled();
  });

  it("rejects checkout when the propagated user ID is missing, even if body userId is supplied", async () => {
    const req = createRequest(JSON.stringify({
      sourceAddress,
      contractId: escrowContractId,
      method: "create_escrow",
      args: [],
      userId: "attacker-user",
    }), authenticatedHeaders());
    const res = createResponse();

    await findSubmitRoute().handler(req, res, {});

    expect(res.statusCode).toBe(401);
    expect(findWallet).not.toHaveBeenCalled();
    expect(submitTransaction).not.toHaveBeenCalled();
  });

  it("rejects a source address without a stored wallet before submission", async () => {
    findWallet.mockResolvedValue(null);
    const req = createRequest(JSON.stringify({ sourceAddress, contractId: escrowContractId, method: "create_escrow", args: [] }), authenticatedHeaders("user-1"));
    const res = createResponse();

    await findSubmitRoute().handler(req, res, {});

    expect(res.statusCode).toBe(404);
    expect(findWallet).toHaveBeenCalledWith({ where: { stellarAddress: sourceAddress } });
    expect(submitTransaction).not.toHaveBeenCalled();
  });

  it("rejects a wallet owned by a different user before submission", async () => {
    findWallet.mockResolvedValue({ id: "wallet-1", userId: "owner-1", stellarAddress: sourceAddress });
    const req = createRequest(JSON.stringify({ sourceAddress, contractId: escrowContractId, method: "create_escrow", args: [] }), authenticatedHeaders("user-2"));
    const res = createResponse();

    await findSubmitRoute().handler(req, res, {});

    expect(res.statusCode).toBe(403);
    expect(submitTransaction).not.toHaveBeenCalled();
  });

  it("submits only when the wallet belongs to the propagated user", async () => {
    findWallet.mockResolvedValue({ id: "wallet-1", userId: "user-1", stellarAddress: sourceAddress });
    const req = createRequest(JSON.stringify({ sourceAddress, contractId: escrowContractId, method: "create_escrow", args: [] }), authenticatedHeaders("user-1"));
    const res = createResponse();

    await findSubmitRoute().handler(req, res, {});

    expect(res.statusCode).toBe(200);
    expect(submitTransaction).toHaveBeenCalledWith(expect.objectContaining({
      sourceAddress,
      userId: "user-1",
      walletId: "wallet-1",
    }));
  });

  it("rejects create_escrow against a different contract instead of skipping ownership", async () => {
    const req = createRequest(JSON.stringify({
      sourceAddress,
      contractId: `C${"B".repeat(55)}`,
      method: "create_escrow",
      args: [],
    }), authenticatedHeaders("user-1"));
    const res = createResponse();

    await findSubmitRoute().handler(req, res, {});

    expect(res.statusCode).toBe(403);
    expect(findWallet).not.toHaveBeenCalled();
    expect(submitTransaction).not.toHaveBeenCalled();
  });

  it("allows a service-authenticated system operation without fabricating user ownership", async () => {
    const req = createRequest(JSON.stringify({
      sourceAddress,
      contractId: escrowContractId,
      method: "release",
      args: [1],
    }), authenticatedHeaders());
    const res = createResponse();

    await findSubmitRoute().handler(req, res, {});

    expect(res.statusCode).toBe(200);
    expect(findWallet).not.toHaveBeenCalled();
    expect(submitTransaction).toHaveBeenCalledOnce();
    expect(submitTransaction.mock.calls[0][0]).not.toHaveProperty("userId");
  });
});

describe("Wallet global JWT middleware configuration", () => {
  const originalJwtSecret = process.env.JWT_SECRET;

  beforeEach(() => {
    process.env.JWT_SECRET = "test-secret-key-minimum-32-chars-long";
  });

  afterEach(() => {
    if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalJwtSecret;
  });

  it("bypasses JWT only for the service-authenticated submit path and protects other routes", () => {
    const middleware = requireAuth({
      publicPaths: ["/health", "/vapid-public-key", "/transactions/submit"],
    });
    const nextSubmit = vi.fn();
    const submitReq = createRequest("{}");
    submitReq.url = "/transactions/submit";
    middleware(submitReq, createResponse(), nextSubmit);
    expect(nextSubmit).toHaveBeenCalledOnce();

    const nextWallet = vi.fn();
    const walletReq = createRequest("{}");
    walletReq.url = "/wallets";
    const walletRes = createResponse();
    middleware(walletReq, walletRes, nextWallet);
    expect(walletRes.statusCode).toBe(401);
    expect(nextWallet).not.toHaveBeenCalled();
  });
});
