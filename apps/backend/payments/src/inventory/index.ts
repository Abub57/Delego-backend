/**
 * Real-time inventory & stock reservation engine.
 *
 * Stock is reserved transactionally against `merchant_inventory` (aggregate
 * available/reserved counters) with one row per reservation in
 * `merchant_inventory_reservations`. The row-level lock (`SELECT ... FOR
 * UPDATE`) plus the `(merchant_id, order_id, product_id)` unique index is what
 * prevents overselling under concurrent checkouts.
 */

import { Pool, type QueryResultRow } from "pg";
import { createLogger } from "@delegolabs/utils";
import { requireString, type ValidationResult } from "../validation.js";

const log = createLogger("payments:inventory", process.env.LOG_LEVEL ?? "info");

/** Default reservation TTL: stock is held for 15 minutes while escrow funding completes. */
export const DEFAULT_RESERVATION_TTL_MS = 15 * 60 * 1000;

/** A stock reservation held for an order. */
export interface StockReservation {
  reservationId: string;
  productId: string;
  quantity: number;
  orderId: string;
  /** Unix epoch ms after which the reservation is considered expired. */
  expiresAt: number;
}

/** Result of releasing a reservation. */
export interface ReleaseReservationResult {
  reservationId: string;
  productId: string;
  /** Units returned to available stock; `0` when the reservation was already released. */
  quantityRestored: number;
  releasedAt: string;
}

/** Raised when a reservation would take more stock than is available. */
export class InsufficientStockError extends Error {
  constructor(public readonly productId: string) {
    super(`Insufficient stock for product ${productId}`);
    this.name = "InsufficientStockError";
  }
}

/** Raised when a reservation id does not correspond to an active reservation. */
export class ReservationNotFoundError extends Error {
  constructor(public readonly reservationId: string) {
    super(`No active reservation found for ${reservationId}`);
    this.name = "ReservationNotFoundError";
  }
}

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

interface ProductRow extends QueryResultRow {
  merchant_id: string;
}

interface InventoryRow extends QueryResultRow {
  id: string;
  available_stock: number;
  reserved_stock: number;
}

interface ReservationRow extends QueryResultRow {
  id: string;
  merchant_id: string;
  product_id: string;
  quantity: number;
  status: string;
}

interface ReservationIdRow extends QueryResultRow {
  id: string;
}

/**
 * Reserve `quantity` units of `productId` for `orderId`.
 *
 * @throws {InsufficientStockError} when the merchant has fewer units available.
 */
export async function reserveStock(
  productId: string,
  quantity: number,
  orderId: string,
  ttlMs: number = DEFAULT_RESERVATION_TTL_MS
): Promise<StockReservation> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    const product = await client.query<ProductRow>(
      "SELECT merchant_id FROM products WHERE id = $1",
      [productId]
    );
    const merchantId = product.rows[0]?.merchant_id;
    if (!merchantId) {
      throw new Error(`Unknown product ${productId}`);
    }

    const inventory = await client.query<InventoryRow>(
      "SELECT id, available_stock, reserved_stock FROM merchant_inventory WHERE merchant_id = $1 AND product_id = $2 FOR UPDATE",
      [merchantId, productId]
    );
    const row = inventory.rows[0];
    if (!row || row.available_stock < quantity) {
      throw new InsufficientStockError(productId);
    }

    await client.query(
      "UPDATE merchant_inventory SET available_stock = available_stock - $2, reserved_stock = reserved_stock + $2, updated_at = NOW() WHERE id = $1",
      [row.id, quantity]
    );

    const inserted = await client.query<ReservationIdRow>(
      `INSERT INTO merchant_inventory_reservations
         (merchant_id, order_id, product_id, quantity, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'reserved', NOW(), NOW())
       RETURNING id`,
      [merchantId, orderId, productId, quantity]
    );

    await client.query("COMMIT");

    const reservation: StockReservation = {
      reservationId: inserted.rows[0].id,
      productId,
      quantity,
      orderId,
      expiresAt: Date.now() + ttlMs,
    };
    log.info("Stock reserved", {
      reservationId: reservation.reservationId,
      productId,
      orderId,
      quantity,
    });
    return reservation;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Release a reservation and return its units to available stock.
 *
 * When the reservation is unknown or already released the call is a no-op
 * returning `quantityRestored: 0`, unless `strict` is set, in which case
 * {@link ReservationNotFoundError} is thrown.
 */
