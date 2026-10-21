import { describe, it, expect, vi, beforeEach } from "vitest";
import { ContainerRolloutVerifier } from "./containerDigest.js";
import * as childProcess from "child_process";

vi.mock("child_process", () => ({
  exec: vi.fn(),
}));

describe("ContainerRolloutVerifier", () => {
  let verifier: ContainerRolloutVerifier;

  beforeEach(() => {
    verifier = new ContainerRolloutVerifier();
    vi.clearAllMocks();
  });

  describe("inspectImageDigest", () => {
    it("should return the digest from docker inspect", async () => {
      const mockExec = vi.mocked(childProcess.exec);
      mockExec.mockImplementation((cmd: any, cb: any) => {
        if (typeof cb === "function") {
          cb(null, "my-image@sha256:1234567890abcdef\n", "");
        }
        return {} as any;
      });

      const digest = await verifier.inspectImageDigest("my-image:latest");
      expect(digest).toBe("sha256:1234567890abcdef");
      expect(mockExec).toHaveBeenCalledWith(
        `docker inspect --format="{{index .RepoDigests 0}}" my-image:latest`,
        expect.any(Function)
      );
    });

    it("should handle digest without @ symbol", async () => {
      const mockExec = vi.mocked(childProcess.exec);
      mockExec.mockImplementation((cmd: any, cb: any) => {
        if (typeof cb === "function") {
          cb(null, "sha256:abcdef1234567890\n", "");
        }
        return {} as any;
      });

      const digest = await verifier.inspectImageDigest("my-image:latest");
      expect(digest).toBe("sha256:abcdef1234567890");
    });

    it("should throw error if docker inspect fails", async () => {
      const mockExec = vi.mocked(childProcess.exec);
      mockExec.mockImplementation((cmd: any, cb: any) => {
        if (typeof cb === "function") {
          cb(new Error("Docker not running"), "", "Docker not running");
        }
        return {} as any;
      });

      await expect(verifier.inspectImageDigest("my-image:latest")).rejects.toThrow(
        /Failed to inspect image digest for my-image:latest/
      );
    });

    it("should throw error if no digest found", async () => {
      const mockExec = vi.mocked(childProcess.exec);
      mockExec.mockImplementation((cmd: any, cb: any) => {
        if (typeof cb === "function") {
          cb(null, "<no value>\n", "");
        }
        return {} as any;
      });

      await expect(verifier.inspectImageDigest("my-image:latest")).rejects.toThrow(
        /No digest found for image my-image:latest/
      );
    });
  });

  describe("verifyDigestBeforeRollout", () => {
    it("should return verification object if digest matches", async () => {
      vi.spyOn(verifier, "inspectImageDigest").mockResolvedValue("sha256:123");

      const result = await verifier.verifyDigestBeforeRollout("my-image:latest", "sha256:123");
      expect(result).toEqual({
        imageName: "my-image:latest",
        expectedDigest: "sha256:123",
        verified: true,
      });
    });

    it("should throw error and block rollout if digest mismatch", async () => {
      vi.spyOn(verifier, "inspectImageDigest").mockResolvedValue("sha256:abc");

      await expect(
        verifier.verifyDigestBeforeRollout("my-image:latest", "sha256:123")
      ).rejects.toThrow(/Rollout blocked: Digest mismatch for image my-image:latest/);
    });
  });
});

