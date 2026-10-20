import { describe, it, expect, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Keypair } from "@stellar/stellar-sdk";
import type { Logger } from "@delegolabs/utils";

import {
  DomainValidationService,
  DomainValidator,
  isPublicAddress,
  nextVerificationTier,
  normalizeDomain,
  type DomainValidationOutcome,
  type DomainValidatorOptions,
  type StellarTomlDocument,
  type TomlResolver,
} from "./domainValidationService.js";
import { InMemoryMerchantDomainStore, type MerchantDomainRecord } from "./merchantDomainStore.js";
import { msUntilNextRun, startDomainReverificationCron, type DailyLock } from "./reverificationScheduler.js";
import { createDomainVerificationHandler } from "./routes.js";

vi.mock("../db.js", () => ({ sequelize: {} }));
vi.mock("../queue/txQueue.js", () => ({ getRedisConnection: vi.fn() }));

const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
const MERCHANT_ADDRESS = Keypair.random().publicKey();
const OTHER_ADDRESS = Keypair.random().publicKey();
const PUBLIC_IP = async () => ["93.184.216.34"];
const FIXED_NOW = new Date("2026-10-19T03:00:00.000Z");

function validator(
  doc: StellarTomlDocument | (() => Promise<StellarTomlDocument>),
  extra: Partial<DomainValidatorOptions> = {}
) {
  const impl: TomlResolver = typeof doc === "function" ? doc : async () => doc;
  const resolveToml = vi.fn<TomlResolver>(impl);
  return {
    resolveToml,
    validator: new DomainValidator({
      resolveToml,
      lookupHost: PUBLIC_IP,
      now: () => FIXED_NOW,
      logger: silentLogger,
      ...extra,
    }),
  };
}

function httpError(status: number): Error {
  return Object.assign(new Error(`Request failed with status code ${status}`), { response: { status } });
}

// ---------------------------------------------------------------------------

describe("normalizeDomain", () => {
  it("canonicalizes case and a trailing dot", () => {
    expect(normalizeDomain(" Shop.Example.COM. ")).toBe("shop.example.com");
  });

  it.each([
    "https://example.com",
    "example.com:8443",
    "example.com/path",
    "user@example.com",
    "127.0.0.1",
    "[::1]",
    "localhost",
    "metadata.internal",
    "printer.local",
    "intranet",
    "example.123",
    "-bad.example.com",
    `${"a".repeat(64)}.com`,
    "",
  ])("rejects %s", (input) => {
    expect(() => normalizeDomain(input)).toThrow(/Invalid domain/);
  });
});

describe("isPublicAddress (SSRF guard)", () => {
  it.each([
    ["93.184.216.34", true],
    ["2606:4700:4700::1111", true],
    ["10.1.2.3", false],
    ["172.20.0.1", false],
    ["192.168.1.1", false],
    ["127.0.0.1", false],
    ["169.254.169.254", false],
    ["100.64.0.1", false],
    ["::1", false],
    ["fd00::1", false],
    ["fe80::1", false],
    ["::ffff:127.0.0.1", false],
    ["not-an-ip", false],
  ])("%s → %s", (address, expected) => {
    expect(isPublicAddress(address)).toBe(expected);
  });
});

