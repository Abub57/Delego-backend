import { describe, it, expect, vi } from "vitest";
import { pinProductToIpfs, withIpfsRetry, isTransientIpfsError } from "./ipfsPinningWorker.js";

describe("ipfs pinning worker", () => {
  it("pins metadata and media and writes the CID back to the product record", async () => {
    const client = {
      pinJson: vi.fn().mockResolvedValue({ cid: "bafyjson" }),
      pinFile: vi.fn().mockResolvedValue({ cid: "bafymedia" }),
    };
    const productClient = {
      updateProductIpfsMetadata: vi.fn().mockResolvedValue(undefined),
    };

    const result = await pinProductToIpfs(
      {
        productId: "prod-123",
        mediaUri: "https://cdn.example/media.png",
        metadataJson: { name: "Widget" },
      },
      client,
      productClient
    );

    expect(client.pinJson).toHaveBeenCalledWith({ name: "Widget" });
    expect(client.pinFile).toHaveBeenCalledWith("https://cdn.example/media.png");
    expect(productClient.updateProductIpfsMetadata).toHaveBeenCalledWith("prod-123", result);
    expect(result.cid).toBe("bafyjson");
    expect(result.gatewayUrl).toContain("/ipfs/bafyjson");
  });

  it("retries transient gateway timeouts with exponential backoff", async () => {
    const mockPinJson = vi
      .fn()
      .mockRejectedValueOnce(new Error("IPFS gateway timeout"))
      .mockResolvedValueOnce({ cid: "bafyretry" });

    const result = await withIpfsRetry(() => mockPinJson());

    expect(result).toEqual({ cid: "bafyretry" });
    expect(mockPinJson).toHaveBeenCalledTimes(2);
  });

  it("classifies transient IPFS gateway issues as retryable", () => {
    expect(isTransientIpfsError(new Error("gateway timeout"))).toBe(true);
    expect(isTransientIpfsError(new Error("bad request"))).toBe(false);
  });
});
