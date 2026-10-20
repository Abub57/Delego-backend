/**
 * Persistence for merchant SEP-1 domain verification (migration 048).
 */

import { QueryTypes, type Sequelize } from "sequelize";
import type { DomainValidationOutcome, MerchantVerificationTier } from "./domainValidationService.js";

export interface MerchantDomainRecord {
  id: string;
  ownerUserId: string;
  stellarAddress: string;
  homeDomain: string | null;
  verificationTier: MerchantVerificationTier;
  consecutiveFailures: number;
}

export interface RecordOutcomeInput {
  merchant: MerchantDomainRecord;
  outcome: DomainValidationOutcome;
  tierAfter: MerchantVerificationTier;
  checkedAt: Date;
}

export interface MerchantDomainStore {
  getMerchant(merchantId: string): Promise<MerchantDomainRecord | null>;
  /** Changing the domain drops any verification earned on the old one. */
  setHomeDomain(merchantId: string, domain: string): Promise<void>;
  /** Updates the merchant's tier/status and appends an audit row, atomically. */
  recordOutcome(input: RecordOutcomeInput): Promise<void>;
  /** Merchants with a domain not checked since `checkedBefore`, oldest first. */
  listDueForRecheck(checkedBefore: Date, limit: number): Promise<MerchantDomainRecord[]>;
}

interface MerchantRow {
  id: string;
  owner_user_id: string;
  stellar_address: string;
  home_domain: string | null;
  verification_tier: MerchantVerificationTier;
  domain_consecutive_failures: number;
}

const MERCHANT_COLUMNS = `id, owner_user_id, stellar_address, home_domain, verification_tier, domain_consecutive_failures`;

function toRecord(row: MerchantRow): MerchantDomainRecord {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    stellarAddress: row.stellar_address,
    homeDomain: row.home_domain,
    verificationTier: row.verification_tier,
    consecutiveFailures: Number(row.domain_consecutive_failures),
  };
}

export class SequelizeMerchantDomainStore implements MerchantDomainStore {
  constructor(private readonly sequelize: Sequelize) {}

  async getMerchant(merchantId: string): Promise<MerchantDomainRecord | null> {
    const rows = await this.sequelize.query<MerchantRow>(
      `SELECT ${MERCHANT_COLUMNS} FROM merchants WHERE id = :merchantId`,
      { type: QueryTypes.SELECT, replacements: { merchantId } }
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async setHomeDomain(merchantId: string, domain: string): Promise<void> {
    await this.sequelize.query(
      `UPDATE merchants
          SET home_domain                 = :domain,
              verification_tier           = 'unverified',
              domain_verified_at          = NULL,
              domain_verification_error   = NULL,
              domain_consecutive_failures = 0,
              updated_at                  = NOW()
        WHERE id = :merchantId
          AND home_domain IS DISTINCT FROM :domain`,
      { replacements: { merchantId, domain } }
    );
  }

  async recordOutcome({ merchant, outcome, tierAfter, checkedAt }: RecordOutcomeInput): Promise<void> {
    const { result, failureKind } = outcome;
    await this.sequelize.transaction(async (transaction) => {
      await this.sequelize.query(
        `UPDATE merchants
            SET verification_tier           = :tierAfter,
                domain_last_checked_at      = :checkedAt,
                domain_verification_error   = :error,
                domain_verified_at          = CASE WHEN :verified THEN :checkedAt ELSE domain_verified_at END,
                domain_consecutive_failures = CASE WHEN :verified THEN 0 ELSE domain_consecutive_failures + 1 END,
                updated_at                  = NOW()
          WHERE id = :merchantId`,
        {
          transaction,
          replacements: {
            merchantId: merchant.id,
            tierAfter,
            checkedAt,
            verified: result.isVerified,
            error: result.validationError ?? null,
          },
        }
      );
      await this.sequelize.query(
        `INSERT INTO merchant_domain_verifications
           (merchant_id, domain, signing_key, is_verified, failure_kind, validation_error,
            toml_fetched_at, tier_before, tier_after, checked_at)
         VALUES
           (:merchantId, :domain, :signingKey, :verified, :failureKind, :error,
            :tomlFetchedAt, :tierBefore, :tierAfter, :checkedAt)`,
        {
          transaction,
          replacements: {
            merchantId: merchant.id,
            domain: result.domain,
            signingKey: result.signingKey || null,
            verified: result.isVerified,
            failureKind: failureKind ?? null,
            error: result.validationError ?? null,
            tomlFetchedAt: result.tomlTimestamp ?? null,
            tierBefore: merchant.verificationTier,
            tierAfter,
            checkedAt,
          },
        }
      );
    });
  }

  async listDueForRecheck(checkedBefore: Date, limit: number): Promise<MerchantDomainRecord[]> {
    const rows = await this.sequelize.query<MerchantRow>(
      `SELECT ${MERCHANT_COLUMNS}
         FROM merchants
        WHERE home_domain IS NOT NULL
          AND (domain_last_checked_at IS NULL OR domain_last_checked_at < :checkedBefore)
        ORDER BY domain_last_checked_at NULLS FIRST, id
        LIMIT :limit`,
      { type: QueryTypes.SELECT, replacements: { checkedBefore, limit } }
    );
    return rows.map(toRecord);
  }
}

/** In-memory store for tests and local development. */
export class InMemoryMerchantDomainStore implements MerchantDomainStore {
  readonly merchants = new Map<string, MerchantDomainRecord & { lastCheckedAt: Date | null }>();
  readonly audit: RecordOutcomeInput[] = [];

  add(record: MerchantDomainRecord, lastCheckedAt: Date | null = null): void {
    this.merchants.set(record.id, { ...record, lastCheckedAt });
  }

  async getMerchant(merchantId: string): Promise<MerchantDomainRecord | null> {
    const found = this.merchants.get(merchantId);
    if (!found) return null;
    const { lastCheckedAt: _ignored, ...record } = found;
    return record;
  }

  async setHomeDomain(merchantId: string, domain: string): Promise<void> {
    const found = this.merchants.get(merchantId);
    if (!found || found.homeDomain === domain) return;
    Object.assign(found, { homeDomain: domain, verificationTier: "unverified", consecutiveFailures: 0 });
  }

  async recordOutcome(input: RecordOutcomeInput): Promise<void> {
    const found = this.merchants.get(input.merchant.id);
    if (!found) return;
    found.verificationTier = input.tierAfter;
    found.consecutiveFailures = input.outcome.result.isVerified ? 0 : found.consecutiveFailures + 1;
    found.lastCheckedAt = input.checkedAt;
    this.audit.push(input);
  }

  async listDueForRecheck(checkedBefore: Date, limit: number): Promise<MerchantDomainRecord[]> {
    return [...this.merchants.values()]
      .filter((m) => m.homeDomain && (!m.lastCheckedAt || m.lastCheckedAt < checkedBefore))
      .sort((a, b) => (a.lastCheckedAt?.getTime() ?? 0) - (b.lastCheckedAt?.getTime() ?? 0) || a.id.localeCompare(b.id))
      .slice(0, limit)
      .map(({ lastCheckedAt: _ignored, ...record }) => record);
  }
}
