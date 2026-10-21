/**
 * Reputation Flag Event Processor (Issue #reputation-flag)
 *
 * Consumes `reputation_flagged` Soroban contract events emitted by
 * decentralised validators. For each event:
 *   1. Persists the penalty points to the database.
 *   2. Suspends the merchant storefront (sets is_active = false) if the
 *      total penalty score exceeds SUSPENSION_THRESHOLD (100 points).
 *   3. Dispatches a critical notification to the merchant with
 *      dispute instructions.
 */

import { createLogger } from "@delegolabs/utils";
import { Pool } from "pg";
import { publishPaymentEvent } from "../../events/index.js";

const log = createLogger("payments:reputation-flag", process.env.LOG_LEVEL ?? "info");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Penalty score above which the merchant storefront is auto-suspended. */
export const SUSPENSION_THRESHOLD = 100;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ReputationFlagEvent {
  contractId: string;
  merchantAddress: string;
  reporterAddress: string;
  penaltyPoints: number;
  reasonCode: number;
  ledger: number;
}

export interface MerchantPenaltyRecord {
  merchantAddress: string;
  totalPenaltyScore: number;
  isActive: boolean;
  lastFlaggedAt: string;
}

// ---------------------------------------------------------------------------
// Database helpers
// ---------------------------------------------------------------------------

let pool: Pool | null = null;

function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL ?? "postgresql://delego:delego@localhost:5432/delego",
    });
  }
  return pool;
}

export function _setPoolForTesting(testPool: Pool): void {
  pool = testPool;
}

export function _resetPoolForTesting(): void {
  pool = null;
}

/**
 * Upserts the merchant's penalty score and returns the updated record.
 * Uses a single atomic SQL statement to avoid race conditions.
 */
async function upsertMerchantPenalty(
  merchantAddress: string,
  penaltyPoints: number
): Promise<MerchantPenaltyRecord> {
  const { rows } = await getPool().query<{
    merchant_address: string;
    total_penalty_score: number;
    is_active: boolean;
    last_flagged_at: Date;
  }>(
    `INSERT INTO merchant_penalty_scores
       (merchant_address, total_penalty_score, is_active, last_flagged_at, created_at, updated_at)
     VALUES ($1, $2, true, NOW(), NOW(), NOW())
     ON CONFLICT (merchant_address) DO UPDATE
       SET total_penalty_score = merchant_penalty_scores.total_penalty_score + $2,
           last_flagged_at     = NOW(),
           updated_at          = NOW()
     RETURNING merchant_address, total_penalty_score, is_active, last_flagged_at`,
    [merchantAddress, penaltyPoints]
  );

  const row = rows[0];
  if (!row) throw new Error(`Failed to upsert penalty score for ${merchantAddress}`);

  return {
    merchantAddress: row.merchant_address,
    totalPenaltyScore: row.total_penalty_score,
    isActive: row.is_active,
    lastFlaggedAt: row.last_flagged_at.toISOString(),
  };
}

/**
 * Sets is_active = false on the merchant storefront and returns the
 * updated record. Also updates the parent merchants table if present.
 */
async function suspendMerchantStorefront(merchantAddress: string): Promise<void> {
  await getPool().query(
    `UPDATE merchant_penalty_scores
        SET is_active = false,
            updated_at = NOW()
      WHERE merchant_address = $1`,
    [merchantAddress]
  );

  // Best-effort: also suspend the merchants table entry if it exists.
  await getPool()
    .query(
      `UPDATE merchants
          SET is_active = false,
              updated_at = NOW()
        WHERE stellar_address = $1`,
      [merchantAddress]
    )
    .catch((err) => {
      // merchants table may not exist in all environments — non-fatal.
      log.warn("Could not update merchants table during suspension", {
        merchantAddress,
        error: (err as Error).message,
      });
    });

  log.warn("Merchant storefront suspended", { merchantAddress });
}

// ---------------------------------------------------------------------------
// Notification dispatch
// ---------------------------------------------------------------------------

/**
 * Dispatches a critical `merchant_reputation_flagged` payment event so the
 * notifications service can send an email / push to the merchant with dispute
 * resolution instructions.
 */
