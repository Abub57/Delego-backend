/**
 * #597 — Background worker for merchant custom-domain SSL provisioning.
 *
 * Merchants point their storefront domain (e.g. `shop.merchant.com`) at a
 * Delego edge hostname with a CNAME record. This worker periodically:
 *
 *   1. resolves the custom domain's CNAME records with `node:dns/promises`,
 *   2. confirms the record points at a Delego edge target,
 *   3. completes the Let's Encrypt http-01 challenge through the ACME client,
 *   4. stores the issued certificate + private key encrypted (AES-256-GCM).
 *
 * DNS propagation is not instantaneous, so unresolved/mismatched domains stay
 * pending and are retried on the next cycle instead of failing permanently.
 */
import { resolveCname } from "node:dns/promises";
import { createLogger, type Logger } from "@delegolabs/utils";
import type { AcmeCertProvisionResult, DomainVerificationJobData } from "@delegolabs/types";
import { createAcmeClient, type AcmeClient } from "./acme/client.js";
import type { Http01ChallengeResponder } from "./acme/http01.js";
import { InMemoryHttp01ChallengeResponder } from "./acme/http01.js";
import { Pool } from "pg";
import {
  PostgresDomainCertificateVault,
  PostgresDomainVerificationJobSource,
  type DomainCertificateVault,
  type DomainVerificationJobSource,
} from "./store/domainCertificateStore.js";

export type { AcmeCertProvisionResult, DomainVerificationJobData };
export type { DomainVerificationJob } from "./store/domainCertificateStore.js";

export const DEFAULT_EDGE_CNAME_TARGET = "edge.delego.io";
export const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
export const DEFAULT_BATCH_SIZE = 25;
export const DEFAULT_RENEW_BEFORE_DAYS = 30;

// ─── DNS resolution & CNAME matching ────────────────────────────────────────

export interface DomainResolver {
  resolveCname(hostname: string): Promise<string[]>;
}

/** Resolver backed by `node:dns/promises`, with a bounded lookup timeout. */
export class NodeDnsResolver implements DomainResolver {
  private readonly timeoutMs: number;

  constructor(timeoutMs: number = Number(process.env.CERT_DNS_TIMEOUT_MS ?? 5000)) {
    this.timeoutMs = timeoutMs;
  }

  async resolveCname(hostname: string): Promise<string[]> {
    return withTimeout(resolveCname(normalizeDomain(hostname)), this.timeoutMs);
  }
}

export type CnameVerificationFailure =
  | "no_cname_record"
  | "cname_mismatch"
  | "not_delego_edge"
  | "dns_error";

export interface CnameVerificationResult {
  verified: boolean;
  resolvedCnames: string[];
  reason?: CnameVerificationFailure;
  error?: string;
}

/** Lowercases and drops the trailing dot DNS servers include in answers. */
export function normalizeDomain(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/\.+$/, "");
}

/**
 * True when any resolved CNAME is the expected target or a subdomain of it.
 * Edge hostnames are per-merchant (`m_123.edge.delego.io`), so an exact match
 * alone would reject valid allocations.
 */
export function isCnamePointingToTarget(cnames: string[], targetCname: string): boolean {
  const target = normalizeDomain(targetCname);
  if (!target) return false;
  return cnames.some((record) => {
    const cname = normalizeDomain(record);
    return cname === target || cname.endsWith(`.${target}`);
  });
}

/** True when any resolved CNAME belongs to the configured Delego edge zones. */
export function isCnamePointingToEdge(cnames: string[], edgeTargets: string[]): boolean {
  const targets = edgeTargets.map(normalizeDomain).filter(Boolean);
  if (targets.length === 0) return false;
  return cnames.some((record) => {
    const cname = normalizeDomain(record);
    return targets.some((target) => cname === target || cname.endsWith(`.${target}`));
  });
}

const PROVISIONABLE_DOMAIN =
  /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;

/** Rejects wildcards, IPs and malformed identifiers before they reach ACME. */
export function assertProvisionableDomain(domain: string): void {
  if (domain.startsWith("*.")) {
    throw new Error("wildcard domains are not supported for merchant custom domains");
  }
  if (!PROVISIONABLE_DOMAIN.test(domain)) {
    throw new Error(`invalid merchant custom domain: ${domain}`);
  }
}

// ─── Worker ─────────────────────────────────────────────────────────────────

export interface DomainVerificationCycleSummary {
  checked: number;
  verified: number;
  provisioned: number;
  pending: number;
  failed: number;
  errors: Array<{ merchantId: string; domain: string; error: string }>;
}