export async function releaseReservation(
  reservationId: string,
  options: { strict?: boolean } = {}
): Promise<ReleaseReservationResult> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    const found = await client.query<ReservationRow>(
      "SELECT id, merchant_id, product_id, quantity, status FROM merchant_inventory_reservations WHERE id = $1 FOR UPDATE",
      [reservationId]
    );
    const row = found.rows[0];
    if (!row || row.status !== "reserved") {
      if (options.strict) {
        throw new ReservationNotFoundError(reservationId);
      }
      await client.query("ROLLBACK");
      return {
        reservationId,
        productId: row?.product_id ?? "",
        quantityRestored: 0,
        releasedAt: new Date().toISOString(),
      };
    }

    await client.query(
      "UPDATE merchant_inventory SET available_stock = available_stock + $2, reserved_stock = reserved_stock - $2, updated_at = NOW() WHERE merchant_id = $1 AND product_id = $3",
      [row.merchant_id, row.quantity, row.product_id]
    );
    await client.query(
      "UPDATE merchant_inventory_reservations SET status = 'released', updated_at = NOW() WHERE id = $1",
      [reservationId]
    );

    await client.query("COMMIT");

    log.info("Stock reservation released", {
      reservationId,
      productId: row.product_id,
      quantity: row.quantity,
    });
    return {
      reservationId,
      productId: row.product_id,
      quantityRestored: row.quantity,
      releasedAt: new Date().toISOString(),
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** Current available stock for a product; `0` when the product has no inventory row. */
export async function getAvailableStock(productId: string): Promise<number> {
  const { rows } = await getPool().query<InventoryRow>(
    "SELECT id, available_stock, reserved_stock FROM merchant_inventory WHERE product_id = $1",
    [productId]
  );
  return rows[0]?.available_stock ?? 0;
}

/** Validate a reserve-stock request body. */
export function validateReserveStockRequest(body: Record<string, unknown>): ValidationResult<{
  productId: string;
  quantity: number;
  orderId: string;
  ttlMs: number;
}> {
  const productId = requireString(body, "productId");
  if (!productId.ok) return productId;

  const orderId = requireString(body, "orderId");
  if (!orderId.ok) return orderId;

  const rawQuantity = body.quantity;
  const quantity = typeof rawQuantity === "string" ? Number(rawQuantity) : rawQuantity;
  if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity <= 0) {
    return {
      ok: false,
      error: {
        code: "VALIDATION_ERROR",
        message: "quantity must be a positive integer",
        details: { field: "quantity" },
      },
    };
  }

  let ttlMs = DEFAULT_RESERVATION_TTL_MS;
  const rawTtl = body.ttlMs;
  if (rawTtl !== undefined && rawTtl !== null) {
    const parsed = typeof rawTtl === "string" ? Number(rawTtl) : rawTtl;
    if (typeof parsed !== "number" || !Number.isFinite(parsed) || parsed <= 0) {
      return {
        ok: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "ttlMs must be a positive number",
          details: { field: "ttlMs" },
        },
      };
    }
    ttlMs = parsed;
  }

  return {
    ok: true,
    value: {
      productId: productId.value,
      quantity,
      orderId: orderId.value,
      ttlMs,
    },
  };
}

/** Validate a reservation id path parameter. */
export function validateReservationId(reservationId: string): ValidationResult<string> {
  if (!reservationId || reservationId.trim() === "") {
    return {
      ok: false,
      error: {
        code: "VALIDATION_ERROR",
        message: "reservationId is required",
        details: { field: "reservationId" },
      },
    };
  }
  return { ok: true, value: reservationId.trim() };
}