async function dispatchMerchantSuspensionNotification(
  event: ReputationFlagEvent,
  totalPenaltyScore: number,
  suspended: boolean
): Promise<void> {
  try {
    await publishPaymentEvent({
      type: "merchant_reputation_flagged",
      orderId: "SYSTEM", // system-level event — not tied to a single order
      payload: {
        merchantAddress: event.merchantAddress,
        reporterAddress: event.reporterAddress,
        penaltyPoints: event.penaltyPoints,
        totalPenaltyScore,
        reasonCode: event.reasonCode,
        contractId: event.contractId,
        ledger: event.ledger,
        suspended,
        disputeInstructions:
          "Your storefront has been flagged for suspicious activity. " +
          "Please visit https://delego.io/merchant/dispute to submit your appeal. " +
          "Your listings will remain hidden until the dispute is resolved.",
      },
      occurredAt: new Date().toISOString(),
    });
  } catch (err) {
    // Never let a notification failure block the main penalty flow.
    log.error("Failed to dispatch merchant reputation notification", {
      merchantAddress: event.merchantAddress,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// In-memory store (for testing / local dev without Postgres)
// ---------------------------------------------------------------------------

export interface ReputationFlagStore {
  applyPenalty(merchantAddress: string, penaltyPoints: number): Promise<MerchantPenaltyRecord>;
  suspend(merchantAddress: string): Promise<void>;
  get(merchantAddress: string): Promise<MerchantPenaltyRecord | null>;
}

export class InMemoryReputationFlagStore implements ReputationFlagStore {
  private readonly records = new Map<string, MerchantPenaltyRecord>();

  async applyPenalty(merchantAddress: string, penaltyPoints: number): Promise<MerchantPenaltyRecord> {
    const existing = this.records.get(merchantAddress) ?? {
      merchantAddress,
      totalPenaltyScore: 0,
      isActive: true,
      lastFlaggedAt: new Date().toISOString(),
    };
    const updated: MerchantPenaltyRecord = {
      ...existing,
      totalPenaltyScore: existing.totalPenaltyScore + penaltyPoints,
      lastFlaggedAt: new Date().toISOString(),
    };
    this.records.set(merchantAddress, updated);
    return { ...updated };
  }

  async suspend(merchantAddress: string): Promise<void> {
    const record = this.records.get(merchantAddress);
    if (record) {
      record.isActive = false;
    }
  }

  async get(merchantAddress: string): Promise<MerchantPenaltyRecord | null> {
    const r = this.records.get(merchantAddress);
    return r ? { ...r } : null;
  }
}

export class PostgresReputationFlagStore implements ReputationFlagStore {
  async applyPenalty(merchantAddress: string, penaltyPoints: number): Promise<MerchantPenaltyRecord> {
    return upsertMerchantPenalty(merchantAddress, penaltyPoints);
  }

  async suspend(merchantAddress: string): Promise<void> {
    await suspendMerchantStorefront(merchantAddress);
  }

  async get(merchantAddress: string): Promise<MerchantPenaltyRecord | null> {
    const { rows } = await getPool().query<{
      merchant_address: string;
      total_penalty_score: number;
      is_active: boolean;
      last_flagged_at: Date;
    }>(
      `SELECT merchant_address, total_penalty_score, is_active, last_flagged_at
         FROM merchant_penalty_scores
        WHERE merchant_address = $1`,
      [merchantAddress]
    );
    if (!rows[0]) return null;
    const r = rows[0];
    return {
      merchantAddress: r.merchant_address,
      totalPenaltyScore: r.total_penalty_score,
      isActive: r.is_active,
      lastFlaggedAt: r.last_flagged_at.toISOString(),
    };
  }
}

let reputationFlagStore: ReputationFlagStore = new InMemoryReputationFlagStore();

export function setReputationFlagStore(store: ReputationFlagStore): void {
  reputationFlagStore = store;
}

export function resetReputationFlagStore(): void {
  reputationFlagStore = new InMemoryReputationFlagStore();
}

export function enablePostgresReputationFlagStore(): void {
  reputationFlagStore = new PostgresReputationFlagStore();
  log.info("ReputationFlagStore switched to PostgreSQL backend");
}

// ---------------------------------------------------------------------------
// Core event handler
// ---------------------------------------------------------------------------

export interface ReputationFlagResult {
  merchantAddress: string;
  totalPenaltyScore: number;
  suspended: boolean;
  isActive: boolean;
}

/**
 * Ingests a `reputation_flagged` Soroban event, updates the penalty score,
 * and suspends the storefront if the threshold is breached.
 *
 * This is the main entry-point called from the Soroban event processor loop.
 */
export async function handleReputationFlagEvent(
  event: ReputationFlagEvent
): Promise<ReputationFlagResult> {
  log.info("Processing reputation_flagged event", {
    merchantAddress: event.merchantAddress,
    reporterAddress: event.reporterAddress,
    penaltyPoints: event.penaltyPoints,
    reasonCode: event.reasonCode,
    ledger: event.ledger,
    contractId: event.contractId,
  });

  // 1. Apply penalty score update.
  const record = await reputationFlagStore.applyPenalty(
    event.merchantAddress,
    event.penaltyPoints
  );

  let suspended = false;

  // 2. Suspend if threshold exceeded.
  if (record.totalPenaltyScore > SUSPENSION_THRESHOLD) {
    await reputationFlagStore.suspend(event.merchantAddress);
    suspended = true;
    log.warn("Merchant suspended due to excessive penalty score", {
      merchantAddress: event.merchantAddress,
      totalPenaltyScore: record.totalPenaltyScore,
      threshold: SUSPENSION_THRESHOLD,
    });
  }

  // 3. Always notify the merchant.
  await dispatchMerchantSuspensionNotification(event, record.totalPenaltyScore, suspended);

  return {
    merchantAddress: event.merchantAddress,
    totalPenaltyScore: record.totalPenaltyScore,
    suspended,
    isActive: !suspended && record.isActive,
  };
}
