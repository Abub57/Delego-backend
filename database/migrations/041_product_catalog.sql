-- Migration: 041_product_catalog
-- Issue: Product Catalog Database Migration and CRUD
-- Description: Adds the full-text and price indexes used for merchant product
--              listing/browsing.
--
-- The `products` table itself is created by 038_product_catalog_vector_search.sql
-- (which owns the canonical definition, including the constraints
-- price_stroops > 0 and stock_quantity >= 0). This migration only adds indexes,
-- so it must not re-declare the table — a second CREATE TABLE IF NOT EXISTS
-- would silently no-op and mask schema drift.

-- Composite unique constraint on (merchant_id, sku) — each merchant owns unique SKUs
CREATE UNIQUE INDEX IF NOT EXISTS idx_products_merchant_sku
  ON products (merchant_id, sku);

-- Price index for sorted browsing (only for currently-listed items)
CREATE INDEX IF NOT EXISTS idx_products_price
  ON products (price_stroops)
  WHERE is_listed = TRUE;

-- Full-text search index on (title, description) using English text search
CREATE INDEX IF NOT EXISTS idx_products_search_vector
  ON products USING GIN (
    to_tsvector('english', COALESCE(title, '') || ' ' || COALESCE(description, ''))
  );

-- Merchant browse index
CREATE INDEX IF NOT EXISTS idx_products_merchant_id_created_at
  ON products (merchant_id, created_at DESC);

-- ── Down migration ─────────────────────────────────────────────────────────────
-- DROP INDEX  IF EXISTS idx_products_merchant_id_created_at;
-- DROP INDEX  IF EXISTS idx_products_search_vector;
-- DROP INDEX  IF EXISTS idx_products_price;
-- DROP INDEX  IF EXISTS idx_products_merchant_sku;
-- DROP TABLE  IF EXISTS products;
