import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SERVICE_AUTH_HEADER } from "@delegolabs/utils";
import { InMemorySagaStore } from "../../src/saga/memory-store.js";
import {
  checkoutWorkflow,
  createCheckoutSagaCoordinator,
  createCheckoutWorkflowInput,
} from "./index.js";

const originalServiceToken = process.env.ORCHESTRATOR_PAYMENTS_SERVICE_TOKEN;
const originalPaymentsUrl = process.env.PAYMENTS_URL;

describe("checkout Payments service authentication", () => {
  beforeEach(() => {
    process.env.ORCHESTRATOR_PAYMENTS_SERVICE_TOKEN = "orchestrator-payments-test-token";
    process.env.PAYMENTS_URL = "http://payments.test";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalServiceToken === undefined) delete process.env.ORCHESTRATOR_PAYMENTS_SERVICE_TOKEN;
    else process.env.ORCHESTRATOR_PAYMENTS_SERVICE_TOKEN = originalServiceToken;
    if (originalPaymentsUrl === undefined) delete process.env.PAYMENTS_URL;
    else process.env.PAYMENTS_URL = originalPaymentsUrl;
  });

  it("uses the authenticated user ID instead of a body-supplied userId", () => {
    const publicBody = {
      orderId: "order-1",
      sourceAddress: "GSource",
      buyerAddress: "GBuyer",
      sellerAddress: "GSeller",
      userId: "attacker-user",
    };

    const input = createCheckoutWorkflowInput(publicBody, "authenticated-user");

    expect(input.userId).toBe("authenticated-user");
    expect(input.userId).not.toBe(publicBody.userId);
  });

  it("sends the service token and authenticated user ID to Payments", async () => {
    const response = new Response(JSON.stringify({
      data: { txHash: "tx-1", ledger: 7, success: true, escrowId: "escrow-1" },
      error: null,
    }), { status: 200, headers: { "Content-Type": "application/json" } });
    const fetchMock = vi.fn().mockResolvedValue(response);
    vi.stubGlobal("fetch", fetchMock);

    const publicBody = {
      orderId: "order-2",
      sourceAddress: "GSource",
      buyerAddress: "GBuyer",
      sellerAddress: "GSeller",
      userId: "body-supplied-user",
    };
    const input = createCheckoutWorkflowInput(publicBody, "authenticated-user");
    const result = await checkoutWorkflow(
      input,
      createCheckoutSagaCoordinator(new InMemorySagaStore()),
      "checkout:order-2",
    );

    expect(result.status).toBe("completed");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://payments.test/escrow/deposit");
    expect(init.headers).toMatchObject({
      [SERVICE_AUTH_HEADER]: "orchestrator-payments-test-token",
      "x-delego-user-id": "authenticated-user",
    });
    expect(JSON.parse(init.body as string)).not.toHaveProperty("userId");
  });
});
