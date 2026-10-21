import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { decryptField, encryptField } from "@delegolabs/utils";
import type {
  AcmeCertProvisionResult,
  DomainVerificationJobData,
  EncryptedField,
} from "@delegolabs/types";

/**
 * #597 — Durable storage for custom-domain verification jobs and the
 * certificates issued for them. Certificate and private-key PEMs are encrypted
 * with AES-256-GCM before they ever reach the database; the merchant/domain is
 * bound in as AAD so a ciphertext cannot be replayed onto another merchant's
 * row.
 */

export interface DomainVerificationJob extends DomainVerificationJobData {
  attempts: number;
  lastCheckedAt?: string;
  lastError?: string;
}

export interface DomainVerificationJobSource {
  /** Jobs awaiting DNS verification, oldest first. */
  listPending(limit: number): Promise<DomainVerificationJob[]>;
  /** CNAME matched and the certificate was issued. */
  markCompleted(job: DomainVerificationJob): Promise<void>;
  /** Verification or issuance failed; retry on the next cycle. */
  markPending(job: DomainVerificationJob, error: string): Promise<void>;
}

export interface DomainCertificateVault {
  save(merchantId: string, result: AcmeCertProvisionResult): Promise<void>;
  get(merchantId: string, domain: string): Promise<AcmeCertProvisionResult | undefined>;
}

// ─── Encryption ─────────────────────────────────────────────────────────────

export const CERT_PEM_ENCRYPTION_KEY_ENV = "CERT_PEM_ENCRYPTION_KEY";
const DEVELOPMENT_PEM_KEY = "delego-certmanager-development-pem-key";
const PEM_CONTEXT_PURPOSE = "tls-certificate";

/**
 * Resolves the 32-byte AES key from `CERT_PEM_ENCRYPTION_KEY` (64-char hex,
 * 32-byte base64, or arbitrary passphrase hashed with SHA-256). Production
 * refuses to start without an explicit key.
 */
export function resolvePemEncryptionKey(
  secret: string | undefined = process.env[CERT_PEM_ENCRYPTION_KEY_ENV],
): Buffer {
  let value = secret;
  if (!value) {
    if ((process.env.NODE_ENV ?? "development") === "production") {
      throw new Error(`${CERT_PEM_ENCRYPTION_KEY_ENV} must be set in production`);
    }
    value = DEVELOPMENT_PEM_KEY;
  }

  if (/^[0-9a-f]{64}$/i.test(value)) return Buffer.from(value, "hex");
  const base64 = Buffer.from(value, "base64");
  if (base64.length === 32) return base64;
  return createHash("sha256").update(value, "utf8").digest();
}

export interface EncryptedCertificateRecord {
  merchantId: string;
  domain: string;
  certificatePem: EncryptedField;
  privateKeyPem: EncryptedField;
  expiresAt: string;
  renewBefore: string;
  updatedAt: string;
}

function encryptionContext(merchantId: string, domain: string): Record<string, string> {
  return { merchantId, domain, purpose: PEM_CONTEXT_PURPOSE };
}

export function encryptCertificateResult(
  merchantId: string,
  result: AcmeCertProvisionResult,
  key: Buffer,
): EncryptedCertificateRecord {
  const context = encryptionContext(merchantId, result.domain);
  return {
    merchantId,
    domain: result.domain,
    certificatePem: encryptField(result.certificatePem, key, "AES-256-GCM", context),
    privateKeyPem: encryptField(result.privateKeyPem, key, "AES-256-GCM", context),
    expiresAt: result.expiresAt,
    renewBefore: result.renewBefore,
    updatedAt: new Date().toISOString(),
  };
}

export function decryptCertificateResult(
  record: EncryptedCertificateRecord,
  key: Buffer,
): AcmeCertProvisionResult {
  const context = encryptionContext(record.merchantId, record.domain);
  return {
    domain: record.domain,
    certificatePem: decryptField(record.certificatePem, key, context),
    privateKeyPem: decryptField(record.privateKeyPem, key, context),
    expiresAt: record.expiresAt,
    renewBefore: record.renewBefore,
  };
}

// ─── In-memory implementations (tests / local development) ──────────────────

export class InMemoryDomainCertificateVault implements DomainCertificateVault {
  public readonly records = new Map<string, EncryptedCertificateRecord>();
  private readonly key: Buffer;

