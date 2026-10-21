import { Pool, type QueryResultRow } from "pg";
import { createLogger } from "@delegolabs/utils";
import type {
  CreatePaymentRecordInput,
  PaymentRecord,
  PaymentRecordStatus,
} from "./types.js";

const log = createLogger("payments:escrow-coordinator:store", process.env.LOG_LEVEL ?? "info");

let pool: Pool | null = null;

function getPool(): Pool {
  if (!pool) {
    const databaseUrl =
      process.env.DATABASE_URL ?? "postgresql://delego:delego@localhost:5432/delego";
    pool = new Pool({ connectionString: databaseUrl });
  }
  return pool;
}

export function _setPoolForTesting(testPool: Pool): void {
  pool = testPool;
}

export function _resetPoolForTesting(): void {
  pool = null;
}

interface PaymentRecordRow extends QueryResultRow {
  id: string;
  order_id: string;
  escrow_id: string | null;
  escrow_contract_id: string;
  buyer_address: string;
  seller_address: string;
  token_contract_id: string;
  amount_stroops: string;
  status: string;
  fund_tx_hash: string | null;
  release_tx_hash: string | null;
  refund_tx_hash: string | null;
  dispute_tx_hash: string | null;
  released_amount_stroops: string;
  refunded_amount_stroops: string;
  failure_reason: string | null;
  // Tax breakdown columns (migration 046)
  subtotal_stroops: string | null;
  tax_amount_stroops: string | null;
  tax_rate_basis_points: number | null;
  tax_jurisdiction: string | null;
  created_at: Date;
  updated_at: Date;
}

