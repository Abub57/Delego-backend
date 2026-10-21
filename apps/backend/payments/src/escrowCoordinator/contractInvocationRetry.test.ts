import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TransactionRequest } from "@delegolabs/types";
import {
  isTransientNetworkError,
  submitContractInvocationWithRetry,
} from "./contractInvocationRetry.js";
import { submitContractInvocation } from "./contractClient.js";

vi.mock("./contractClient.js", () => ({
  submitContractInvocation: vi.fn(),
}));

const request: TransactionRequest = {
  sourceAddress: "GBUYERADDRESS0000000000000000000000000000000000000000000000",
  contractId: "CCONTRACTID00000000000000000000000000000000000000000000000",
  method: "deposit",
  args: [],
  memo: "Fund escrow for order order-1",
};

const success = { hash: "tx-1", ledger: 12, success: true };

describe("submitContractInvocationWithRetry", () => {
  beforeEach(() => {
    vi.mocked(submitContractInvocation).mockReset();
  });

  it("retries transient RPC failures with exponential backoff and returns the eventual result", async () => {
    vi.mocked(submitContractInvocation)
      .mockRejectedValueOnce(new Error("Wallet service unavailable: fetch failed"))
      .mockRejectedValueOnce(new Error("Wallet service unavailable: socket hang up"))
      .mockResolvedValueOnce(success);
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await submitContractInvocationWithRetry(request, { sleep });

    expect(result).toEqual(success);
    expect(submitContractInvocation).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 2000);
    expect(sleep).toHaveBeenNthCalledWith(2, 4000);
  });

  it("does not retry contract logic errors and rethrows them immediately", async () => {
    const contractError = new Error("Error(Contract, #35) CollateralRatioBelowMinimum");
    vi.mocked(submitContractInvocation).mockRejectedValue(contractError);
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(submitContractInvocationWithRetry(request, { sleep })).rejects.toBe(contractError);

    expect(submitContractInvocation).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("gives up after 3 retries and rethrows the last transient error", async () => {
    const lastError = new Error("Wallet service unavailable: ECONNREFUSED");
    vi.mocked(submitContractInvocation).mockRejectedValue(lastError);
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(submitContractInvocationWithRetry(request, { sleep })).rejects.toBe(lastError);

    // Initial attempt + 3 retries.
    expect(submitContractInvocation).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledTimes(3);
  });
});

describe("isTransientNetworkError", () => {
  it("classifies connection, timeout and 5xx faults as retryable", () => {
    expect(isTransientNetworkError(new Error("fetch failed"))).toBe(true);
    expect(isTransientNetworkError(new Error("request timed out"))).toBe(true);
    expect(isTransientNetworkError(new Error("Wallet service returned status 503"))).toBe(true);
    expect(isTransientNetworkError(new Error("Wallet service unavailable: ECONNREFUSED"))).toBe(true);
  });

  it("does not classify contract or validation errors as retryable", () => {
    expect(isTransientNetworkError(new Error("Error(Contract, #35) CollateralRatioBelowMinimum"))).toBe(false);
    expect(isTransientNetworkError(new Error("release simulation failed"))).toBe(false);
    expect(isTransientNetworkError(new Error("Invalid escrow ID: abc"))).toBe(false);
  });
});