describe("DomainValidator", () => {
  it("verifies when SIGNING_KEY matches the merchant address", async () => {
    const { validator: v, resolveToml } = validator({ SIGNING_KEY: MERCHANT_ADDRESS });
    const { result, failureKind } = await v.validate("shop.example.com", MERCHANT_ADDRESS);

    expect(result).toEqual({
      domain: "shop.example.com",
      signingKey: MERCHANT_ADDRESS,
      isVerified: true,
      tomlTimestamp: FIXED_NOW.toISOString(),
    });
    expect(failureKind).toBeUndefined();
    expect(resolveToml).toHaveBeenCalledWith("shop.example.com", 10_000);
  });

  it("verifies when the address is listed in ACCOUNTS", async () => {
    const { validator: v } = validator({ SIGNING_KEY: OTHER_ADDRESS, ACCOUNTS: [OTHER_ADDRESS, MERCHANT_ADDRESS] });
    const { result } = await v.validate("shop.example.com", MERCHANT_ADDRESS);
    expect(result.isVerified).toBe(true);
    expect(result.signingKey).toBe(OTHER_ADDRESS);
  });

  it("rejects an imposter whose address the domain does not list (definitive)", async () => {
    const { validator: v } = validator({ SIGNING_KEY: OTHER_ADDRESS, ACCOUNTS: [OTHER_ADDRESS] });
    const outcome = await v.validate("bigbrand.example", MERCHANT_ADDRESS);
    expect(outcome.result.isVerified).toBe(false);
    expect(outcome.result.validationError).toMatch(/not listed/);
    expect(outcome.failureKind).toBe("definitive");
  });

  it.each<[string, StellarTomlDocument, RegExp]>([
    ["malformed SIGNING_KEY", { SIGNING_KEY: "GNOTAKEY" }, /SIGNING_KEY is not a valid/],
    ["non-array ACCOUNTS", { ACCOUNTS: MERCHANT_ADDRESS }, /ACCOUNTS must be an array/],
    ["empty document", {}, /not listed/],
  ])("rejects %s", async (_label, doc, message) => {
    const { validator: v } = validator(doc);
    const outcome = await v.validate("shop.example.com", MERCHANT_ADDRESS);
    expect(outcome.result.validationError).toMatch(message);
    expect(outcome.failureKind).toBe("definitive");
  });

  it("rejects a TOML published for another network", async () => {
    const { validator: v } = validator(
      { SIGNING_KEY: MERCHANT_ADDRESS, NETWORK_PASSPHRASE: "Test SDF Network ; September 2015" },
      { networkPassphrase: "Public Global Stellar Network ; September 2015" }
    );
    const outcome = await v.validate("shop.example.com", MERCHANT_ADDRESS);
    expect(outcome.result.validationError).toMatch(/different Stellar network/);
  });

  it.each<[string, unknown, "definitive" | "transient"]>([
    ["404 (TOML removed)", httpError(404), "definitive"],
    ["503 (site down)", httpError(503), "transient"],
    ["timeout", new Error("timeout of 10000ms exceeded"), "transient"],
    ["TOML syntax error", new Error("Parsing error on line 3, column 1"), "definitive"],
  ])("classifies fetch failure: %s", async (_label, error, kind) => {
    const { validator: v } = validator(async () => Promise.reject(error));
    const outcome = await v.validate("shop.example.com", MERCHANT_ADDRESS);
    expect(outcome.result.isVerified).toBe(false);
    expect(outcome.result.tomlTimestamp).toBeUndefined();
    expect(outcome.failureKind).toBe(kind);
  });

  it("never fetches from a domain that resolves to a private address", async () => {
    const { validator: v, resolveToml } = validator({ SIGNING_KEY: MERCHANT_ADDRESS }, {
      lookupHost: async () => ["93.184.216.34", "10.0.0.5"],
    });
    const outcome = await v.validate("rebind.example.com", MERCHANT_ADDRESS);
    expect(outcome.result.validationError).toMatch(/non-public address 10\.0\.0\.5/);
    expect(resolveToml).not.toHaveBeenCalled();
  });

  it("treats NXDOMAIN as definitive and resolver errors as transient", async () => {
    const nx = validator({}, { lookupHost: async () => Promise.reject(Object.assign(new Error("x"), { code: "ENOTFOUND" })) });
    const flaky = validator({}, { lookupHost: async () => Promise.reject(Object.assign(new Error("x"), { code: "ETIMEOUT" })) });
    expect((await nx.validator.validate("gone.example.com", MERCHANT_ADDRESS)).failureKind).toBe("definitive");
    expect((await flaky.validator.validate("shop.example.com", MERCHANT_ADDRESS)).failureKind).toBe("transient");
  });
});

describe("nextVerificationTier", () => {
  const verified: DomainValidationOutcome = { result: { domain: "d.com", signingKey: "", isVerified: true } };
  const revoked: DomainValidationOutcome = { result: { domain: "d.com", signingKey: "", isVerified: false }, failureKind: "definitive" };
  const flaky: DomainValidationOutcome = { result: { domain: "d.com", signingKey: "", isVerified: false }, failureKind: "transient" };

  it("promotes on success and demotes immediately on revocation", () => {
    expect(nextVerificationTier("unverified", verified, 0, 3)).toBe("verified_business");
    expect(nextVerificationTier("verified_business", revoked, 0, 3)).toBe("unverified");
  });

  it("tolerates transient failures until the grace limit", () => {
    expect(nextVerificationTier("verified_business", flaky, 0, 3)).toBe("verified_business");
    expect(nextVerificationTier("verified_business", flaky, 1, 3)).toBe("verified_business");
    expect(nextVerificationTier("verified_business", flaky, 2, 3)).toBe("unverified");
    expect(nextVerificationTier("unverified", flaky, 0, 3)).toBe("unverified");
  });
});

