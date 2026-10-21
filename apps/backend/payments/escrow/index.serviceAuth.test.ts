import { afterEach, describe, expect, it, vi } from "vitest";

const submitContractCall = vi.hoisted(() => vi.fn().mockResolvedValue({
  hash: "tx-hash",
  ledger: 5,
  success: true,
}));

vi.mock("./wallet-client.js", () => ({ submitContractCall }));

import { escrowService } from "./index.js";

const originalContractId = process.env.ESCROW_CONTRACT_ID;

describe("escrow deposit propagates authenticated user identity", () => {
  afterEach(() => {
    if (originalContractId === undefined) delete process.env.ESCROW_CONTRACT_ID;
    else process.env.ESCROW_CONTRACT_ID = originalContractId;
    submitContractCall.mockClear();
  });

  it("passes the server-authenticated user ID to the Wallet client", async () => {
    process.env.ESCROW_CONTRACT_ID = `C${"A".repeat(55)}`;

    await escrowService.deposit({
      sourceAddress: `G${"A".repeat(55)}`,
      buyerAddress: `G${"B".repeat(55)}`,
      sellerAddress: `G${"C".repeat(55)}`,
      orderId: "order-1",
      userId: "authenticated-user",
    });

    expect(submitContractCall).toHaveBeenCalledWith(expect.objectContaining({
      method: "create_escrow",
      userId: "authenticated-user",
    }));
  });
});
