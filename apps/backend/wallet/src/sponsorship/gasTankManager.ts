/**
 * Gas Tank Wallet Manager
 *
 * Tracks the sponsor keypair, the daily ledger budget, and the per-account
 * stroop spend. Backed by Redis so multiple wallet-service replicas share
 * the same counters (same pattern as `FaucetRateLimiter`).
 *
 * Closes #398.
 */

import { Redis } from "ioredis";
import { createLogger, type Logger } from "@delegolabs/utils";
import type { GasSponsorshipPolicy, SponsorshipLedgerEntry } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DAY_SECONDS = 24 * 60 * 60;

const KEY_DAILY_LEDGERS = (utcDay: string) => `gasTank:dailyLedgers:${utcDay}`;
const KEY_ACCOUNT_SPEND = (account: string) => `gasTank:accountSpend:${account}`;
const KEY_LEDGER_LOG = "gasTank:ledgerLog";

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export interface GasTankManagerOptions {
  redis: Redis;
  policy: GasSponsorshipPolicy;
  /**
   * Sponsor secret key. If empty, `isConfigured()` returns false and every
   * eligibility check fails with `SPONSOR_NOT_CONFIGURED`.
   */
  sponsorSecret?: string;
  logger?: Logger;
  /** Injectable clock for tests. Defaults to `() => new Date()`. */
  now?: () => Date;
}

export class GasTankManager {
  private readonly redis: Redis;
  private readonly policy: GasSponsorshipPolicy;
  private readonly sponsorSecret: string;
  private readonly log: Logger;
  private readonly now: () => Date;

  constructor(options: GasTankManagerOptions) {
    this.redis = options.redis;
    this.policy = options.policy;
    this.sponsorSecret = options.sponsorSecret ?? "";
    this.log =
      options.logger ?? createLogger("wallet:gasTank", process.env.LOG_LEVEL ?? "info");
    this.now = options.now ?? (() => new Date());
  }

  // -- introspection --------------------------------------------------------

  isConfigured(): boolean {
    return this.sponsorSecret.length > 0;
  }

  getPolicy(): Readonly<GasSponsorshipPolicy> {
    return this.policy;
  }

  // -- daily ledger budget --------------------------------------------------

  private utcDay(d: Date): string {
    return d.toISOString().slice(0, 10); // YYYY-MM-DD
  }

  /**
   * Current number of sponsored ledgers in the rolling 24 h window
   * (UTC calendar day — simple, deterministic, matches the issue spec).
   */
  async getDailyLedgers(): Promise<number> {
    const key = KEY_DAILY_LEDGERS(this.utcDay(this.now()));
    const raw = await this.redis.get(key);
    return raw ? parseInt(raw, 10) : 0;
  }

  async getDailyRemaining(): Promise<number> {
    const used = await this.getDailyLedgers();
    return Math.max(0, this.policy.maxDailySponsoredLedgers - used);
  }

  // -- per-account budget ---------------------------------------------------

  async getAccountSpendStroops(account: string): Promise<bigint> {
    const raw = await this.redis.get(KEY_ACCOUNT_SPEND(account));
    return raw ? BigInt(raw) : 0n;
  }

  async getAccountRemainingStroops(account: string): Promise<bigint> {
    const spent = await this.getAccountSpendStroops(account);
    const cap = BigInt(this.policy.maxSpendPerAccountStroops);
    return spent >= cap ? 0n : cap - spent;
  }

  // -- atomic record --------------------------------------------------------

  /**
   * Record a successful sponsored ledger. Called *after* the transaction
   * has been confirmed by the RPC. Increments both counters atomically.
   */
  async recordSponsored(entry: SponsorshipLedgerEntry): Promise<void> {
    const utcDay = this.utcDay(this.now());

    // INCR + EXPIRE keep the daily counter self-cleaning; if this is the
    // first increment of the day we set the TTL to 24 h + 1 h of slack.
    const dailyKey = KEY_DAILY_LEDGERS(utcDay);
    const next = await this.redis.incr(dailyKey);
    if (next === 1) {
      await this.redis.expire(dailyKey, DAY_SECONDS + 3600);
    }

    // Per-account spend is lifetime, no TTL.
    await this.redis.incrby(KEY_ACCOUNT_SPEND(entry.account), Number(entry.feeStroops));

    // Append to the audit log (capped; LTRIM is a no-op if length < cap).
    await this.redis.lpush(KEY_LEDGER_LOG, JSON.stringify(entry));
    await this.redis.ltrim(KEY_LEDGER_LOG, 0, 999);

    this.log.info("Sponsorship recorded", {
      account: entry.account,
      contractId: entry.contractId,
      feeStroops: entry.feeStroops,
      txHash: entry.txHash,
      dailyLedgersAfter: next,
    });
  }

  /** Recent sponsored submissions, newest first. */
  async recentLedgers(limit: number = 50): Promise<SponsorshipLedgerEntry[]> {
    const raw = await this.redis.lrange(KEY_LEDGER_LOG, 0, Math.max(0, limit - 1));
    return raw.map((s) => JSON.parse(s) as SponsorshipLedgerEntry);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createGasTankManager(options: GasTankManagerOptions): GasTankManager {
  return new GasTankManager(options);
}
