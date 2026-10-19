import type { Pool, PoolClient } from "pg";

export interface RestockProduct {
  id: string;
  title: string;
  stockQuantity: number;
  imageUrl: string | null;
  merchantName: string | null;
}

export interface RestockWaitlistEntry {
  id: string;
  productId: string;
  buyerAddress: string | null;
  email: string | null;
  createdAt: Date;
}

export interface RestockBatchOutcome {
  notifiedIds: string[];
  failedIds: string[];
  /** True when a transient provider error stopped the batch early; the rest stay pending. */
  deferred: boolean;
}

export interface RestockRepository {
  getProduct(productId: string): Promise<RestockProduct | null>;
  /**
   * Lock the oldest pending subscribers for `productId`, hand them to
   * `handler` in signup order, and persist the outcome atomically.
   * Returns null when no pending subscribers remain.
   */
  processPendingBatch(
    productId: string,
    limit: number,
    handler: (entries: RestockWaitlistEntry[]) => Promise<RestockBatchOutcome>,
  ): Promise<RestockBatchOutcome | null>;
}

interface WaitlistRow {
  id: string;
  product_id: string;
  buyer_address: string | null;
  email: string | null;
  created_at: Date;
}

/**
 * Postgres-backed waitlist access.
 *
 * Rows are claimed with `FOR UPDATE SKIP LOCKED` inside a transaction that
 * spans the sends, so concurrent workers (or duplicate jobs for the same
 * product) never notify the same subscriber twice, and a crash mid-batch
 * rolls the claim back so those subscribers are retried.
 */
export class PgRestockRepository implements RestockRepository {
  constructor(private readonly pool: Pick<Pool, "connect" | "query">) {}

  async getProduct(productId: string): Promise<RestockProduct | null> {
    const { rows } = await this.pool.query<{
      id: string;
      title: string;
      stock_quantity: number;
      image_url: string | null;
      store_name: string | null;
    }>(
      `SELECT p.id, p.title, p.stock_quantity, p.image_url, m.store_name
         FROM products p
         LEFT JOIN merchants m ON m.id = p.merchant_id
        WHERE p.id = $1`,
      [productId],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      title: row.title,
      stockQuantity: Number(row.stock_quantity),
      imageUrl: row.image_url,
      merchantName: row.store_name,
    };
  }

  async processPendingBatch(
    productId: string,
    limit: number,
    handler: (entries: RestockWaitlistEntry[]) => Promise<RestockBatchOutcome>,
  ): Promise<RestockBatchOutcome | null> {
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<WaitlistRow>(
        `SELECT id, product_id, buyer_address, email, created_at
           FROM product_restock_waitlist
          WHERE product_id = $1 AND status = 'pending'
          ORDER BY created_at ASC, id ASC
          LIMIT $2
          FOR UPDATE SKIP LOCKED`,
        [productId, limit],
      );

      if (rows.length === 0) {
        await client.query("COMMIT");
        return null;
      }

      const outcome = await handler(
        rows.map((row) => ({
          id: row.id,
          productId: row.product_id,
          buyerAddress: row.buyer_address,
          email: row.email,
          createdAt: row.created_at,
        })),
      );

      if (outcome.notifiedIds.length > 0) {
        await client.query(
          `UPDATE product_restock_waitlist
              SET status = 'notified', notified_at = NOW()
            WHERE id = ANY($1::uuid[])`,
          [outcome.notifiedIds],
        );
      }
      if (outcome.failedIds.length > 0) {
        await client.query(
          `UPDATE product_restock_waitlist SET status = 'failed' WHERE id = ANY($1::uuid[])`,
          [outcome.failedIds],
        );
      }

      await client.query("COMMIT");
      return outcome;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}