  constructor(options: { key?: Buffer } = {}) {
    this.key = options.key ?? resolvePemEncryptionKey();
  }

  async save(merchantId: string, result: AcmeCertProvisionResult): Promise<void> {
    this.records.set(this.recordKey(merchantId, result.domain), encryptCertificateResult(merchantId, result, this.key));
  }

  async get(merchantId: string, domain: string): Promise<AcmeCertProvisionResult | undefined> {
    const record = this.records.get(this.recordKey(merchantId, domain));
    return record ? decryptCertificateResult(record, this.key) : undefined;
  }

  private recordKey(merchantId: string, domain: string): string {
    return `${merchantId}:${domain}`;
  }
}

export class InMemoryDomainVerificationJobSource implements DomainVerificationJobSource {
  private readonly jobs = new Map<string, { job: DomainVerificationJob; status: "pending" | "completed" }>();

  constructor(initial: DomainVerificationJobData[] = []) {
    for (const job of initial) this.enqueue(job);
  }

  enqueue(job: DomainVerificationJobData): void {
    this.jobs.set(this.jobKey(job), {
      job: { ...job, attempts: 0 },
      status: "pending",
    });
  }

  async listPending(limit: number): Promise<DomainVerificationJob[]> {
    return [...this.jobs.values()]
      .filter((entry) => entry.status === "pending")
      .slice(0, Math.max(1, limit))
      .map((entry) => ({ ...entry.job }));
  }

  async markCompleted(job: DomainVerificationJob): Promise<void> {
    const entry = this.jobs.get(this.jobKey(job));
    if (!entry) return;
    entry.status = "completed";
    entry.job = { ...entry.job, attempts: entry.job.attempts + 1, lastCheckedAt: new Date().toISOString() };
  }

  async markPending(job: DomainVerificationJob, error: string): Promise<void> {
    const entry = this.jobs.get(this.jobKey(job));
    if (!entry) return;
    entry.job = {
      ...entry.job,
      attempts: entry.job.attempts + 1,
      lastCheckedAt: new Date().toISOString(),
      lastError: error,
    };
  }

  /** Test helper: inspect a job regardless of its status. */
  peek(merchantId: string, customDomain: string): DomainVerificationJob | undefined {
    return this.jobs.get(`${merchantId}:${customDomain}`)?.job;
  }

  private jobKey(job: DomainVerificationJobData): string {
    return `${job.merchantId}:${job.customDomain}`;
  }
}

// ─── PostgreSQL implementations ─────────────────────────────────────────────

export class PostgresDomainVerificationJobSource implements DomainVerificationJobSource {
  private schemaReady?: Promise<void>;

  constructor(private readonly pool: Pool) {}

  async enqueue(job: DomainVerificationJobData): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(
      `INSERT INTO domain_verification_jobs (merchant_id, custom_domain, target_cname, status)
       VALUES ($1, $2, $3, 'pending')
       ON CONFLICT (merchant_id, custom_domain) DO UPDATE
       SET target_cname = EXCLUDED.target_cname,
           status = 'pending',
           last_error = NULL`,
      [job.merchantId, job.customDomain, job.targetCname],
    );
  }

  async listPending(limit: number): Promise<DomainVerificationJob[]> {
    await this.ensureSchema();
    const { rows } = await this.pool.query<{
      merchant_id: string;
      custom_domain: string;
      target_cname: string;
      attempts: number;
      last_checked_at: Date | null;
      last_error: string | null;
    }>(
      `SELECT merchant_id, custom_domain, target_cname, attempts, last_checked_at, last_error
       FROM domain_verification_jobs
       WHERE status = 'pending'
       ORDER BY created_at ASC
       LIMIT $1`,
      [Math.max(1, limit)],
    );
    return rows.map((row) => ({
      merchantId: row.merchant_id,
      customDomain: row.custom_domain,
      targetCname: row.target_cname,
      attempts: row.attempts,
      lastCheckedAt: row.last_checked_at?.toISOString(),
      lastError: row.last_error ?? undefined,
    }));
  }

  async markCompleted(job: DomainVerificationJob): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(
      `UPDATE domain_verification_jobs
       SET status = 'completed',
           attempts = attempts + 1,
           last_checked_at = NOW(),
           last_error = NULL,
           updated_at = NOW()
       WHERE merchant_id = $1 AND custom_domain = $2`,
      [job.merchantId, job.customDomain],
    );
  }

  async markPending(job: DomainVerificationJob, error: string): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(
      `UPDATE domain_verification_jobs
       SET attempts = attempts + 1,
           last_checked_at = NOW(),
           last_error = $3,
           updated_at = NOW()
       WHERE merchant_id = $1 AND custom_domain = $2`,
      [job.merchantId, job.customDomain, error],
    );
  }

  private ensureSchema(): Promise<void> {
    this.schemaReady ??= this.pool
      .query(
        `CREATE TABLE IF NOT EXISTS domain_verification_jobs (
           merchant_id TEXT NOT NULL,
           custom_domain TEXT NOT NULL,
           target_cname TEXT NOT NULL,
           status TEXT NOT NULL DEFAULT 'pending',
           attempts INTEGER NOT NULL DEFAULT 0,
           last_checked_at TIMESTAMPTZ,
           last_error TEXT,
           created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           PRIMARY KEY (merchant_id, custom_domain)
         )`,
      )
      .then(() => undefined);
    return this.schemaReady;
  }
}

