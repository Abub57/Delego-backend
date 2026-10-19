import { QueryTypes, type Sequelize, type Transaction } from "sequelize";
import type { CatalogProductInput, RowError } from "./types.js";

export interface StockTransition {
  productId: string;
  previousStock: number;
  currentStock: number;
}

export interface UpsertBatchResult {
  successCount: number;
  failed: RowError[];
  /** Stock changes on products that already existed (feeds restock notifications). */
  stockTransitions: StockTransition[];
}

export interface CatalogRepository {
  /** Upsert products for one merchant. Callers must pass unique SKUs. */
  upsertBatch(merchantId: string, products: CatalogProductInput[]): Promise<UpsertBatchResult>;
}

const COLUMNS_PER_ROW = 9;

function emptyResult(): UpsertBatchResult {
  return { successCount: 0, failed: [], stockTransitions: [] };
}

function dbErrorReason(err: unknown): string {
  const original = (err as { original?: { message?: string } })?.original?.message;
  return `database rejected row: ${original ?? (err instanceof Error ? err.message : String(err))}`;
}

/**
 * Bulk upsert keyed on the (merchant_id, sku) unique index.
 *
 * Each batch is one multi-row `INSERT ... ON CONFLICT DO UPDATE` inside a
 * transaction. If the database rejects the batch, it is retried row by row
 * so one bad row costs only itself, not the other rows in the batch.
 */
export class SequelizeCatalogRepository implements CatalogRepository {
  constructor(private readonly sequelize: Sequelize) {}

  async upsertBatch(merchantId: string, products: CatalogProductInput[]): Promise<UpsertBatchResult> {
    if (products.length === 0) return emptyResult();

    try {
      return await this.sequelize.transaction((transaction) =>
        this.upsertInTransaction(merchantId, products, transaction),
      );
    } catch (err) {
      if (products.length === 1) {
        return { ...emptyResult(), failed: [{ rowNumber: products[0].rowNumber, reason: dbErrorReason(err) }] };
      }

      const merged = emptyResult();
      for (const product of products) {
        const result = await this.upsertBatch(merchantId, [product]);
        merged.successCount += result.successCount;
        merged.failed.push(...result.failed);
        merged.stockTransitions.push(...result.stockTransitions);
      }
      return merged;
    }
  }

  private async upsertInTransaction(
    merchantId: string,
    products: CatalogProductInput[],
    transaction: Transaction,
  ): Promise<UpsertBatchResult> {
    // Lock existing rows and capture their stock so restocks (0 -> >0) can be detected.
    const existing = await this.sequelize.query<{ sku: string; stock_quantity: number }>(
      `SELECT sku, stock_quantity
         FROM products
        WHERE merchant_id = $1 AND sku = ANY($2::text[])
        FOR UPDATE`,
      { bind: [merchantId, products.map((p) => p.sku)], type: QueryTypes.SELECT, transaction },
    );
    const previousStock = new Map(existing.map((row) => [row.sku, Number(row.stock_quantity)]));

    const bind: unknown[] = [merchantId];
    const tuples = products.map((product, index) => {
      const base = 1 + index * COLUMNS_PER_ROW;
      bind.push(
        product.sku,
        product.title,
        product.description,
        product.priceStroops,
        product.assetCode,
        product.stockQuantity,
        product.isListed,
        product.imageUrl,
        JSON.stringify(product.metadata),
      );
      const p = (offset: number) => `$${base + offset}`;
      return `($1, ${p(1)}, ${p(2)}, ${p(3)}, ${p(4)}::bigint, ${p(5)}, ${p(6)}::int, ${p(7)}::boolean, ${p(8)}, ${p(9)}::jsonb)`;
    });

    const upserted = await this.sequelize.query<{ id: string; sku: string; stock_quantity: number }>(
      `INSERT INTO products
         (merchant_id, sku, title, description, price_stroops, asset_code,
          stock_quantity, is_listed, image_url, metadata)
       VALUES ${tuples.join(",\n              ")}
       ON CONFLICT (merchant_id, sku) DO UPDATE SET
         title          = EXCLUDED.title,
         description    = EXCLUDED.description,
         price_stroops  = EXCLUDED.price_stroops,
         asset_code     = EXCLUDED.asset_code,
         stock_quantity = EXCLUDED.stock_quantity,
         is_listed      = EXCLUDED.is_listed,
         image_url      = EXCLUDED.image_url,
         metadata       = EXCLUDED.metadata,
         updated_at     = NOW()
       RETURNING id, sku, stock_quantity`,
      { bind, type: QueryTypes.SELECT, transaction },
    );

    const stockTransitions: StockTransition[] = [];
    for (const row of upserted) {
      const before = previousStock.get(row.sku);
      if (before !== undefined && before !== Number(row.stock_quantity)) {
        stockTransitions.push({
          productId: row.id,
          previousStock: before,
          currentStock: Number(row.stock_quantity),
        });
      }
    }

    return { successCount: upserted.length, failed: [], stockTransitions };
  }
}