export interface DomainVerificationWorkerOptions {
  jobSource: DomainVerificationJobSource;
  vault: DomainCertificateVault;
  resolver?: DomainResolver;
  acmeClient?: AcmeClient;
  responder?: Http01ChallengeResponder;
  /** Let's Encrypt ACME account key (JWK/PEM); required for CERT_ACME_MODE=http. */
  acmeAccountKey?: string;
  acmeMode?: "stub" | "http";
  /** Delego edge hostnames a custom domain's CNAME must resolve under. */
  edgeCnameTargets?: string[];
  renewBeforeDays?: number;
  batchSize?: number;
  intervalMs?: number;
  log?: Logger;
  onCycleComplete?: (summary: DomainVerificationCycleSummary) => void;
  onError?: (err: unknown) => void;
}

export class DomainVerificationWorker {
  private readonly jobSource: DomainVerificationJobSource;
  private readonly vault: DomainCertificateVault;
  private readonly resolver: DomainResolver;
  private readonly acmeClient?: AcmeClient;
  private readonly responder: Http01ChallengeResponder;
  private readonly acmeAccountKey: string;
  private readonly acmeMode: "stub" | "http";
  private readonly edgeCnameTargets: string[];
  private readonly renewBeforeDays: number;
  private readonly batchSize: number;
  private readonly intervalMs: number;
  private readonly log: Logger;
  private readonly onCycleComplete?: (summary: DomainVerificationCycleSummary) => void;
  private readonly onError?: (err: unknown) => void;
  private timer: NodeJS.Timeout | null = null;

  constructor(options: DomainVerificationWorkerOptions) {
    this.jobSource = options.jobSource;
    this.vault = options.vault;
    this.resolver = options.resolver ?? new NodeDnsResolver();
    this.acmeClient = options.acmeClient;
    this.responder = options.responder ?? new InMemoryHttp01ChallengeResponder();
    this.acmeAccountKey = options.acmeAccountKey ?? process.env.CERT_ACME_ACCOUNT_KEY ?? "";
    this.acmeMode = options.acmeMode ?? (process.env.CERT_ACME_MODE === "http" ? "http" : "stub");
    this.edgeCnameTargets = options.edgeCnameTargets ?? parseEdgeTargets();
    this.renewBeforeDays = options.renewBeforeDays ?? Number(process.env.CERT_RENEW_BEFORE_DAYS ?? DEFAULT_RENEW_BEFORE_DAYS);
    this.batchSize = options.batchSize ?? Number(process.env.CERT_DOMAIN_WORKER_BATCH_SIZE ?? DEFAULT_BATCH_SIZE);
    this.intervalMs = options.intervalMs ?? Number(process.env.CERT_DOMAIN_WORKER_INTERVAL_MS ?? DEFAULT_INTERVAL_MS);
    this.log = options.log ?? createLogger("certmanager:domain-worker");
    this.onCycleComplete = options.onCycleComplete;
    this.onError = options.onError;
  }

  /**
   * Checks whether the merchant's custom domain currently CNAMEs to the
   * expected Delego edge target. DNS errors other than "no record" are
   * transient and reported without provisioning.
   */
  async verifyDomain(job: DomainVerificationJobData): Promise<CnameVerificationResult> {
    let resolvedCnames: string[];
    try {
      resolvedCnames = await this.resolver.resolveCname(job.customDomain);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENODATA" || code === "ENOTFOUND") {
        return { verified: false, resolvedCnames: [], reason: "no_cname_record" };
      }
      return {
        verified: false,
        resolvedCnames: [],
        reason: "dns_error",
        error: errorMessage(err),
      };
    }

    if (resolvedCnames.length === 0) {
      return { verified: false, resolvedCnames: [], reason: "no_cname_record" };
    }

    if (!isCnamePointingToTarget(resolvedCnames, job.targetCname)) {
      return { verified: false, resolvedCnames, reason: "cname_mismatch" };
    }

    if (this.edgeCnameTargets.length > 0 && !isCnamePointingToEdge(resolvedCnames, this.edgeCnameTargets)) {
      return { verified: false, resolvedCnames, reason: "not_delego_edge" };
    }

