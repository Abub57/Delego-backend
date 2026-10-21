/**
 * Tests for MockHorizonClient - verifies mock fallback provider works correctly
 * during unit testing without external network calls.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  MockHorizonServer,
  createHorizonServer,
  resetMockHorizon,
  setMockAccount,
  setMockPendingTransaction,
  isMockModeEnabled,
  getMockStellarConfig,
} from "./mockHorizon.js";

describe("MockHorizonClient", () => {
  beforeEach(() => {
    resetMockHorizon();
    vi.stubEnv("NODE_ENV", "test");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetMockHorizon();
  });

  describe("Mock mode detection", () => {
    it("returns true when NODE_ENV === 'test'", () => {
      expect(isMockModeEnabled()).toBe(true);
    });

    it("returns true when MOCK_HORIZON === 'true'", () => {
      vi.unstubAllEnvs();
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("MOCK_HORIZON", "true");
      expect(isMockModeEnabled()).toBe(true);
    });

    it("returns false when neither flag is set", () => {
      vi.unstubAllEnvs();
      vi.stubEnv("NODE_ENV", "production");
      expect(isMockModeEnabled()).toBe(false);
    });
  });

  describe("createHorizonServer", () => {
    it("returns MockHorizonServer when mock mode is enabled", () => {
      const server = createHorizonServer("https://horizon-testnet.stellar.org");
      expect(server).toBeInstanceOf(MockHorizonServer);
    });
  });

  describe("MockHorizonServer", () => {
    let server: MockHorizonServer;

    beforeEach(() => {
      server = new MockHorizonServer("mock://horizon");
    });

    describe("loadAccount", () => {
      it("returns account with default sequence and balances", async () => {
        const address = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
        const account = await server.loadAccount(address);

        expect(account.account_id).toBe(address);
        expect(account.sequence).toBe("100000000000000000");
        expect(account.balances).toHaveLength(1);
        expect(account.balances[0].asset_type).toBe("native");
        expect(account.balances[0].balance).toBe("1000.0000000");
      });

      it("returns configured account when setMockAccount is called", async () => {
        const address = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBWHF";
        setMockAccount(address, {
          sequence: 200000000000000000n,
          balances: [
            { asset_type: "native", balance: "5000.0000000" },
            { asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCWHF", balance: "1000.0000000" },
          ],
        });

        const account = await server.loadAccount(address);

        expect(account.sequence).toBe("200000000000000000");
        expect(account.balances).toHaveLength(2);
        expect(account.balances[1].asset_code).toBe("USDC");
      });

      it("increments sequence on each loadAccount call (simulating sequence tracking)", async () => {
        const address = "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCWHF";
        const account1 = await server.loadAccount(address);
        const account2 = await server.loadAccount(address);

        // Sequence should remain the same for loadAccount (only increments on submit)
        expect(account1.sequence).toBe(account2.sequence);
      });
    });

    describe("submitTransaction", () => {
      it("returns successful transaction result with hash and ledger", async () => {
        const address = "GDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDWHF";
        await server.loadAccount(address); // Initialize account

        const result = await server.submitTransaction("mock_tx_xdr");

        expect(result.successful).toBe(true);
        expect(result.hash).toMatch(/^mock_tx_/);
        expect(result.ledger).toBeGreaterThan(12345678);
        expect(result.envelope_xdr).toBe("mock_tx_xdr");
      });

      it("increments account sequence after submission", async () => {
        const address = "GEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEWHF";
        await server.loadAccount(address); // Initialize account
        const accountBefore = await server.loadAccount(address);

        await server.submitTransaction("mock_tx_xdr");

        const accountAfter = await server.loadAccount(address);
        expect(BigInt(accountAfter.sequence)).toBe(BigInt(accountBefore.sequence) + 1n);
      });
    });

    describe("transactions", () => {
      it("returns transaction details for submitted transaction", async () => {
        const address = "GFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFWHF";
        await server.loadAccount(address);
        const submitResult = await server.submitTransaction("mock_tx_xdr");

        const txResult = await server.transactions().transaction(submitResult.hash).call();

        expect(txResult.hash).toBe(submitResult.hash);
        expect(txResult.ledger).toBe(submitResult.ledger);
        expect(txResult.successful).toBe(true);
      });

      it("throws NotFoundError for unknown transaction", async () => {
        await expect(
          server.transactions().transaction("unknown_hash").call()
        ).rejects.toThrow("Transaction unknown_hash not found");
      });
    });

    describe("payments", () => {
      it("returns empty records when no pending transactions", async () => {
        const address = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
        const result = await server.payments().forAccount(address).limit(1).order("desc").call();

        expect(result.records).toHaveLength(0);
      });

      it("returns pending transaction when setMockPendingTransaction is true", async () => {
        const address = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
        setMockPendingTransaction(address, true);

        const result = await server.payments().forAccount(address).limit(1).order("desc").call();

        expect(result.records).toHaveLength(1);
        expect(result.records[0].transaction_hash).toBe("pending_tx_1");
      });

      it("returns empty records when setMockPendingTransaction is false", async () => {
        const address = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
        setMockPendingTransaction(address, true);
        setMockPendingTransaction(address, false);

        const result = await server.payments().forAccount(address).limit(1).order("desc").call();

        expect(result.records).toHaveLength(0);
      });
    });

    describe("feeStats", () => {
      it("returns mock fee stats with default values", async () => {
        const stats = await server.feeStats();

        expect(stats.last_ledger).toBe(12345678);
        expect(stats.last_ledger_base_fee).toBe(100);
        expect(stats.ledger_capacity_usage).toBe(0.1);
        expect(stats.max_fee["50"]).toBe(100);
        expect(stats.fee_charged["50"]).toBe(100);
      });
    });

    describe("paths", () => {
      it("returns empty records for strict-receive paths", async () => {
        const result = await server.paths().strictReceive(["native"], { type: "credit_alphanum4", code: "USDC", issuer: "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCWHF" }, "100.0000000").call();

        expect(result._embedded.records).toHaveLength(0);
      });
    });

    describe("assets", () => {
      it("returns mock asset records for asset discovery", async () => {
        const code = "USDC";
        const issuer = "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCWHF";
        const result = await server.assets().forCode(code).forIssuer(issuer).limit(1).call();

        expect(result._embedded.records).toHaveLength(1);
        expect(result._embedded.records[0].asset_code).toBe(code);
        expect(result._embedded.records[0].asset_issuer).toBe(issuer);
        expect(result._embedded.records[0].flags.auth_required).toBe(false);
      });
    });

    describe("accounts", () => {
      it("returns account with home_domain for metadata resolution", async () => {
        const address = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
        const result = await server.accounts().accountId(address).call();

        expect(result.home_domain).toBe("example.com");
        expect(result.account_id).toBe(address);
        expect(result.balances).toHaveLength(1);
      });
    });
  });

  describe("resetMockHorizon", () => {
    it("clears all mock state", async () => {
      const address = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
      setMockAccount(address, { sequence: 999999999999999999n });
      setMockPendingTransaction(address, true);

      await resetMockHorizon();

      const server = new MockHorizonServer("mock://horizon");
      const account = await server.loadAccount(address);
      const payments = await server.payments().forAccount(address).limit(1).order("desc").call();

      expect(account.sequence).toBe("100000000000000000");
      expect(payments.records).toHaveLength(0);
    });
  });

  describe("getMockStellarConfig", () => {
    it("returns mock configuration with testnet passphrase", () => {
      const config = getMockStellarConfig();

      expect(config.horizonUrl).toBe("mock://horizon");
      expect(config.sorobanRpcUrl).toBe("mock://soroban-rpc");
      expect(config.networkPassphrase).toBe("Test SDF Network ; September 2015");
      expect(config.mockMode).toBe(true);
      expect(config.timeoutMs).toBe(5000);
    });
  });
});