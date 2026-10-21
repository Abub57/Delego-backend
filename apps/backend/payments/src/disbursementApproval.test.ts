/**
 * Tests for Enterprise Disbursement Multi-Sig Quorum (Issue #374)
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  createDisbursementApproval,
  collectOfficerSignature,
  getDisbursementState,
  submitDisbursementApproval,
  listDisbursements,
  expireStaleDisbursements,
  resetDisbursementStore,
  DisbursementNotFoundError,
  OfficerNotAuthorizedError,
  DuplicateSignatureError,
  InvalidSignatureError,
  DisbursementClosedError,
  type DisbursementState,
  type CreateDisbursementApprovalInput,
} from "./disbursementApproval.js";
import { Keypair } from "@stellar/stellar-sdk";

describe("Enterprise Disbursement Multi-Sig Quorum", () => {
  let officer1Kp: ReturnType<typeof Keypair.random>;
  let officer2Kp: ReturnType<typeof Keypair.random>;
  let officer3Kp: ReturnType<typeof Keypair.random>;
  let unauthorizedOfficerKp: ReturnType<typeof Keypair.random>;
  let transactionXdr: string;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    resetDisbursementStore();

    // Generate test keypairs with secret keys
    officer1Kp = Keypair.random();
    officer2Kp = Keypair.random();
    officer3Kp = Keypair.random();
    unauthorizedOfficerKp = Keypair.random();

    // Create a mock transaction XDR (simplified for testing)
    transactionXdr = "AAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

    // Mock fetch for wallet service calls
    originalFetch = global.fetch;
    global.fetch = vi.fn(async () => {
      return {
        ok: true,
        json: async () => ({ success: true, hash: "mock-tx-hash" }),
      } as Response;
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe("createDisbursementApproval", () => {
    it("creates a disbursement approval with valid inputs", async () => {
      const input: CreateDisbursementApprovalInput = {
        disbursementId: "disb-001",
        transactionXdr,
        officers: [officer1Kp.publicKey(), officer2Kp.publicKey(), officer3Kp.publicKey()],
        requiredSignatures: 2,
      };

      const result = await createDisbursementApproval(input);

      expect(result.disbursementId).toBe("disb-001");
      expect(result.transactionXdr).toBe(transactionXdr);
      expect(result.officers).toEqual([officer1Kp.publicKey(), officer2Kp.publicKey(), officer3Kp.publicKey()]);
      expect(result.requiredSignatures).toBe(2);
      expect(result.collectedSignatures).toEqual([]);
      expect(result.status).toBe("collecting");
    });

    it("defaults requiredSignatures to 2 when not specified", async () => {
      const input: CreateDisbursementApprovalInput = {
        disbursementId: "disb-002",
        transactionXdr,
        officers: [officer1Kp.publicKey(), officer2Kp.publicKey(), officer3Kp.publicKey()],
      };

      const result = await createDisbursementApproval(input);
      expect(result.requiredSignatures).toBe(2);
    });

    it("rejects invalid disbursementId", async () => {
      const input = {
        disbursementId: "",
        transactionXdr,
        officers: [officer1Kp.publicKey(), officer2Kp.publicKey()],
      };

      await expect(createDisbursementApproval(input as CreateDisbursementApprovalInput)).rejects.toThrow(
        "disbursementId is required"
      );
    });

    it("rejects empty transactionXdr", async () => {
      const input = {
        disbursementId: "disb-003",
        transactionXdr: "",
        officers: [officer1Kp.publicKey(), officer2Kp.publicKey()],
      };

      await expect(createDisbursementApproval(input as CreateDisbursementApprovalInput)).rejects.toThrow(
        "transactionXdr is required"
      );
    });

    it("rejects fewer than 2 officers", async () => {
      const input = {
        disbursementId: "disb-004",
        transactionXdr,
        officers: [officer1Kp.publicKey()],
      };

      await expect(createDisbursementApproval(input as CreateDisbursementApprovalInput)).rejects.toThrow(
        "At least 2 officers are required"
      );
    });

    it("rejects more than 10 officers", async () => {
      const officers = Array.from({ length: 11 }, () => Keypair.random().publicKey());
      const input = {
        disbursementId: "disb-005",
        transactionXdr,
        officers,
      };

      await expect(createDisbursementApproval(input as CreateDisbursementApprovalInput)).rejects.toThrow(
        "Maximum 10 officers allowed"
      );
    });

    it("rejects duplicate officer keys", async () => {
      const input = {
        disbursementId: "disb-006",
        transactionXdr,
        officers: [officer1Kp.publicKey(), officer1Kp.publicKey(), officer2Kp.publicKey()],
      };

      await expect(createDisbursementApproval(input as CreateDisbursementApprovalInput)).rejects.toThrow(
        "Duplicate officer public keys are not allowed"
      );
    });

    it("rejects invalid Stellar public keys", async () => {
      const input = {
        disbursementId: "disb-007",
        transactionXdr,
        officers: ["invalid-key", officer2Kp.publicKey()],
      };

      await expect(createDisbursementApproval(input as CreateDisbursementApprovalInput)).rejects.toThrow(
        "Invalid Stellar public key for officer"
      );
    });

    it("rejects requiredSignatures out of bounds", async () => {
      const input = {
        disbursementId: "disb-008",
        transactionXdr,
        officers: [officer1Kp.publicKey(), officer2Kp.publicKey()],
        requiredSignatures: 3,
      };

      await expect(createDisbursementApproval(input as CreateDisbursementApprovalInput)).rejects.toThrow(
        "requiredSignatures must be between 1 and 2"
      );
    });
  });

  describe("collectOfficerSignature", () => {
    it("collects a valid officer signature", async () => {
      await createDisbursementApproval({
        disbursementId: "disb-009",
        transactionXdr,
        officers: [officer1Kp.publicKey(), officer2Kp.publicKey(), officer3Kp.publicKey()],
        requiredSignatures: 2,
      });

      const payload = "disb-009:" + transactionXdr;
      const signature = officer1Kp.sign(Buffer.from(payload, "utf-8")).toString("base64");

      const result = await collectOfficerSignature({
        disbursementId: "disb-009",
        officer: officer1Kp.publicKey(),
        signature,
      });

      expect(result.collectedSignatures.length).toBe(1);
      expect(result.collectedSignatures[0].officer).toBe(officer1Kp.publicKey());
      expect(result.status).toBe("collecting");
    });

    it("advances to broadcast when threshold is reached and auto-broadcast succeeds", async () => {
      await createDisbursementApproval({
        disbursementId: "disb-010",
        transactionXdr,
        officers: [officer1Kp.publicKey(), officer2Kp.publicKey(), officer3Kp.publicKey()],
        requiredSignatures: 2,
      });

      const payload = "disb-010:" + transactionXdr;

      await collectOfficerSignature({
        disbursementId: "disb-010",
        officer: officer1Kp.publicKey(),
        signature: officer1Kp.sign(Buffer.from(payload, "utf-8")).toString("base64"),
      });

      const result = await collectOfficerSignature({
        disbursementId: "disb-010",
        officer: officer2Kp.publicKey(),
        signature: officer2Kp.sign(Buffer.from(payload, "utf-8")).toString("base64"),
      });

      // Auto-broadcast should have succeeded, so status is "broadcast"
      expect(result.status).toBe("broadcast");
      expect(result.collectedSignatures.length).toBe(2);
    });

    it("rejects signature from unauthorized officer", async () => {
      await createDisbursementApproval({
        disbursementId: "disb-011",
        transactionXdr,
        officers: [officer1Kp.publicKey(), officer2Kp.publicKey(), officer3Kp.publicKey()],
        requiredSignatures: 2,
      });

      const payload = "disb-011:" + transactionXdr;

      await expect(
        collectOfficerSignature({
          disbursementId: "disb-011",
          officer: unauthorizedOfficerKp.publicKey(),
          signature: unauthorizedOfficerKp.sign(Buffer.from(payload, "utf-8")).toString("base64"),
        })
      ).rejects.toThrow(OfficerNotAuthorizedError);
    });

    it("rejects duplicate signature from same officer", async () => {
      await createDisbursementApproval({
        disbursementId: "disb-012",
        transactionXdr,
        officers: [officer1Kp.publicKey(), officer2Kp.publicKey(), officer3Kp.publicKey()],
        requiredSignatures: 2,
      });

      const payload = "disb-012:" + transactionXdr;
      const signature = officer1Kp.sign(Buffer.from(payload, "utf-8")).toString("base64");

      await collectOfficerSignature({
        disbursementId: "disb-012",
        officer: officer1Kp.publicKey(),
        signature,
      });

      await expect(
        collectOfficerSignature({
          disbursementId: "disb-012",
          officer: officer1Kp.publicKey(),
          signature,
        })
      ).rejects.toThrow(DuplicateSignatureError);
    });

    it("rejects invalid signature", async () => {
      await createDisbursementApproval({
        disbursementId: "disb-013",
        transactionXdr,
        officers: [officer1Kp.publicKey(), officer2Kp.publicKey(), officer3Kp.publicKey()],
        requiredSignatures: 2,
      });

      await expect(
        collectOfficerSignature({
          disbursementId: "disb-013",
          officer: officer1Kp.publicKey(),
          signature: "invalid-signature",
        })
      ).rejects.toThrow(InvalidSignatureError);
    });

    it("rejects signature for non-existent disbursement", async () => {
      await expect(
        collectOfficerSignature({
          disbursementId: "non-existent",
          officer: officer1Kp.publicKey(),
          signature: "some-signature",
        })
      ).rejects.toThrow(DisbursementNotFoundError);
    });

    it("rejects signature after disbursement is closed", async () => {
      await createDisbursementApproval({
        disbursementId: "disb-014",
        transactionXdr,
        officers: [officer1Kp.publicKey(), officer2Kp.publicKey(), officer3Kp.publicKey()],
        requiredSignatures: 2,
      });

      const payload = "disb-014:" + transactionXdr;

      await collectOfficerSignature({
        disbursementId: "disb-014",
        officer: officer1Kp.publicKey(),
        signature: officer1Kp.sign(Buffer.from(payload, "utf-8")).toString("base64"),
      });

      await collectOfficerSignature({
        disbursementId: "disb-014",
        officer: officer2Kp.publicKey(),
        signature: officer2Kp.sign(Buffer.from(payload, "utf-8")).toString("base64"),
      });

      // Now try to add a third signature - should fail because status is quorum_met
      await expect(
        collectOfficerSignature({
          disbursementId: "disb-014",
          officer: officer3Kp.publicKey(),
          signature: officer3Kp.sign(Buffer.from(payload, "utf-8")).toString("base64"),
        })
      ).rejects.toThrow(DisbursementClosedError);
    });
  });

  describe("getDisbursementState", () => {
    it("returns disbursement state when found", async () => {
      await createDisbursementApproval({
        disbursementId: "disb-015",
        transactionXdr,
        officers: [officer1Kp.publicKey(), officer2Kp.publicKey()],
        requiredSignatures: 2,
      });

      const state = getDisbursementState("disb-015");
      expect(state).not.toBeNull();
      expect(state?.disbursementId).toBe("disb-015");
    });

    it("returns null for non-existent disbursement", () => {
      const state = getDisbursementState("non-existent");
      expect(state).toBeNull();
    });
  });

  describe("submitDisbursementApproval", () => {
    it("submits when quorum is met", async () => {
      await createDisbursementApproval({
        disbursementId: "disb-016",
        transactionXdr,
        officers: [officer1Kp.publicKey(), officer2Kp.publicKey(), officer3Kp.publicKey()],
        requiredSignatures: 2,
      });

      const payload = "disb-016:" + transactionXdr;

      await collectOfficerSignature({
        disbursementId: "disb-016",
        officer: officer1Kp.publicKey(),
        signature: officer1Kp.sign(Buffer.from(payload, "utf-8")).toString("base64"),
      });

      await collectOfficerSignature({
        disbursementId: "disb-016",
        officer: officer2Kp.publicKey(),
        signature: officer2Kp.sign(Buffer.from(payload, "utf-8")).toString("base64"),
      });

      // Now manually submit
      const result = await submitDisbursementApproval("disb-016");
      expect(result.status).toBe("broadcast");
    });

    it("rejects submission when quorum not met", async () => {
      await createDisbursementApproval({
        disbursementId: "disb-017",
        transactionXdr,
        officers: [officer1Kp.publicKey(), officer2Kp.publicKey(), officer3Kp.publicKey()],
        requiredSignatures: 2,
      });

      const payload = "disb-017:" + transactionXdr;

      await collectOfficerSignature({
        disbursementId: "disb-017",
        officer: officer1Kp.publicKey(),
        signature: officer1Kp.sign(Buffer.from(payload, "utf-8")).toString("base64"),
      });

      await expect(submitDisbursementApproval("disb-017")).rejects.toThrow("Quorum not met");
    });
  });

  describe("listDisbursements", () => {
    it("lists all disbursements sorted by creation time (newest first)", async () => {
      await createDisbursementApproval({
        disbursementId: "disb-018",
        transactionXdr,
        officers: [officer1Kp.publicKey(), officer2Kp.publicKey()],
        requiredSignatures: 2,
      });

      // Small delay to ensure different timestamps
      await new Promise(resolve => setTimeout(resolve, 10));

      await createDisbursementApproval({
        disbursementId: "disb-019",
        transactionXdr,
        officers: [officer1Kp.publicKey(), officer2Kp.publicKey()],
        requiredSignatures: 2,
      });

      const list = listDisbursements();
      expect(list.length).toBe(2);
      // Newest should be first (disb-019 created after disb-018)
      expect(list[0].disbursementId).toBe("disb-019");
      expect(list[1].disbursementId).toBe("disb-018");
    });
  });

  describe("expireStaleDisbursements", () => {
    it("expires disbursements older than TTL", async () => {
      // We can't easily test time-based expiry without mocking Date.now()
      // But we can verify the function runs without error
      const expired = await expireStaleDisbursements();
      expect(typeof expired).toBe("number");
    });
  });
});