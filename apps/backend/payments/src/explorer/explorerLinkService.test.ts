/**
 * Explorer Link Service — Unit Tests
 *
 * Verifies that canonical Stellar Expert / Horizon explorer URLs are
 * generated correctly for testnet and public (mainnet) networks, and
 * that invalid transaction hash formats are rejected.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  ExplorerLinkService,
  validateTxHash,
  injectExplorerLinks,
  _resetExplorerLinkService,
  type ExplorerLinkSet,
} from "./explorerLinkService.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_TX_HASH = "a".repeat(64); // 64 hex chars
const VALID_TX_HASH_MIXED = "0123456789abcdefABCDEF".padEnd(64, "0"); // mixed case
const INVALID_TX_HASH_SHORT = "abc123";
const INVALID_TX_HASH_NON_HEX = "g".repeat(64);
const ACCOUNT_ADDRESS = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const CONTRACT_ADDRESS = "CCJZ5DGASBWH24IQOWP6JJRMSNOYHDAMZSTHCRXYSTXUSQKIYZQDNKC6";

// ---------------------------------------------------------------------------
// validateTxHash
// ---------------------------------------------------------------------------

describe("validateTxHash", () => {
  it("accepts a valid 64-char lowercase hex hash", () => {
    expect(() => validateTxHash(VALID_TX_HASH)).not.toThrow();
  });

  it("accepts a valid 64-char mixed-case hex hash", () => {
    expect(() => validateTxHash(VALID_TX_HASH_MIXED)).not.toThrow();
  });

  it("rejects a hash that is too short", () => {
    expect(() => validateTxHash(INVALID_TX_HASH_SHORT)).toThrow(/Invalid transaction hash/);
  });

  it("rejects a hash containing non-hex characters", () => {
    expect(() => validateTxHash(INVALID_TX_HASH_NON_HEX)).toThrow(/Invalid transaction hash/);
  });

  it("rejects an empty string", () => {
    expect(() => validateTxHash("")).toThrow(/Invalid transaction hash/);
  });
});

// ---------------------------------------------------------------------------
// ExplorerLinkService — testnet
// ---------------------------------------------------------------------------

describe("ExplorerLinkService (testnet)", () => {
  let service: ExplorerLinkService;

  beforeEach(() => {
    service = new ExplorerLinkService("testnet");
  });

  it("returns network = testnet", () => {
    expect(service.getNetwork()).toBe("testnet");
  });

  it("generates a txUrl pointing at stellar.expert/testnet", () => {
    const links = service.buildLinkSet(VALID_TX_HASH, ACCOUNT_ADDRESS, CONTRACT_ADDRESS);
    expect(links.txUrl).toContain("testnet");
    expect(links.txUrl).toContain(VALID_TX_HASH);
    expect(links.txUrl).toMatch(/^https:\/\/stellar\.expert\/explorer\/testnet\/tx\//);
  });

  it("generates an accountUrl pointing at stellar.expert/testnet", () => {
    const links = service.buildLinkSet(VALID_TX_HASH, ACCOUNT_ADDRESS, CONTRACT_ADDRESS);
    expect(links.accountUrl).toContain(ACCOUNT_ADDRESS);
    expect(links.accountUrl).toMatch(/^https:\/\/stellar\.expert\/explorer\/testnet\/account\//);
  });

  it("generates a contractUrl pointing at stellar.expert/testnet", () => {
    const links = service.buildLinkSet(VALID_TX_HASH, ACCOUNT_ADDRESS, CONTRACT_ADDRESS);
    expect(links.contractUrl).toContain(CONTRACT_ADDRESS);
    expect(links.contractUrl).toMatch(/^https:\/\/stellar\.expert\/explorer\/testnet\/contract\//);
  });

  it("throws for an invalid tx hash format", () => {
    expect(() =>
      service.buildLinkSet(INVALID_TX_HASH_SHORT, ACCOUNT_ADDRESS, CONTRACT_ADDRESS)
    ).toThrow(/Invalid transaction hash/);
  });
});

// ---------------------------------------------------------------------------
// ExplorerLinkService — mainnet (public)
// ---------------------------------------------------------------------------

describe("ExplorerLinkService (mainnet)", () => {
  let service: ExplorerLinkService;

  beforeEach(() => {
    service = new ExplorerLinkService("mainnet");
  });

  it("returns network = mainnet", () => {
    expect(service.getNetwork()).toBe("mainnet");
  });

  it("generates URLs pointing at the public Stellar network", () => {
    const links = service.buildLinkSet(VALID_TX_HASH, ACCOUNT_ADDRESS, CONTRACT_ADDRESS);
    expect(links.txUrl).not.toContain("testnet");
    expect(links.txUrl).toContain("public");
    expect(links.network).toBe("mainnet");
  });

  it("generates correct Horizon tx URL for mainnet", () => {
    const url = service.horizonTxUrl(VALID_TX_HASH);
    expect(url).toContain("horizon.stellar.org");
    expect(url).toContain(VALID_TX_HASH);
  });
});

// ---------------------------------------------------------------------------
// ExplorerLinkService — futurenet
// ---------------------------------------------------------------------------

describe("ExplorerLinkService (futurenet)", () => {
  it("generates futurenet URLs", () => {
    const service = new ExplorerLinkService("futurenet");
    const links = service.buildLinkSet(VALID_TX_HASH, ACCOUNT_ADDRESS, CONTRACT_ADDRESS);
    expect(links.network).toBe("futurenet");
    expect(links.txUrl).toContain("futurenet");
  });
});

// ---------------------------------------------------------------------------
// injectExplorerLinks helper
// ---------------------------------------------------------------------------

describe("injectExplorerLinks", () => {
  beforeEach(() => {
    _resetExplorerLinkService();
    // Force testnet singleton
    process.env.STELLAR_NETWORK = "testnet";
  });

  afterEach(() => {
    delete process.env.STELLAR_NETWORK;
    _resetExplorerLinkService();
  });

  it("injects explorerLinks into a response object", () => {
    const response: { id: string; explorerLinks?: ExplorerLinkSet } = { id: "order-1" };
    injectExplorerLinks(response, VALID_TX_HASH, ACCOUNT_ADDRESS, CONTRACT_ADDRESS);

    expect(response.explorerLinks).toBeDefined();
    expect(response.explorerLinks!.network).toBe("testnet");
    expect(response.explorerLinks!.txUrl).toContain(VALID_TX_HASH);
  });

  it("skips injection when txHash is null", () => {
    const response: { id: string; explorerLinks?: ExplorerLinkSet } = { id: "order-1" };
    injectExplorerLinks(response, null, ACCOUNT_ADDRESS, CONTRACT_ADDRESS);
    expect(response.explorerLinks).toBeUndefined();
  });

  it("skips injection when txHash is undefined", () => {
    const response: { id: string; explorerLinks?: ExplorerLinkSet } = { id: "order-1" };
    injectExplorerLinks(response, undefined, ACCOUNT_ADDRESS, CONTRACT_ADDRESS);
    expect(response.explorerLinks).toBeUndefined();
  });

  it("does not throw when txHash is invalid — just skips injection", () => {
    const response: { id: string; explorerLinks?: ExplorerLinkSet } = { id: "order-1" };
    expect(() =>
      injectExplorerLinks(response, "bad-hash", ACCOUNT_ADDRESS, CONTRACT_ADDRESS)
    ).not.toThrow();
    expect(response.explorerLinks).toBeUndefined();
  });
});
