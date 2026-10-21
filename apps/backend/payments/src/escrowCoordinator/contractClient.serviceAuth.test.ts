import { afterEach, describe, expect, it, vi } from "vitest";
import { SERVICE_AUTH_HEADER } from "@delegolabs/utils";
import { submitContractInvocation } from "./contractClient.js";

const originalServiceToken = process.env.PAYMENTS_WALLET_SERVICE_TOKEN;
const originalWalletUrl = process.env.WALLET_URL;

describe("escrow coordinator Wallet service authentication", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalServiceToken === undefined) delete process.env.PAYMENTS_WALLET_SERVICE_TOKEN;
    else process.env.PAYMENTS_WALLET_SERVICE_TOKEN = originalServiceToken;
    if (originalWalletUrl === undefined) delete process.env.WALLET_URL;
    else process.env.WALLET_URL = originalWalletUrl;
  });

  it("sends the Payments service token for coordinator transactions", async () => {
    process.env.PAYMENTS_WALLET_SERVICE_TOKEN = "payments-wallet-test-token";
    process.env.WALLET_URL = "http://wallet.test";
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: { hash: "tx-hash", ledger: 5, success: true },
      error: null,
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await submitContractInvocation({
      sourceAddress: "GSettlementCaller",
      contractId: "CEscrowContract",
      method: "dispute",
      args: [1],
      memo: "dispute",
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://wallet.test/transactions/submit");
    expect(init.headers).toMatchObject({ [SERVICE_AUTH_HEADER]: "payments-wallet-test-token" });
    expect(JSON.parse(init.body as string)).not.toHaveProperty("userId");
  });

  it("fails closed when the Payments service token is absent", async () => {
    delete process.env.PAYMENTS_WALLET_SERVICE_TOKEN;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitContractInvocation({
      sourceAddress: "GSettlementCaller",
      contractId: "CEscrowContract",
      method: "dispute",
      args: [1],
      memo: "dispute",
    })).rejects.toThrow("PAYMENTS_WALLET_SERVICE_TOKEN is not configured");

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
