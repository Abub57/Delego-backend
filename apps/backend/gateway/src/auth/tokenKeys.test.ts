/**
 * Unit tests for #32 — gateway fails startup if JWT_SECRET equals the hardcoded default
 * value in production, and warns (but proceeds) in development.
 *
 * The gateway only touches JWT_SECRET for HS256 signing/verification (RS256/ES256 use
 * generated or configured asymmetric keys instead), so these tests exercise
 * `resolveJwtSecret` directly and via `SigningKeyStore` constructed with `alg: "HS256"`.
 *
 * The development warning is emitted through the gateway's structured Pino logger
 * (see `b98b4f3`), not `console.warn`, so the logger module is mocked to observe it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tokenKeysLogger = vi.hoisted(() => ({
  warn: vi.fn(),
}));

vi.mock("../logger.js", () => ({
  createChildLogger: () => tokenKeysLogger,
  logger: tokenKeysLogger,
}));

import {
  DEFAULT_JWT_SECRET,
  resolveJwtSecret,
  resetJwtSecretCache,
  resetSigningKeyStore,
  SigningKeyStore,
} from "./tokenKeys.js";

const originalEnv = { ...process.env };

describe("resolveJwtSecret (#32)", () => {
  beforeEach(() => {
    resetJwtSecretCache();
    tokenKeysLogger.warn.mockClear();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    resetJwtSecretCache();
  });

  it("throws in production when JWT_SECRET is unset", () => {
    expect(() => resolveJwtSecret(undefined, "production")).toThrow(
      /JWT_SECRET must be set in production/,
    );
  });

  it("throws in production when JWT_SECRET equals the default value", () => {
    expect(() => resolveJwtSecret(DEFAULT_JWT_SECRET, "production")).toThrow(
      /JWT_SECRET must be set in production/,
    );
  });

  it("does not throw in production when a non-default secret is configured", () => {
    expect(resolveJwtSecret("a-real-production-secret", "production")).toBe(
      "a-real-production-secret",
    );
  });

  it("warns but falls back to the default in development when unset", () => {
    expect(resolveJwtSecret(undefined, "development")).toBe(DEFAULT_JWT_SECRET);
    expect(tokenKeysLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("default JWT_SECRET"),
    );
  });

  it("warns but falls back to the default in development when explicitly set to the default", () => {
    expect(resolveJwtSecret(DEFAULT_JWT_SECRET, "development")).toBe(DEFAULT_JWT_SECRET);
    expect(tokenKeysLogger.warn).toHaveBeenCalled();
  });

  it("does not throw when NODE_ENV is unset (treated as non-production)", () => {
    expect(resolveJwtSecret(undefined, undefined)).toBe(DEFAULT_JWT_SECRET);
  });

  it("only warns once across repeated calls until the cache is reset", () => {
    resolveJwtSecret(undefined, "development");
    resolveJwtSecret(undefined, "development");
    resolveJwtSecret(undefined, "development");
    expect(tokenKeysLogger.warn).toHaveBeenCalledTimes(1);
  });

  it("reads from process.env.JWT_SECRET and process.env.NODE_ENV by default", () => {
    process.env.NODE_ENV = "production";
    process.env.JWT_SECRET = "env-configured-secret";
    expect(resolveJwtSecret()).toBe("env-configured-secret");
  });
});

describe("SigningKeyStore HS256 startup guard (#32)", () => {
  beforeEach(() => {
    resetSigningKeyStore();
    tokenKeysLogger.warn.mockClear();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    resetSigningKeyStore();
  });

  it("throws on construction in production when JWT_SECRET is unset and alg is HS256", () => {
    process.env.NODE_ENV = "production";
    delete process.env.JWT_SECRET;

    expect(() => new SigningKeyStore("HS256")).toThrow(/JWT_SECRET must be set in production/);
  });

  it("throws on construction in production when JWT_SECRET equals the default and alg is HS256", () => {
    process.env.NODE_ENV = "production";
    process.env.JWT_SECRET = DEFAULT_JWT_SECRET;

    expect(() => new SigningKeyStore("HS256")).toThrow(/JWT_SECRET must be set in production/);
  });

  it("constructs successfully in production when a real HS256 secret is configured", () => {
    process.env.NODE_ENV = "production";
    process.env.JWT_SECRET = "a-real-production-secret";

    expect(() => new SigningKeyStore("HS256")).not.toThrow();
  });

  it("warns but constructs successfully in development when JWT_SECRET is unset and alg is HS256", () => {
    process.env.NODE_ENV = "development";
    delete process.env.JWT_SECRET;

    expect(() => new SigningKeyStore("HS256")).not.toThrow();
    expect(tokenKeysLogger.warn).toHaveBeenCalled();
  });

  it("signs and verifies HS256 tokens using the resolved secret", () => {
    process.env.NODE_ENV = "production";
    process.env.JWT_SECRET = "a-real-production-secret";
    const keyStore = new SigningKeyStore("HS256");

    const token = keyStore.sign({ sub: "user-1" });
    const decoded = keyStore.verify(token) as { sub: string };
    expect(decoded.sub).toBe("user-1");
  });

  it("does not throw on construction in production for RS256 (JWT_SECRET is unused)", () => {
    process.env.NODE_ENV = "production";
    delete process.env.JWT_SECRET;

    expect(() => new SigningKeyStore("RS256")).not.toThrow();
  });
});
