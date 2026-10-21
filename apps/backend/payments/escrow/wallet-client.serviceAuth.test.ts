import { afterEach, describe, expect, it, vi } from "vitest";
import { SERVICE_AUTH_HEADER } from "@delegolabs/utils";

vi.mock("./feeEstimator.js", () => ({
  estimateTransactionFee: vi.fn().mockResolvedValue({
    source: "horizon",
    baseFeeStroops: 100,
    recommendedFeeStroops: 100,
    percentile: "p95",
    fetchedAt: "2026-01-01T00:00:00.000Z",
  }),
}));

import { submitContractCall } from "./wallet-client.js";

const originalServiceToken = process.env.PAYMENTS_WALLET_SERVICE_TOKEN;
const originalWalletUrl = process.env.WALLET_URL;

describe("Payments Wallet client service authentication", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalServiceToken === undefined) delete process.env.PAYMENTS_WALLET_SERVICE_TOKEN;
    else process.env.PAYMENTS_WALLET_SERVICE_TOKEN = originalServiceToken;
    if (originalWalletUrl === undefined) delete process.env.WALLET_URL;
    else process.env.WALLET_URL = originalWalletUrl;
  });

  it("sends the service token and authenticated user ID without adding userId to the body", async () => {
    process.env.PAYMENTS_WALLET_SERVICE_TOKEN = "payments-wallet-test-token";
    process.env.WALLET_URL = "http://wallet.test";
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: { hash: "tx-hash", ledger: 5, success: true },
      error: null,
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await submitContractCall({
      sourceAddress: "GSource",
      contractId: "CContract",
      method: "create_escrow",
      args: [],
      memo: "checkout",
      userId: "authenticated-user",
    });

    expect(result.hash).toBe("tx-hash");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://wallet.test/transactions/submit");
    expect(init.headers).toMatchObject({
      [SERVICE_AUTH_HEADER]: "payments-wallet-test-token",
      "x-delego-user-id": "authenticated-user",
    });
    expect(JSON.parse(init.body as string)).not.toHaveProperty("userId");
  });

  it("sends service authentication for system operations without inventing a user ID", async () => {
    process.env.PAYMENTS_WALLET_SERVICE_TOKEN = "payments-wallet-test-token";
    process.env.WALLET_URL = "http://wallet.test";
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: { hash: "tx-hash", ledger: 5, success: true },
      error: null,
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await submitContractCall({
      sourceAddress: "GSource",
      contractId: "CContract",
      method: "release",
      args: [1],
      memo: "system release",
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toMatchObject({ [SERVICE_AUTH_HEADER]: "payments-wallet-test-token" });
    expect(init.headers).not.toHaveProperty("x-delego-user-id");
    expect(JSON.parse(init.body as string)).not.toHaveProperty("userId");
  });

  it("fails before sending when the Payments service token is missing", async () => {
    delete process.env.PAYMENTS_WALLET_SERVICE_TOKEN;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitContractCall({
      sourceAddress: "GSource",
      contractId: "CContract",
      method: "release",
      args: [1],
      memo: "system release",
    })).rejects.toThrow("PAYMENTS_WALLET_SERVICE_TOKEN is not configured");

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