// ---------------------------------------------------------------------------

function merchant(id: string, overrides: Partial<MerchantDomainRecord> = {}): MerchantDomainRecord {
  return {
    id,
    ownerUserId: "owner-1",
    stellarAddress: MERCHANT_ADDRESS,
    homeDomain: `${id}.example.com`,
    verificationTier: "unverified",
    consecutiveFailures: 0,
    ...overrides,
  };
}

describe("DomainValidationService", () => {
  it("promotes a merchant to verified_business and writes an audit record", async () => {
    const store = new InMemoryMerchantDomainStore();
    store.add(merchant("m1"));
    const { validator: v } = validator({ SIGNING_KEY: MERCHANT_ADDRESS });
    const service = new DomainValidationService({ store, validator: v, now: () => FIXED_NOW, logger: silentLogger });

    const result = await service.verifyMerchant("m1");

    expect(result).toMatchObject({ merchantId: "m1", isVerified: true, tierBefore: "unverified", verificationTier: "verified_business" });
    expect((await store.getMerchant("m1"))?.verificationTier).toBe("verified_business");
    expect(store.audit).toHaveLength(1);
    expect(store.audit[0].checkedAt).toEqual(FIXED_NOW);
  });

  it("changing the home domain resets verification before re-checking", async () => {
    const store = new InMemoryMerchantDomainStore();
    store.add(merchant("m1", { verificationTier: "verified_business" }));
    const { validator: v, resolveToml } = validator({ SIGNING_KEY: OTHER_ADDRESS });
    const service = new DomainValidationService({ store, validator: v, logger: silentLogger });

    const result = await service.verifyMerchant("m1", "New-Shop.example.com");

    expect(resolveToml).toHaveBeenCalledWith("new-shop.example.com", expect.any(Number));
    expect(result.tierBefore).toBe("unverified");
    expect(result.verificationTier).toBe("unverified");
  });

  it("daily sweep demotes merchants whose listing was revoked and promotes fixed ones", async () => {
    const store = new InMemoryMerchantDomainStore();
    store.add(merchant("revoked", { verificationTier: "verified_business" }), new Date("2026-10-18T03:00:00Z"));
    store.add(merchant("fixed"), new Date("2026-10-18T03:00:00Z"));
    store.add(merchant("checked-today", { verificationTier: "verified_business" }), new Date("2026-10-19T03:00:01Z"));
    store.add(merchant("no-domain", { homeDomain: null }));
    const { validator: v, resolveToml } = validator(async () => ({}));
    resolveToml.mockImplementation(async (domain: string) =>
      domain.startsWith("fixed") ? { ACCOUNTS: [MERCHANT_ADDRESS] } : { SIGNING_KEY: OTHER_ADDRESS }
    );
    const service = new DomainValidationService({ store, validator: v, now: () => FIXED_NOW, logger: silentLogger });

    const summary = await service.reverifyAll({ batchSize: 1 });

    expect(summary).toEqual({ checked: 2, verified: 1, promoted: 1, demoted: 1, errors: 0 });
    expect((await store.getMerchant("revoked"))?.verificationTier).toBe("unverified");
    expect((await store.getMerchant("fixed"))?.verificationTier).toBe("verified_business");
    expect((await store.getMerchant("checked-today"))?.verificationTier).toBe("verified_business");
  });

  it("keeps a verified merchant through two flaky days and demotes on the third", async () => {
    const store = new InMemoryMerchantDomainStore();
    store.add(merchant("m1", { verificationTier: "verified_business" }));
    const { validator: v } = validator(async () => Promise.reject(httpError(503)));
    let now = new Date("2026-10-17T03:00:00Z");
    const service = new DomainValidationService({ store, validator: v, now: () => now, logger: silentLogger });

    const tiers: string[] = [];
    for (let day = 0; day < 3; day++) {
      now = new Date(now.getTime() + 24 * 3600_000);
      await service.reverifyAll();
      tiers.push((await store.getMerchant("m1"))!.verificationTier);
    }
    expect(tiers).toEqual(["verified_business", "verified_business", "unverified"]);
  });

  it("counts persistence failures without looping forever", async () => {
    const store = new InMemoryMerchantDomainStore();
    store.add(merchant("m1"));
    store.recordOutcome = async () => Promise.reject(new Error("db down"));
    const { validator: v } = validator({ SIGNING_KEY: MERCHANT_ADDRESS });
    const service = new DomainValidationService({ store, validator: v, now: () => FIXED_NOW, logger: silentLogger });

    expect(await service.reverifyAll()).toMatchObject({ checked: 0, errors: 1 });
  });
});

