import { describe, it, expect, vi, beforeEach } from "vitest";
import { SorobanEventIndexer } from "./sorobanEventIndexer";

vi.mock("@stellar/stellar-sdk", () => {
  return {
    rpc: {
      Server: vi.fn().mockImplementation(() => ({
        getEvents: vi.fn().mockResolvedValue({
          events: [
            {
              ledger: 100,
              ledgerClosedAt: "2026-10-21T00:00:00Z",
              txHash: "0xabc123",
              topic: ["AAAAAQ==", "AAAAAg=="],
              value: "AAAAAw==",
            },
          ],
        }),
      })),
    },
    xdr: {
      ScVal: {
        fromXDR: vi.fn().mockImplementation((val) => val),
      },
    },
    scValToNative: vi.fn().mockImplementation((val) => {
      if (val === "AAAAAQ==") return "EscrowFunded";
      if (val === "AAAAAg==") return "order-999";
      return { merchantAddress: "G_MERCHANT", buyerAddress: "G_BUYER", amountStroops: "10000000" };
    }),
  };
});

describe("SorobanEventIndexer (#598)", () => {
  let indexer: SorobanEventIndexer;

  beforeEach(() => {
    indexer = new SorobanEventIndexer({
      rpcUrl: "https://soroban-testnet.stellar.org",
      startLedger: 90,
    });
  });

  it("successfully parses typed escrow events from Soroban RPC output", async () => {
    const res = await indexer.pollEvents({
      startLedger: 90,
      contractIds: ["C_ESCROW_CONTRACT"],
      topics: [],
    });

    expect(res.events).toHaveLength(1);
    expect(res.events[0]).toMatchObject({
      ledger: 100,
      eventType: "EscrowFunded",
      orderId: "order-999",
      merchantAddress: "G_MERCHANT",
      buyerAddress: "G_BUYER",
      amountStroops: "10000000",
    });
    expect(res.latestLedger).toBe(100);
  });
});
