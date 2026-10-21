import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  Keypair,
  Networks,
  nativeToScVal,
  rpc,
  SorobanDataBuilder,
} from "@stellar/stellar-sdk";
import {
  createPermissionsService,
  DuplicatePermissionError,
  InvalidPermissionInputError,
  LimitExceededError,
  PermissionExpiredError,
  PermissionNotFoundError,
  SimulationFailedError,
} from "./index.js";
import {
  listSigningKeyVersions,
  resetSigningKeyVersionStore,
} from "../src/vault.js";

// Mock spendLimits to test defense-in-depth off-chain checks cleanly
vi.mock("../src/spendLimits.js", () => ({
  checkSpendLimit: vi.fn().mockResolvedValue({ allowed: true }),
}));

describe("PermissionsService — Soroban permissions contract client", () => {
  const contractId = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
  const ownerKeypair = Keypair.random();
  const owner = ownerKeypair.publicKey();
  const spenderKeypair = Keypair.random();
  const spender = spenderKeypair.publicKey();

  let mockRpcServer: any;
  let mockHorizonServer: any;
  let mockSimulator: any;
  let mockKeySigner: any;

  beforeEach(() => {
    resetSigningKeyVersionStore();
    vi.clearAllMocks();

    mockRpcServer = {
      simulateTransaction: vi.fn(),
      sendTransaction: vi.fn().mockResolvedValue({
        status: "PENDING",
        hash: "tx_hash_1234567890abcdef",
      }),
      getTransaction: vi.fn().mockResolvedValue({
        status: rpc.Api.GetTransactionStatus.SUCCESS,
        ledger: 100,
      }),
    };

    mockHorizonServer = {
      loadAccount: vi.fn().mockResolvedValue({
        sequenceNumber: () => "100",
      }),
    };

    mockSimulator = {
      simulateTransaction: vi.fn(),
      detectFailureReasons: vi.fn().mockReturnValue([]),
    };

    mockKeySigner = {
      sign: vi.fn().mockImplementation(async (data: Buffer) => {
        return ownerKeypair.sign(data);
      }),
      getPublicKey: vi.fn().mockResolvedValue(owner),
    };
  });

  function makeSuccessSimulation() {
    return {
      minResourceFee: "1000",
      transactionData: new SorobanDataBuilder().build(),
      results: [{ auth: [], xdr: nativeToScVal(true).toXDR("base64") }],
    };
  }

  function createService(overrides?: Record<string, any>) {
    return createPermissionsService({
      rpcUrl: "https://soroban-testnet.stellar.org",
      horizonUrl: "https://horizon-testnet.stellar.org",
      networkPassphrase: Networks.TESTNET,
      defaultContractId: contractId,
      defaultOwner: owner,
      rpcServer: mockRpcServer,
      horizonServer: mockHorizonServer,
      simulator: mockSimulator,
      keySigner: mockKeySigner,
      ...overrides,
    });
  }

  describe("grant()", () => {
    it("successfully simulates, signs with vault key-version metadata, and grants permission", async () => {
      // 1. Initial lookup via get returns null (no duplicate)
      mockRpcServer.simulateTransaction.mockResolvedValueOnce({
        result: { retval: null },
      });

      // 2. Simulator simulation succeeds
      mockSimulator.simulateTransaction.mockResolvedValueOnce(makeSuccessSimulation());

      const service = createService();
      const expiresAt = new Date(Date.now() + 86400000).toISOString();
      const txHash = await service.grant({
        contractId,
        spender,
        limit: 10_000_000n,
        expiresAt,
        owner,
      });

      expect(txHash).toBe("tx_hash_1234567890abcdef");
      expect(mockSimulator.simulateTransaction).toHaveBeenCalledTimes(1);
      expect(mockKeySigner.sign).toHaveBeenCalledTimes(1);
      expect(mockRpcServer.sendTransaction).toHaveBeenCalledTimes(1);

      // Verify signing key version was persisted
      const versions = await listSigningKeyVersions(owner);
      expect(versions.length).toBe(1);
      expect(versions[0].walletId).toBe(owner);
    });

    it("aborts and throws SimulationFailedError when simulation fails without submitting transaction", async () => {
      // 1. Initial get returns null
      mockRpcServer.simulateTransaction.mockResolvedValueOnce({
        result: { retval: null },
      });

      // 2. Simulation fails
      mockSimulator.simulateTransaction.mockResolvedValueOnce({
        error: "HostError: Error(Contract, #101)",
      });
      mockSimulator.detectFailureReasons.mockReturnValueOnce([
        "HostError: Error(Contract, #101)",
      ]);

      const service = createService();
      await expect(
        service.grant({
          contractId,
          spender,
          limit: 5_000_000n,
          expiresAt: null,
          owner,
        })
      ).rejects.toThrow(SimulationFailedError);

      expect(mockRpcServer.sendTransaction).not.toHaveBeenCalled();
      expect(mockKeySigner.sign).not.toHaveBeenCalled();
    });

    it("throws DuplicatePermissionError when an identical grant already exists", async () => {
      const expiresAt = "2026-12-31T23:59:59.000Z";
      const existingRetval = nativeToScVal({
        delegator: owner,
        delegate: spender,
        limit: 5_000_000n,
        spent: 0n,
        expiry: BigInt(Math.floor(new Date(expiresAt).getTime() / 1000)),
      });

      // get returns existing identical grant
      mockRpcServer.simulateTransaction.mockResolvedValueOnce({
        result: { retval: existingRetval },
      });

      const service = createService();
      await expect(
        service.grant({
          contractId,
          spender,
          limit: 5_000_000n,
          expiresAt,
          owner,
        })
      ).rejects.toThrow(DuplicatePermissionError);

      expect(mockSimulator.simulateTransaction).not.toHaveBeenCalled();
      expect(mockRpcServer.sendTransaction).not.toHaveBeenCalled();
    });

    it("throws DuplicatePermissionError when identical grant exists even with different ISO string formatting", async () => {
      const expiresAt = "2026-12-31T23:59:59.000Z";
      const existingRetval = nativeToScVal({
        delegator: owner,
        delegate: spender,
        limit: 5_000_000n,
        spent: 0n,
        expiry: BigInt(Math.floor(new Date(expiresAt).getTime() / 1000)),
      });

      // get returns existing identical grant
      mockRpcServer.simulateTransaction.mockResolvedValueOnce({
        result: { retval: existingRetval },
      });

      const service = createService();
      // Pass ISO without milliseconds but same unix timestamp
      await expect(
        service.grant({
          contractId,
          spender,
          limit: 5_000_000n,
          expiresAt: "2026-12-31T23:59:59Z",
          owner,
        })
      ).rejects.toThrow(DuplicatePermissionError);
    });

    it("throws SimulationFailedError when assembleTransaction fails", async () => {
      mockSimulator.simulateTransaction.mockResolvedValueOnce({
        // Invalid transactionData causing assembly failure
        minResourceFee: "1000",
        transactionData: "INVALID_TRANSACTION_DATA",
      });

      const service = createService();
      await expect(
        service.grant({
          contractId,
          spender,
          limit: 5_000_000n,
          expiresAt: null,
          owner,
        })
      ).rejects.toThrow(SimulationFailedError);
    });

    it("throws PermissionError when polling confirmation times out", async () => {
      mockSimulator.simulateTransaction.mockResolvedValueOnce(makeSuccessSimulation());
      mockRpcServer.getTransaction
        .mockResolvedValueOnce({ status: "NOT_FOUND" })
        .mockResolvedValueOnce({ status: "NOT_FOUND" });

      const service = createService();
      await expect(
        service.grant({
          contractId,
          spender,
          limit: 5_000_000n,
          expiresAt: null,
          owner,
        })
      ).rejects.toThrow(/was not confirmed within the polling window/);
    });

    it("throws PermissionError when sequence number loading fails outside test environment", async () => {
      const origEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "production";
      try {
        mockHorizonServer.loadAccount.mockRejectedValueOnce(new Error("Horizon 500"));
        const service = createService();
        await expect(
          service.grant({
            contractId,
            spender,
            limit: 5_000_000n,
            expiresAt: null,
            owner,
          })
        ).rejects.toThrow(/Unable to load account sequence/);
      } finally {
        process.env.NODE_ENV = origEnv;
      }
    });

    it("allows updating grant when limit or expiry changes", async () => {
      const existingRetval = nativeToScVal({
        delegator: owner,
        delegate: spender,
        limit: 5_000_000n,
        spent: 0n,
        expiry: 1800000000n,
      });

      // get returns existing with different limit
      mockRpcServer.simulateTransaction.mockResolvedValueOnce({
        result: { retval: existingRetval },
      });

      mockSimulator.simulateTransaction.mockResolvedValueOnce(makeSuccessSimulation());

      const service = createService();
      const txHash = await service.grant({
        contractId,
        spender,
        limit: 10_000_000n, // Different limit
        expiresAt: "2026-12-31T23:59:59.000Z",
        owner,
      });

      expect(txHash).toBe("tx_hash_1234567890abcdef");
      expect(mockRpcServer.sendTransaction).toHaveBeenCalledTimes(1);
    });

    it("rejects invalid inputs (malformed spender, negative limit, invalid date)", async () => {
      const service = createService();

      await expect(
        service.grant({
          contractId,
          spender: "INVALID_SPENDER",
          limit: 1000n,
          expiresAt: null,
          owner,
        })
      ).rejects.toThrow(InvalidPermissionInputError);

      await expect(
        service.grant({
          contractId,
          spender,
          limit: -10n,
          expiresAt: null,
          owner,
        })
      ).rejects.toThrow(InvalidPermissionInputError);

      await expect(
        service.grant({
          contractId,
          spender,
          limit: 100n,
          expiresAt: "not-a-date",
          owner,
        })
      ).rejects.toThrow(InvalidPermissionInputError);
    });
  });

  describe("revoke()", () => {
    it("successfully revokes an active permission on-chain", async () => {
      const existingRetval = nativeToScVal({
        delegator: owner,
        delegate: spender,
        limit: 5_000_000n,
        spent: 0n,
        expiry: 1800000000n,
      });

      // 1. get returns existing grant
      mockRpcServer.simulateTransaction.mockResolvedValueOnce({
        result: { retval: existingRetval },
      });

      // 2. Simulation succeeds
      mockSimulator.simulateTransaction.mockResolvedValueOnce(makeSuccessSimulation());

      const service = createService();
      await service.revoke(contractId, spender, owner);

      expect(mockSimulator.simulateTransaction).toHaveBeenCalledTimes(1);
      expect(mockKeySigner.sign).toHaveBeenCalledTimes(1);
      expect(mockRpcServer.sendTransaction).toHaveBeenCalledTimes(1);
    });

    it("is idempotent: no-ops cleanly if permission does not exist", async () => {
      // 1. get returns null
      mockRpcServer.simulateTransaction.mockResolvedValueOnce({
        result: { retval: null },
      });

      const service = createService();
      await service.revoke(contractId, spender, owner);

      expect(mockSimulator.simulateTransaction).not.toHaveBeenCalled();
      expect(mockRpcServer.sendTransaction).not.toHaveBeenCalled();
    });

    it("aborts on simulation failure during revocation", async () => {
      const existingRetval = nativeToScVal({
        delegator: owner,
        delegate: spender,
        limit: 5_000_000n,
      });

      // 1. get returns existing grant
      mockRpcServer.simulateTransaction.mockResolvedValueOnce({
        result: { retval: existingRetval },
      });

      // 2. Simulator simulation fails
      mockSimulator.simulateTransaction.mockResolvedValueOnce({
        error: "Revoke rejected",
      });
      mockSimulator.detectFailureReasons.mockReturnValueOnce(["Revoke rejected"]);

      const service = createService();
      await expect(service.revoke(contractId, spender, owner)).rejects.toThrow(
        SimulationFailedError
      );

      expect(mockRpcServer.sendTransaction).not.toHaveBeenCalled();
    });
  });

  describe("revokeBatch()", () => {
    it("submits multiple revocations sequentially through the contract method", async () => {
      const secondSpender = Keypair.random().publicKey();
      const existingGrant = nativeToScVal({
        delegator: owner,
        delegate: spender,
        limit: 5_000_000n,
        spent: 0n,
        expiry: 1800000000n,
      });
      const secondGrant = nativeToScVal({
        delegator: owner,
        delegate: secondSpender,
        limit: 5_000_000n,
        spent: 0n,
        expiry: 1800000000n,
      });
      mockRpcServer.simulateTransaction
        .mockResolvedValueOnce({ result: { retval: existingGrant } })
        .mockResolvedValueOnce({ result: { retval: secondGrant } });
      mockSimulator.simulateTransaction
        .mockResolvedValueOnce(makeSuccessSimulation())
        .mockResolvedValueOnce(makeSuccessSimulation());

      const service = createService();
      await service.revokeBatch(contractId, [spender, secondSpender], owner);

      expect(mockSimulator.simulateTransaction).toHaveBeenCalledTimes(2);
      expect(mockKeySigner.sign).toHaveBeenCalledTimes(2);
      expect(mockRpcServer.sendTransaction).toHaveBeenCalledTimes(2);
    });
  });

  describe("get()", () => {
    it("returns null when no permission exists on-chain", async () => {
      mockRpcServer.simulateTransaction.mockResolvedValueOnce({
        result: { retval: null },
      });

      const service = createService();
      const grant = await service.get(contractId, owner, spender);
      expect(grant).toBeNull();
    });

    it("returns live PermissionGrant when permission exists", async () => {
      const expirySeconds = 1798761600n; // 2027-01-01T00:00:00.000Z
      const retval = nativeToScVal({
        delegator: owner,
        delegate: spender,
        limit: 25_000_000n,
        spent: 0n,
        expiry: expirySeconds,
      });

      mockRpcServer.simulateTransaction.mockResolvedValueOnce({
        result: { retval },
      });

      const service = createService();
      const grant = await service.get(contractId, owner, spender);

      expect(grant).not.toBeNull();
      expect(grant?.contractId).toBe(contractId);
      expect(grant?.spender).toBe(spender);
      expect(grant?.limit).toBe(25_000_000n);
      expect(grant?.expiresAt).toBe(new Date(Number(expirySeconds) * 1000).toISOString());
    });
  });

  describe("list()", () => {
    it("returns empty array when owner has no active grants", async () => {
      mockRpcServer.simulateTransaction.mockResolvedValueOnce({
        result: { retval: nativeToScVal([]) },
      });

      const service = createService();
      const grants = await service.list(owner, contractId);
      expect(grants).toEqual([]);
    });

    it("returns active grants list from contract state", async () => {
      const spender2 = Keypair.random().publicKey();
      const retval = nativeToScVal([
        {
          delegator: owner,
          delegate: spender,
          limit: 10_000_000n,
          expiry: 0n,
        },
        {
          delegator: owner,
          delegate: spender2,
          limit: 50_000_000n,
          expiry: 1800000000n,
        },
      ]);

      mockRpcServer.simulateTransaction.mockResolvedValueOnce({
        result: { retval },
      });

      const service = createService();
      const grants = await service.list(owner, contractId);

      expect(grants.length).toBe(2);
      expect(grants[0].spender).toBe(spender);
      expect(grants[0].limit).toBe(10_000_000n);
      expect(grants[0].expiresAt).toBeNull();
      expect(grants[1].spender).toBe(spender2);
      expect(grants[1].limit).toBe(50_000_000n);
    });
  });

  describe("checkSpend()", () => {
    it("returns true when amount is within unexpired grant limit", async () => {
      const retval = nativeToScVal({
        delegator: owner,
        delegate: spender,
        limit: 10_000_000n,
        expiry: BigInt(Math.floor((Date.now() + 100000) / 1000)),
      });

      mockRpcServer.simulateTransaction.mockResolvedValueOnce({
        result: { retval },
      });

      const service = createService();
      const allowed = await service.checkSpend(
        contractId,
        owner,
        spender,
        5_000_000n
      );
      expect(allowed).toBe(true);
    });

    it("rejects with PermissionNotFoundError when no grant exists", async () => {
      mockRpcServer.simulateTransaction.mockResolvedValueOnce({
        result: { retval: null },
      });

      const service = createService();
      await expect(
        service.checkSpend(contractId, owner, spender, 1000n)
      ).rejects.toThrow(PermissionNotFoundError);
    });

    it("rejects with PermissionExpiredError when grant is expired", async () => {
      const pastSeconds = BigInt(Math.floor((Date.now() - 100000) / 1000));
      const retval = nativeToScVal({
        delegator: owner,
        delegate: spender,
        limit: 10_000_000n,
        expiry: pastSeconds,
      });

      mockRpcServer.simulateTransaction.mockResolvedValueOnce({
        result: { retval },
      });

      const service = createService();
      await expect(
        service.checkSpend(contractId, owner, spender, 1000n)
      ).rejects.toThrow(PermissionExpiredError);
    });

    it("rejects with LimitExceededError when requested amount exceeds limit", async () => {
      const retval = nativeToScVal({
        delegator: owner,
        delegate: spender,
        limit: 5_000_000n,
        expiry: 0n,
      });

      mockRpcServer.simulateTransaction.mockResolvedValueOnce({
        result: { retval },
      });

      const service = createService();
      await expect(
        service.checkSpend(contractId, owner, spender, 10_000_000n)
      ).rejects.toThrow(LimitExceededError);
    });

    it("rejects with LimitExceededError when requested amount is non-positive", async () => {
      const service = createService();
      await expect(
        service.checkSpend(contractId, owner, spender, 0n)
      ).rejects.toThrow(LimitExceededError);
    });

    it("rejects with LimitExceededError when off-chain policy check rejects", async () => {
      const { checkSpendLimit } = await import("../src/spendLimits.js");
      (checkSpendLimit as any).mockResolvedValueOnce({
        allowed: false,
        reason: "Daily limit exceeded",
      });

      const retval = nativeToScVal({
        delegator: owner,
        delegate: spender,
        limit: 10_000_000n,
        expiry: 0n,
      });

      mockRpcServer.simulateTransaction.mockResolvedValueOnce({
        result: { retval },
      });

      const service = createService();
      await expect(
        service.checkSpend(contractId, owner, spender, 5_000_000n, {
          userId: "usr-123",
          walletId: "wal-456",
          delegationId: "del-789",
        })
      ).rejects.toThrow(LimitExceededError);

      expect(checkSpendLimit).toHaveBeenCalledWith(
        "usr-123",
        "wal-456",
        "del-789",
        5_000_000n
      );
    });

    it("fails closed and throws PermissionError when off-chain policy check encounters an unexpected error", async () => {
      const { checkSpendLimit } = await import("../src/spendLimits.js");
      (checkSpendLimit as any).mockRejectedValueOnce(
        new Error("Redis connection timed out")
      );

      const retval = nativeToScVal({
        delegator: owner,
        delegate: spender,
        limit: 10_000_000n,
        expiry: 0n,
      });

      mockRpcServer.simulateTransaction.mockResolvedValueOnce({
        result: { retval },
      });

      const service = createService();
      await expect(
        service.checkSpend(contractId, owner, spender, 5_000_000n, {
          userId: "usr-123",
          walletId: "wal-456",
        })
      ).rejects.toThrow(/Unable to evaluate off-chain spending policy/);
    });
  });

  describe("Lazy permissionsService singleton", () => {
    it("delegates methods on demand via the permissionsService proxy", async () => {
      const { permissionsService } = await import("./index.js");
      expect(typeof permissionsService.grant).toBe("function");
      expect(typeof permissionsService.revoke).toBe("function");
      expect(typeof permissionsService.list).toBe("function");
      expect(typeof permissionsService.get).toBe("function");
      expect(typeof permissionsService.checkSpend).toBe("function");
    });
  });
});
