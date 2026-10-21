-- Migration: 041_product_catalog
-- Issue: Product Catalog Database Migration and CRUD
-- Description: Adds products table with full-text and price indexing for
--              merchant product listings.
--              Enforces: price_stroops > 0, stock_quantity >= 0

CREATE TABLE IF NOT EXISTS products (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id     UUID         NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  sku             VARCHAR(64)  NOT NULL,
  title           VARCHAR(255) NOT NULL,
  description     TEXT,
  price_stroops   BIGINT       NOT NULL CHECK (price_stroops > 0),
  asset_code      VARCHAR(12)  NOT NULL DEFAULT 'USDC',
  stock_quantity  INT          NOT NULL DEFAULT 0 CHECK (stock_quantity >= 0),
  is_listed       BOOLEAN      NOT NULL DEFAULT TRUE,
  image_url       TEXT,
  metadata        JSONB        NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

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