function mapRow(row: PaymentRecordRow): PaymentRecord {
  return {
    id: row.id,
    orderId: row.order_id,
    escrowId: row.escrow_id,
    escrowContractId: row.escrow_contract_id,
    buyerAddress: row.buyer_address,
    sellerAddress: row.seller_address,
    tokenContractId: row.token_contract_id,
    amountStroops: row.amount_stroops,
    status: row.status as PaymentRecordStatus,
    fundTxHash: row.fund_tx_hash,
    releaseTxHash: row.release_tx_hash,
    refundTxHash: row.refund_tx_hash,
    disputeTxHash: row.dispute_tx_hash,
    releasedAmountStroops: row.released_amount_stroops ?? "0",
    refundedAmountStroops: row.refunded_amount_stroops ?? "0",
    failureReason: row.failure_reason,
    // Tax breakdown — fall back to safe defaults for pre-046 rows where the
    // columns may not yet have been backfilled (e.g. during a rolling deploy).
    subtotalStroops: row.subtotal_stroops ?? row.amount_stroops,
    taxAmountStroops: row.tax_amount_stroops ?? "0",
    taxRateBasisPoints: row.tax_rate_basis_points ?? 0,
    taxJurisdiction: row.tax_jurisdiction ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function findPaymentRecordByOrderId(
  orderId: string
): Promise<PaymentRecord | null> {
  const { rows } = await getPool().query<PaymentRecordRow>(
    `SELECT *
     FROM payment_records
     WHERE order_id = $1
     LIMIT 1`,
    [orderId]
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function findPaymentRecordByEscrowId(
  escrowId: string
): Promise<PaymentRecord | null> {
  const { rows } = await getPool().query<PaymentRecordRow>(
    `SELECT *
     FROM payment_records
     WHERE escrow_id = $1
     LIMIT 1`,
    [escrowId]
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function createPaymentRecord(
  input: CreatePaymentRecordInput
): Promise<PaymentRecord> {
  // Resolve tax fields: callers that don't supply them get safe defaults so
  // the service is backwards-compatible with pre-046 call sites.
  const subtotalStroops = input.subtotalStroops ?? input.amountStroops;
  const taxAmountStroops = input.taxAmountStroops ?? "0";
  const taxRateBasisPoints = input.taxRateBasisPoints ?? 0;
  const taxJurisdiction = input.taxJurisdiction ?? null;

  // Validate with BigInt to catch non-integer stroop strings early.
  try {
    const sub = BigInt(subtotalStroops);
    const tax = BigInt(taxAmountStroops);
    if (sub < 0n) throw new Error("subtotalStroops must be non-negative");
    if (tax < 0n) throw new Error("taxAmountStroops must be non-negative");
    if (tax > sub) throw new Error("taxAmountStroops must not exceed subtotalStroops");
  } catch (err) {
    throw new Error(
      `Invalid tax breakdown values: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!Number.isInteger(taxRateBasisPoints) || taxRateBasisPoints < 0) {
    throw new Error("taxRateBasisPoints must be a non-negative integer");
  }

  const { rows } = await getPool().query<PaymentRecordRow>(
    `INSERT INTO payment_records (
       order_id,
       escrow_contract_id,
       buyer_address,
       seller_address,
       token_contract_id,
       amount_stroops,
       subtotal_stroops,
       tax_amount_stroops,
       tax_rate_basis_points,
       tax_jurisdiction,
       status
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending')
     RETURNING *`,
    [
      input.orderId,
      input.escrowContractId,
      input.buyerAddress,
      input.sellerAddress,
      input.tokenContractId,
      input.amountStroops,
      subtotalStroops,
      taxAmountStroops,
      taxRateBasisPoints,
      taxJurisdiction,
    ]
  );

  const record = mapRow(rows[0]);
  log.info("Payment record created", {
    orderId: record.orderId,
    id: record.id,
    subtotalStroops: record.subtotalStroops,
    taxAmountStroops: record.taxAmountStroops,
    taxRateBasisPoints: record.taxRateBasisPoints,
    taxJurisdiction: record.taxJurisdiction,
  });
  return record;
}

export interface PaymentRecordUpdate {
  escrowId?: string;
  status?: PaymentRecordStatus;
  fundTxHash?: string | null;
  releaseTxHash?: string | null;
  refundTxHash?: string | null;
  disputeTxHash?: string | null;
  failureReason?: string | null;
}

export async function updatePaymentRecord(
  id: string,
  update: PaymentRecordUpdate
): Promise<PaymentRecord> {
  const fields: string[] = [];
  const values: unknown[] = [id];

  const addField = (column: string, value: unknown) => {
    values.push(value);
    fields.push(`${column} = $${values.length}`);
  };

  if (update.escrowId !== undefined) addField("escrow_id", update.escrowId);
  if (update.status !== undefined) addField("status", update.status);
  if (update.fundTxHash !== undefined) addField("fund_tx_hash", update.fundTxHash);
  if (update.releaseTxHash !== undefined) addField("release_tx_hash", update.releaseTxHash);
  if (update.refundTxHash !== undefined) addField("refund_tx_hash", update.refundTxHash);
  if (update.disputeTxHash !== undefined) addField("dispute_tx_hash", update.disputeTxHash);
  if (update.failureReason !== undefined) addField("failure_reason", update.failureReason);

  if (fields.length === 0) {
    const { rows } = await getPool().query<PaymentRecordRow>(
      `SELECT * FROM payment_records WHERE id = $1`,
      [id]
    );
    if (!rows[0]) throw new Error(`Payment record not found: ${id}`);
    return mapRow(rows[0]);
  }

  fields.push("updated_at = NOW()");

  const { rows } = await getPool().query<PaymentRecordRow>(
    `UPDATE payment_records
     SET ${fields.join(", ")}
     WHERE id = $1
     RETURNING *`,
    values
  );

  if (!rows[0]) throw new Error(`Payment record not found: ${id}`);
  return mapRow(rows[0]);
}

// ---------------------------------------------------------------------------
// Migration 046 — Tax breakdown update (settlement service)
// ---------------------------------------------------------------------------

export interface PaymentRecordTaxUpdate {
  subtotalStroops: string;
  taxAmountStroops: string;
  taxRateBasisPoints: number;
  taxJurisdiction?: string | null;
}

/**
 * Persist itemized tax breakdown on an existing payment record.
 *
 * Called by the order-creation and settlement services once they have
 * computed the final per-jurisdiction tax figures.  Uses BigInt stroop
 * arithmetic to validate values before writing so invalid data never
 * reaches the database.
 */
export async function updatePaymentTaxBreakdown(
  id: string,
  tax: PaymentRecordTaxUpdate
): Promise<PaymentRecord> {
  const sub = BigInt(tax.subtotalStroops);
  const taxAmt = BigInt(tax.taxAmountStroops);
  if (sub < 0n) throw new Error("subtotalStroops must be non-negative");
  if (taxAmt < 0n) throw new Error("taxAmountStroops must be non-negative");
  if (taxAmt > sub) throw new Error("taxAmountStroops must not exceed subtotalStroops");
  if (!Number.isInteger(tax.taxRateBasisPoints) || tax.taxRateBasisPoints < 0) {
    throw new Error("taxRateBasisPoints must be a non-negative integer");
  }

  const { rows } = await getPool().query<PaymentRecordRow>(
    `UPDATE payment_records
        SET subtotal_stroops      = $2,
            tax_amount_stroops    = $3,
            tax_rate_basis_points = $4,
            tax_jurisdiction      = $5,
            updated_at            = NOW()
      WHERE id = $1
      RETURNING *`,
    [
      id,
      tax.subtotalStroops,
      tax.taxAmountStroops,
      tax.taxRateBasisPoints,
      tax.taxJurisdiction ?? null,
    ]
  );

  if (!rows[0]) throw new Error(`Payment record not found: ${id}`);
  const record = mapRow(rows[0]);
  log.info("Payment record tax breakdown updated", {
    id,
    subtotalStroops: record.subtotalStroops,
    taxAmountStroops: record.taxAmountStroops,
    taxRateBasisPoints: record.taxRateBasisPoints,
    taxJurisdiction: record.taxJurisdiction,
  });
  return record;
}

// ---------------------------------------------------------------------------
// Issue #46 — Partial refund / partial release balance tracking
// ---------------------------------------------------------------------------

export interface PaymentRecordAmountDelta {
  releasedDelta?: string;
  refundedDelta?: string;
  /** Optional status to set atomically alongside the increment (e.g. once the balance is fully consumed). */
  status?: PaymentRecordStatus;
}

/**
 * Atomically increments the cumulative released/refunded amounts on a
 * payment record. Uses a single `SET col = col + $delta` statement so
 * concurrent partial releases/refunds against the same escrow can't race
 * each other into an inconsistent remaining balance.
 */
export async function incrementPaymentRecordAmounts(
  id: string,
  delta: PaymentRecordAmountDelta
): Promise<PaymentRecord> {
  const fields: string[] = [];
  const values: unknown[] = [id];

  const addField = (column: string, expr: (placeholder: string) => string, value: unknown) => {
    values.push(value);
    fields.push(`${column} = ${expr(`$${values.length}`)}`);
  };

  if (delta.releasedDelta !== undefined) {
    addField("released_amount_stroops", (p) => `released_amount_stroops + ${p}::bigint`, delta.releasedDelta);
  }
  if (delta.refundedDelta !== undefined) {
    addField("refunded_amount_stroops", (p) => `refunded_amount_stroops + ${p}::bigint`, delta.refundedDelta);
  }
  if (delta.status !== undefined) {
    addField("status", (p) => p, delta.status);
  }

  if (fields.length === 0) {
    const { rows } = await getPool().query<PaymentRecordRow>(
      `SELECT * FROM payment_records WHERE id = $1`,
      [id]
    );
    if (!rows[0]) throw new Error(`Payment record not found: ${id}`);
    return mapRow(rows[0]);
  }

  fields.push("updated_at = NOW()");

  const { rows } = await getPool().query<PaymentRecordRow>(
    `UPDATE payment_records
     SET ${fields.join(", ")}
     WHERE id = $1
     RETURNING *`,
    values
  );

  if (!rows[0]) throw new Error(`Payment record not found: ${id}`);
  const updated = mapRow(rows[0]);
  log.info("Payment record amounts incremented", {
    id,
    releasedDelta: delta.releasedDelta,
    refundedDelta: delta.refundedDelta,
    releasedAmountStroops: updated.releasedAmountStroops,
    refundedAmountStroops: updated.refundedAmountStroops,
  });
  return updated;
}
