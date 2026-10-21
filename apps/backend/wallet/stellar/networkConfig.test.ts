import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Networks } from "@stellar/stellar-sdk";
import { validateStellarNetworkConfig, isMockModeEnabled, getMockNetworkConfig } from "./networkConfig.js";

describe("Stellar Network Passphrase Validation (Issue #120)", () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.STELLAR_NETWORK;
    delete process.env.STELLAR_NETWORK_PASSPHRASE;
    delete process.env.STELLAR_HORIZON_URL;
    delete process.env.STELLAR_RPC_URL;
    delete process.env.ALLOW_CUSTOM_PASSPHRASE;
    delete process.env.MOCK_HORIZON;
    delete process.env.NODE_ENV;
  });

  afterEach(() => {
    process.env = { ...origEnv };
  });

  it("validates testnet passphrase by default", () => {
    const config = validateStellarNetworkConfig();
    expect(config.networkPassphrase).toBe(Networks.TESTNET);
    expect(config.horizonUrl).toContain("testnet");
    expect(config.rpcUrl).toContain("testnet");
  });

  it("validates public (mainnet) network passphrase", () => {
    process.env.STELLAR_NETWORK = "mainnet";
    const config = validateStellarNetworkConfig();
    expect(config.networkPassphrase).toBe(Networks.PUBLIC);
    expect(config.horizonUrl).toBe("https://horizon.stellar.org");
    expect(config.rpcUrl).toBe("https://rpc.stellar.org");
  });

  it("validates custom network passphrase when custom mode is allowed", () => {
    process.env.STELLAR_NETWORK = "custom";
    process.env.ALLOW_CUSTOM_PASSPHRASE = "true";
    const customPass = "Custom Local Standalone Network ; 2026";
    const config = validateStellarNetworkConfig({
      networkPassphrase: customPass,
      horizonUrl: "http://localhost:8000",
      rpcUrl: "http://localhost:8000/soroban/rpc",
    });

    expect(config.networkPassphrase).toBe(customPass);
    expect(config.horizonUrl).toBe("http://localhost:8000");
    expect(config.rpcUrl).toBe("http://localhost:8000/soroban/rpc");
  });

  it("rejects empty passphrase at startup", () => {
    expect(() =>
      validateStellarNetworkConfig({ networkPassphrase: "" })
    ).toThrow("Invalid Stellar network passphrase: passphrase cannot be empty");

    expect(() =>
      validateStellarNetworkConfig({ networkPassphrase: "   " })
    ).toThrow("Invalid Stellar network passphrase: passphrase cannot be empty");
  });

  it("rejects unknown network passphrase when not in custom mode", () => {
    process.env.STELLAR_NETWORK = "unknown_net";
    process.env.ALLOW_CUSTOM_PASSPHRASE = "false";
    expect(() =>
      validateStellarNetworkConfig({ networkPassphrase: "Some Random Unknown Passphrase" })
    ).toThrow("Unknown Stellar network passphrase");
  });
});

describe("Mock Mode Support (Issue #560)", () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.MOCK_HORIZON;
    delete process.env.NODE_ENV;
  });

  afterEach(() => {
    process.env = { ...origEnv };
  });

  it("isMockModeEnabled returns true when NODE_ENV === 'test'", () => {
    process.env.NODE_ENV = "test";
    expect(isMockModeEnabled()).toBe(true);
  });

  it("isMockModeEnabled returns true when MOCK_HORIZON === 'true'", () => {
    process.env.NODE_ENV = "production";
    process.env.MOCK_HORIZON = "true";
    expect(isMockModeEnabled()).toBe(true);
  });

  it("isMockModeEnabled returns false when neither flag is set", () => {
    process.env.NODE_ENV = "production";
    expect(isMockModeEnabled()).toBe(false);
  });

  it("validateStellarNetworkConfig returns mock config when NODE_ENV === 'test'", () => {
    process.env.NODE_ENV = "test";
    const config = validateStellarNetworkConfig();

    expect(config.mockMode).toBe(true);
    expect(config.horizonUrl).toBe("mock://horizon");
    expect(config.rpcUrl).toBe("mock://soroban-rpc");
    expect(config.networkPassphrase).toBe(Networks.TESTNET);
  });

  it("validateStellarNetworkConfig returns mock config when MOCK_HORIZON === 'true'", () => {
    process.env.MOCK_HORIZON = "true";
    const config = validateStellarNetworkConfig();

    expect(config.mockMode).toBe(true);
    expect(config.horizonUrl).toBe("mock://horizon");
    expect(config.rpcUrl).toBe("mock://soroban-rpc");
  });

  it("getMockNetworkConfig returns correct mock configuration", () => {
    const config = getMockNetworkConfig();

    expect(config.horizonUrl).toBe("mock://horizon");
    expect(config.rpcUrl).toBe("mock://soroban-rpc");
    expect(config.networkPassphrase).toBe(Networks.TESTNET);
    expect(config.mockMode).toBe(true);
  });

  it("explicit override takes precedence over mock mode", () => {
    process.env.NODE_ENV = "test";
    const config = validateStellarNetworkConfig({
      horizonUrl: "https://custom-horizon.example.com",
      rpcUrl: "https://custom-rpc.example.com",
    });

    expect(config.horizonUrl).toBe("https://custom-horizon.example.com");
    expect(config.rpcUrl).toBe("https://custom-rpc.example.com");
  });
});