// ---------------------------------------------------------------------------

describe("daily re-verification cron", () => {
  it("schedules the next run at the configured UTC hour", () => {
    expect(msUntilNextRun(new Date("2026-10-19T01:30:00Z"), 3)).toBe(90 * 60_000);
    expect(msUntilNextRun(new Date("2026-10-19T03:00:00Z"), 3)).toBe(24 * 3600_000);
    expect(msUntilNextRun(new Date("2026-10-19T23:00:00Z"), 3)).toBe(4 * 3600_000);
  });

  it("runs the sweep on only one replica per day", async () => {
    const claimed = new Set<string>();
    const lock: DailyLock = {
      tryAcquire: async (key) => (claimed.has(key) ? false : (claimed.add(key), true)),
    };
    const run = vi.fn(async () => undefined);
    const a = startDomainReverificationCron({ run, lock, now: () => FIXED_NOW, logger: silentLogger });
    const b = startDomainReverificationCron({ run, lock, now: () => FIXED_NOW, logger: silentLogger });

    expect(await a.runOnce()).toBe(true);
    expect(await b.runOnce()).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
    expect([...claimed]).toEqual(["merchant-domain-reverify:2026-10-19"]);
    a.stop();
    b.stop();
  });
});

// ---------------------------------------------------------------------------

describe("POST /api/v1/merchants/:merchantId/domain-verification", () => {
  const MERCHANT_ID = "6f1c2a9e-1b2c-4d3e-8f00-0123456789ab";

  function call(handler: ReturnType<typeof createDomainVerificationHandler>, opts: { userId?: string; body?: string }) {
    const req = Object.assign(
      {
        headers: {},
        userId: opts.userId,
        on(event: string, cb: (chunk?: Buffer) => void) {
          if (event === "data" && opts.body) cb(Buffer.from(opts.body));
          if (event === "end") cb();
          return this;
        },
      },
      {}
    ) as unknown as IncomingMessage;
    const res = { writeHead: vi.fn(), setHeader: vi.fn(), end: vi.fn() } as unknown as ServerResponse;
    return { req, res, run: () => handler(req, res, { merchantId: MERCHANT_ID }) };
  }

  function deps(ownerUserId = "owner-1", rateLimited = false) {
    return {
      service: { verifyMerchant: vi.fn(async () => ({ merchantId: MERCHANT_ID, isVerified: true } as never)) },
      store: { getMerchant: vi.fn(async () => merchant(MERCHANT_ID, { ownerUserId })) },
      rateLimiter: { set: vi.fn(async () => (rateLimited ? null : "OK")) },
    };
  }

  it("requires authentication", async () => {
    const d = deps();
    const { res, run } = call(createDomainVerificationHandler(d), {});
    await run();
    expect(res.writeHead).toHaveBeenCalledWith(401, expect.anything());
  });

  it("hides merchants the caller does not own", async () => {
    const d = deps("someone-else");
    const { res, run } = call(createDomainVerificationHandler(d), { userId: "owner-1", body: '{"domain":"a.example.com"}' });
    await run();
    expect(res.writeHead).toHaveBeenCalledWith(404, expect.anything());
    expect(d.service.verifyMerchant).not.toHaveBeenCalled();
  });

  it("rate-limits repeated verification requests", async () => {
    const d = deps("owner-1", true);
    const { res, run } = call(createDomainVerificationHandler(d), { userId: "owner-1", body: '{"domain":"a.example.com"}' });
    await run();
    expect(res.writeHead).toHaveBeenCalledWith(429, expect.anything());
    expect(d.service.verifyMerchant).not.toHaveBeenCalled();
  });

  it("verifies the submitted domain for the owner", async () => {
    const d = deps();
    const { res, run } = call(createDomainVerificationHandler(d), { userId: "owner-1", body: '{"domain":"a.example.com"}' });
    await run();
    expect(d.service.verifyMerchant).toHaveBeenCalledWith(MERCHANT_ID, "a.example.com");
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.anything());
  });
});
