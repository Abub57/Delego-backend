/**
 * SEP-0001 merchant domain validation.
 *
 * Protects buyers from imposter merchants: a merchant claiming a domain is
 * promoted to `verified_business` only if the stellar.toml served at
 * https://{domain}/.well-known/stellar.toml lists the merchant's registered
 * Stellar address as its SIGNING_KEY or in ACCOUNTS. The domain owner, not
 * the merchant, controls that file, so a listing is the domain's endorsement
 * of the address.
 *
 * Safety:
 *   - The domain is merchant-supplied and fetched server-side, so it is
 *     strictly validated (bare hostname, no IP literals or internal names)
 *     and its DNS answers must all be publicly routable (SSRF guard).
 *   - The TOML is fetched over HTTPS only, without redirects, size-capped,
 *     with a timeout (StellarToml.Resolver defaults + explicit timeout).
 *
 * Failures are classified so the daily re-check can tell a revoked listing
 * (definitive → demote immediately) from a flaky site (transient → demote
 * only after several consecutive failures).
 */

import { BlockList, isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { StellarToml, StrKey } from "@stellar/stellar-sdk";
import { createLogger, type Logger } from "@delegolabs/utils";
import type { MerchantDomainRecord, MerchantDomainStore } from "./merchantDomainStore.js";

const log = createLogger("wallet:merchant-domain", process.env.LOG_LEVEL ?? "info");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Sep0001ValidationResult {
  domain: string;
  signingKey: string;
  isVerified: boolean;
  validationError?: string;
  /** When the stellar.toml was fetched (ISO 8601). Absent if it never was. */
  tomlTimestamp?: string;
}

export type DomainFailureKind = "definitive" | "transient";

export interface DomainValidationOutcome {
  result: Sep0001ValidationResult;
  /** Set only when `result.isVerified` is false. */
  failureKind?: DomainFailureKind;
}

export type MerchantVerificationTier = "unverified" | "verified_business";

/** The parts of a parsed stellar.toml this validator reads. */
export interface StellarTomlDocument {
  SIGNING_KEY?: unknown;
  ACCOUNTS?: unknown;
  NETWORK_PASSPHRASE?: unknown;
}

export type TomlResolver = (domain: string, timeoutMs: number) => Promise<StellarTomlDocument>;
export type HostLookup = (hostname: string) => Promise<string[]>;

export class DomainValidationError extends Error {
  constructor(message: string, readonly kind: DomainFailureKind) {
    super(message);
    this.name = "DomainValidationError";
  }
}

// ---------------------------------------------------------------------------
// Domain normalization + SSRF guard
// ---------------------------------------------------------------------------

const LABEL_PATTERN = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa", ".onion"];

/**
 * Returns the canonical bare hostname, or throws a definitive
 * DomainValidationError. Internationalized names must be given in punycode.
 */
export function normalizeDomain(input: string): string {
  const domain = input.trim().toLowerCase().replace(/\.$/, "");
  const fail = (reason: string): never => {
    throw new DomainValidationError(`Invalid domain "${input}": ${reason}`, "definitive");
  };

  if (domain.length === 0 || domain.length > 253) fail("must be 1-253 characters");
  if (/[/:?#@\s]/.test(domain)) fail("must be a bare hostname without scheme, port or path");
  if (isIP(domain) !== 0) fail("IP addresses are not allowed");

  const labels = domain.split(".");
  if (labels.length < 2) fail("must be a fully qualified domain name");
  if (!labels.every((label) => LABEL_PATTERN.test(label))) fail("contains an invalid label");
  if (/^\d+$/.test(labels[labels.length - 1])) fail("top-level domain cannot be numeric");
  if (domain === "localhost" || BLOCKED_SUFFIXES.some((s) => domain.endsWith(s))) {
    fail("internal hostnames are not allowed");
  }
  return domain;
}

const NON_PUBLIC_ADDRESSES = (() => {
  const list = new BlockList();
  for (const [net, prefix] of [
    ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
    ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
    ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
    ["224.0.0.0", 4], ["240.0.0.0", 4],
  ] as const) {
    list.addSubnet(net, prefix, "ipv4");
  }
  // No `::ffff:0:0/96` entry: `BlockList` normalises IPv4-mapped IPv6 addresses
  // to IPv4 internally, so that subnet collapses to `0.0.0.0/0` and reports
  // every IPv4 address (including public ones) as blocked. Mapped addresses are
  // already matched against the IPv4 rules above.
  for (const [net, prefix] of [
    ["::", 128], ["::1", 128], ["64:ff9b::", 96], ["100::", 64],
    ["2001:db8::", 32], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
  ] as const) {
    list.addSubnet(net, prefix, "ipv6");
  }
  return list;
})();

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  return !NON_PUBLIC_ADDRESSES.check(address, family === 4 ? "ipv4" : "ipv6");
}

const defaultLookup: HostLookup = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);

/** Every resolved address must be public, otherwise the fetch is refused. */
export async function assertPubliclyRoutable(domain: string, lookupHost: HostLookup = defaultLookup): Promise<void> {
  let addresses: string[];
  try {
    addresses = await lookupHost(domain);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // NXDOMAIN is the domain's real state; anything else may be a resolver blip.
    const kind: DomainFailureKind = code === "ENOTFOUND" ? "definitive" : "transient";
    throw new DomainValidationError(`DNS lookup failed for ${domain}: ${code ?? errorMessage(err)}`, kind);
  }
  if (addresses.length === 0) {
    throw new DomainValidationError(`${domain} has no DNS records`, "definitive");
  }
  const blocked = addresses.find((address) => !isPublicAddress(address));
  if (blocked) {
    throw new DomainValidationError(`${domain} resolves to non-public address ${blocked}`, "definitive");
  }
}

// ---------------------------------------------------------------------------
// TOML fetch + check
// ---------------------------------------------------------------------------

const defaultResolver: TomlResolver = (domain, timeoutMs) =>
  // HTTPS only, no redirects, 100 KB cap (SDK defaults).
  StellarToml.Resolver.resolve(domain, { timeout: timeoutMs }) as Promise<StellarTomlDocument>;

function classifyFetchError(err: unknown): DomainFailureKind {
  const status = (err as { response?: { status?: number } }).response?.status;
  if (status !== undefined) return status === 404 || status === 410 ? "definitive" : "transient";
  // The SDK reports TOML syntax errors as "Parsing error on line …".
  return /parsing error/i.test(errorMessage(err)) ? "definitive" : "transient";
}

function readAccounts(doc: StellarTomlDocument): string[] {
  if (doc.ACCOUNTS === undefined) return [];
  if (!Array.isArray(doc.ACCOUNTS)) {
    throw new DomainValidationError("ACCOUNTS must be an array of account ids", "definitive");
  }
  return doc.ACCOUNTS.filter((a): a is string => typeof a === "string").map((a) => a.trim());
}

export interface DomainValidatorOptions {
  resolveToml?: TomlResolver;
  lookupHost?: HostLookup;
  /** When set, a TOML declaring a different NETWORK_PASSPHRASE is rejected. */
  networkPassphrase?: string;
  timeoutMs?: number;
  now?: () => Date;
  logger?: Logger;
}

export class DomainValidator {
  private readonly resolveToml: TomlResolver;
  private readonly lookupHost: HostLookup;
  private readonly networkPassphrase?: string;
  private readonly timeoutMs: number;
  private readonly now: () => Date;
  private readonly log: Logger;

  constructor(options: DomainValidatorOptions = {}) {
    this.resolveToml = options.resolveToml ?? defaultResolver;
    this.lookupHost = options.lookupHost ?? defaultLookup;
    this.networkPassphrase = options.networkPassphrase;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.now = options.now ?? (() => new Date());
    this.log = options.logger ?? log;
  }

  /** Checks that `domainInput`'s stellar.toml lists `merchantAddress`. Never throws. */
  async validate(domainInput: string, merchantAddress: string): Promise<DomainValidationOutcome> {
    let domain = domainInput;
    let signingKey = "";
    let tomlTimestamp: string | undefined;

    try {
      domain = normalizeDomain(domainInput);
      if (!StrKey.isValidEd25519PublicKey(merchantAddress)) {
        throw new DomainValidationError("Merchant has no valid registered Stellar address", "definitive");
      }
      await assertPubliclyRoutable(domain, this.lookupHost);

      let doc: StellarTomlDocument;
      try {
        doc = await this.resolveToml(domain, this.timeoutMs);
      } catch (err) {
        throw new DomainValidationError(
          `Could not fetch https://${domain}/.well-known/stellar.toml: ${errorMessage(err)}`,
          classifyFetchError(err)
        );
      }
      tomlTimestamp = this.now().toISOString();

      if (doc.SIGNING_KEY !== undefined) {
        if (typeof doc.SIGNING_KEY !== "string" || !StrKey.isValidEd25519PublicKey(doc.SIGNING_KEY.trim())) {
          throw new DomainValidationError("SIGNING_KEY is not a valid Stellar public key", "definitive");
        }
        signingKey = doc.SIGNING_KEY.trim();
      }
      if (
        this.networkPassphrase &&
        typeof doc.NETWORK_PASSPHRASE === "string" &&
        doc.NETWORK_PASSPHRASE !== this.networkPassphrase
      ) {
        throw new DomainValidationError("stellar.toml is published for a different Stellar network", "definitive");
      }

      const listed = signingKey === merchantAddress || readAccounts(doc).includes(merchantAddress);
      if (!listed) {
        throw new DomainValidationError(
          "Merchant address is not listed as SIGNING_KEY or in ACCOUNTS of the domain's stellar.toml",
          "definitive"
        );
      }

      return { result: { domain, signingKey, isVerified: true, tomlTimestamp } };
    } catch (err) {
      const failure =
        err instanceof DomainValidationError ? err : new DomainValidationError(errorMessage(err), "transient");
      this.log.info("SEP-1 domain validation failed", { domain, kind: failure.kind, error: failure.message });
      return {
        result: { domain, signingKey, isVerified: false, validationError: failure.message, tomlTimestamp },
        failureKind: failure.kind,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Tier transitions
// ---------------------------------------------------------------------------

/**
 * Verified → verified_business. A definitive failure (listing revoked, TOML
 * gone, domain dead) demotes at once; transient failures demote only once
 * `maxTransientFailures` have happened in a row.
 */
export function nextVerificationTier(
  current: MerchantVerificationTier,
  outcome: DomainValidationOutcome,
  consecutiveFailuresBefore: number,
  maxTransientFailures: number
): MerchantVerificationTier {
  if (outcome.result.isVerified) return "verified_business";
  if (outcome.failureKind === "definitive") return "unverified";
  return consecutiveFailuresBefore + 1 >= maxTransientFailures ? "unverified" : current;
}

// ---------------------------------------------------------------------------
// DomainValidationService — validate + persist tier changes
// ---------------------------------------------------------------------------

export interface MerchantVerificationResult extends Sep0001ValidationResult {
  merchantId: string;
  tierBefore: MerchantVerificationTier;
  verificationTier: MerchantVerificationTier;
}

export interface ReverificationSummary {
  checked: number;
  verified: number;
  promoted: number;
  demoted: number;
  errors: number;
}

export class MerchantNotFoundError extends Error {
  constructor(readonly merchantId: string) {
    super(`Merchant ${merchantId} not found`);
    this.name = "MerchantNotFoundError";
  }
}

export interface DomainValidationServiceOptions {
  store: MerchantDomainStore;
  validator?: DomainValidator;
  /** Consecutive transient failures before a verified merchant is demoted. Default 3 (≈3 days). */
  maxTransientFailures?: number;
  now?: () => Date;
  logger?: Logger;
}

export class DomainValidationService {
  private readonly store: MerchantDomainStore;
  private readonly validator: DomainValidator;
  private readonly maxTransientFailures: number;
  private readonly now: () => Date;
  private readonly log: Logger;

  constructor(options: DomainValidationServiceOptions) {
    this.store = options.store;
    this.validator = options.validator ?? new DomainValidator({ logger: options.logger });
    this.maxTransientFailures = options.maxTransientFailures ?? 3;
    this.now = options.now ?? (() => new Date());
    this.log = options.logger ?? log;
  }

  /**
   * Validates a merchant's home domain and persists the resulting tier.
   * When `domain` is given it becomes the merchant's home domain first
   * (resetting any verification earned on a previous domain).
   */
  async verifyMerchant(merchantId: string, domain?: string): Promise<MerchantVerificationResult> {
    if (domain !== undefined) {
      await this.store.setHomeDomain(merchantId, normalizeDomain(domain));
    }
    const merchant = await this.store.getMerchant(merchantId);
    if (!merchant) throw new MerchantNotFoundError(merchantId);
    if (!merchant.homeDomain) {
      throw new DomainValidationError("Merchant has no home domain to verify", "definitive");
    }
    return this.checkAndRecord(merchant);
  }

  /**
   * Daily sweep: re-validates every merchant whose domain was not checked
   * since the sweep began, demoting those whose listing was revoked.
   */
  async reverifyAll(options: { batchSize?: number; concurrency?: number } = {}): Promise<ReverificationSummary> {
    const batchSize = options.batchSize ?? 100;
    const concurrency = Math.max(1, options.concurrency ?? 5);
    const startedAt = this.now();
    const attempted = new Set<string>();
    const summary: ReverificationSummary = { checked: 0, verified: 0, promoted: 0, demoted: 0, errors: 0 };

    for (;;) {
      // Merchants recorded during this sweep drop out of the due set; ones
      // whose write failed stay due, so skip ids we already attempted.
      const due = (await this.store.listDueForRecheck(startedAt, batchSize)).filter((m) => !attempted.has(m.id));
      if (due.length === 0) break;
      due.forEach((m) => attempted.add(m.id));

      await runWithConcurrency(due, concurrency, async (merchant) => {
        try {
          const result = await this.checkAndRecord(merchant);
          summary.checked++;
          if (result.isVerified) summary.verified++;
          if (result.tierBefore !== "verified_business" && result.verificationTier === "verified_business") summary.promoted++;
          if (result.tierBefore === "verified_business" && result.verificationTier !== "verified_business") summary.demoted++;
        } catch (err) {
          summary.errors++;
          this.log.error("Domain re-verification failed", { merchantId: merchant.id, error: errorMessage(err) });
        }
      });
    }

    this.log.info("Merchant domain re-verification sweep complete", { ...summary });
    return summary;
  }

  private async checkAndRecord(merchant: MerchantDomainRecord): Promise<MerchantVerificationResult> {
    const outcome = await this.validator.validate(merchant.homeDomain ?? "", merchant.stellarAddress);
    const tierAfter = nextVerificationTier(
      merchant.verificationTier,
      outcome,
      merchant.consecutiveFailures,
      this.maxTransientFailures
    );
    await this.store.recordOutcome({ merchant, outcome, tierAfter, checkedAt: this.now() });

    if (tierAfter !== merchant.verificationTier) {
      this.log.info("Merchant verification tier changed", {
        merchantId: merchant.id,
        domain: outcome.result.domain,
        from: merchant.verificationTier,
        to: tierAfter,
        reason: outcome.result.validationError,
      });
    }
    return {
      ...outcome.result,
      merchantId: merchant.id,
      tierBefore: merchant.verificationTier,
      verificationTier: tierAfter,
    };
  }
}

async function runWithConcurrency<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await task(items[next++]);
  });
  await Promise.all(workers);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