    return { verified: true, resolvedCnames };
  }

  /**
   * Runs the http-01 ACME order for a verified domain and persists the issued
   * certificate + key encrypted. Returns the issue contract from #597.
   */
  async provisionCertificate(job: DomainVerificationJobData): Promise<AcmeCertProvisionResult> {
    const domain = normalizeDomain(job.customDomain);
    assertProvisionableDomain(domain);

    const acme =
      this.acmeClient ??
      createAcmeClient({
        provider: "letsencrypt",
        accountKey: this.acmeAccountKey,
        mode: this.acmeMode,
      });

    const issued = await acme.issue({
      domains: [domain],
      challengeType: "http-01",
      wildcardEnabled: false,
      present: async (challenge) => {
        await this.responder.present({
          domain,
          token: challenge.token ?? challenge.value,
          keyAuthorization: challenge.value,
        });
      },
      cleanup: async (challenge) => {
        await this.responder.cleanup({
          domain,
          token: challenge.token ?? challenge.value,
          keyAuthorization: challenge.value,
        });
      },
    });

    if (!issued.certificatePem || !issued.privateKeyPem) {
      throw new Error("ACME client returned an incomplete certificate");
    }

    const expiresAt = new Date(issued.notAfter).toISOString();
    const renewBefore = new Date(
      new Date(expiresAt).getTime() - this.renewBeforeDays * 24 * 60 * 60 * 1000,
    ).toISOString();

    const result: AcmeCertProvisionResult = {
      domain,
      certificatePem: issued.certificatePem,
      privateKeyPem: issued.privateKeyPem,
      expiresAt,
      renewBefore,
    };

    await this.vault.save(job.merchantId, result);
    return result;
  }

  /** Processes one batch of pending domain verification jobs. */
  async runCycle(): Promise<DomainVerificationCycleSummary> {
    const jobs = await this.jobSource.listPending(this.batchSize);
    const summary: DomainVerificationCycleSummary = {
      checked: 0,
      verified: 0,
      provisioned: 0,
      pending: 0,
      failed: 0,
      errors: [],
    };

    for (const job of jobs) {
      summary.checked++;
      const verification = await this.verifyDomain(job);

      if (!verification.verified) {
        summary.pending++;
        await this.jobSource.markPending(job, describeVerificationFailure(verification));
        this.log.info("custom domain pending DNS verification", {
          merchantId: job.merchantId,
          domain: job.customDomain,
          reason: verification.reason,
          resolvedCnames: verification.resolvedCnames,
        });
        continue;
      }

      summary.verified++;
      try {
        await this.provisionCertificate(job);
        await this.jobSource.markCompleted(job);
        summary.provisioned++;
        this.log.info("provisioned custom domain certificate", {
          merchantId: job.merchantId,
          domain: job.customDomain,
        });
      } catch (err) {
        const message = errorMessage(err);
        summary.failed++;
        summary.errors.push({ merchantId: job.merchantId, domain: job.customDomain, error: message });
        await this.jobSource.markPending(job, message);
        this.log.error("custom domain certificate provisioning failed", {
          merchantId: job.merchantId,
          domain: job.customDomain,
          error: message,
        });
      }
    }

    this.onCycleComplete?.(summary);
    return summary;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.runCycle().catch((err) => {
        this.log.error("domain verification cycle failed", { error: errorMessage(err) });
        this.onError?.(err);
      });
    }, this.intervalMs);
    this.log.info("domain verification worker started", {
      intervalMs: this.intervalMs,
      batchSize: this.batchSize,
      edgeCnameTargets: this.edgeCnameTargets,
    });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.log.info("domain verification worker stopped");
    }
  }

  /** Exposed for the readiness probe / tests. */
  get isRunning(): boolean {
    return this.timer !== null;
  }
}

// ─── Convenience factory ────────────────────────────────────────────────────

export interface StartDomainVerificationWorkerOptions
  extends Partial<Omit<DomainVerificationWorkerOptions, "jobSource" | "vault">> {
  pool?: Pool;
  jobSource?: DomainVerificationJobSource;
  vault?: DomainCertificateVault;
}

/**
 * Production entrypoint: wires the PostgreSQL job source + encrypted vault
 * (unless injected) and starts the periodic loop. Returns the worker so the
 * caller can stop it during graceful shutdown.
 */
export function startDomainVerificationWorker(
  options: StartDomainVerificationWorkerOptions = {},
): DomainVerificationWorker {
  const { pool, jobSource, vault, ...workerOptions } = options;
  const db = pool ?? getSharedPool();
  const worker = new DomainVerificationWorker({
    ...workerOptions,
    jobSource: jobSource ?? new PostgresDomainVerificationJobSource(db),
    vault: vault ?? new PostgresDomainCertificateVault(db),
  });
  worker.start();
  return worker;
}

let sharedPool: Pool | null = null;

function getSharedPool(): Pool {
  if (!sharedPool) {
    sharedPool = new Pool({
      connectionString: process.env.DATABASE_URL ?? "postgresql://delego:delego@localhost:5432/delego",
    });
  }
  return sharedPool;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function parseEdgeTargets(): string[] {
  const configured = process.env.CERT_EDGE_CNAME_TARGETS;
  if (!configured) return [DEFAULT_EDGE_CNAME_TARGET];
  return configured
    .split(",")
    .map((target) => target.trim())
    .filter(Boolean);
}

function describeVerificationFailure(result: CnameVerificationResult): string {
  const reason = result.reason ?? "dns_error";
  if (result.error) return `${reason}: ${result.error}`;
  if (result.resolvedCnames.length > 0) {
    return `${reason}: resolved to ${result.resolvedCnames.join(", ")}`;
  }
  return reason;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`DNS lookup timed out after ${timeoutMs}ms`) as NodeJS.ErrnoException;
      err.code = "ETIMEDOUT";
      reject(err);
    }, timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