interface DomainCertificateRow {
  merchant_id: string;
  domain: string;
  certificate_pem: EncryptedField | string;
  private_key_pem: EncryptedField | string;
  expires_at: Date | string;
  renew_before: Date | string;
  updated_at: Date | string;
}

export class PostgresDomainCertificateVault implements DomainCertificateVault {
  private readonly key: Buffer;
  private schemaReady?: Promise<void>;

  constructor(
    private readonly pool: Pool,
    options: { key?: Buffer } = {},
  ) {
    this.key = options.key ?? resolvePemEncryptionKey();
  }

  async save(merchantId: string, result: AcmeCertProvisionResult): Promise<void> {
    await this.ensureSchema();
    const record = encryptCertificateResult(merchantId, result, this.key);
    await this.pool.query(
      `INSERT INTO domain_certificates
         (merchant_id, domain, certificate_pem, private_key_pem, expires_at, renew_before, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (merchant_id, domain) DO UPDATE
       SET certificate_pem = EXCLUDED.certificate_pem,
           private_key_pem = EXCLUDED.private_key_pem,
           expires_at = EXCLUDED.expires_at,
           renew_before = EXCLUDED.renew_before,
           updated_at = NOW()`,
      [
        merchantId,
        result.domain,
        JSON.stringify(record.certificatePem),
        JSON.stringify(record.privateKeyPem),
        result.expiresAt,
        result.renewBefore,
      ],
    );
  }

  async get(merchantId: string, domain: string): Promise<AcmeCertProvisionResult | undefined> {
    await this.ensureSchema();
    const { rows } = await this.pool.query<DomainCertificateRow>(
      `SELECT merchant_id, domain, certificate_pem, private_key_pem, expires_at, renew_before, updated_at
       FROM domain_certificates
       WHERE merchant_id = $1 AND domain = $2`,
      [merchantId, domain],
    );
    const row = rows[0];
    if (!row) return undefined;
    return decryptCertificateResult(
      {
        merchantId: row.merchant_id,
        domain: row.domain,
        certificatePem: parseEncryptedField(row.certificate_pem),
        privateKeyPem: parseEncryptedField(row.private_key_pem),
        expiresAt: toIsoString(row.expires_at),
        renewBefore: toIsoString(row.renew_before),
        updatedAt: toIsoString(row.updated_at),
      },
      this.key,
    );
  }

  private ensureSchema(): Promise<void> {
    this.schemaReady ??= this.pool
      .query(
        `CREATE TABLE IF NOT EXISTS domain_certificates (
           merchant_id TEXT NOT NULL,
           domain TEXT NOT NULL,
           certificate_pem JSONB NOT NULL,
           private_key_pem JSONB NOT NULL,
           expires_at TIMESTAMPTZ NOT NULL,
           renew_before TIMESTAMPTZ NOT NULL,
           updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           PRIMARY KEY (merchant_id, domain)
         )`,
      )
      .then(() => undefined);
    return this.schemaReady;
  }
}

function parseEncryptedField(value: EncryptedField | string): EncryptedField {
  return typeof value === "string" ? (JSON.parse(value) as EncryptedField) : value;
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
