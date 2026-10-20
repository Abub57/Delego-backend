-- Migration: 061_product_variants.sql
-- Description: Create product_variants table for variable products (sizes, colors, materials)
-- Created: 2026-10-19

CREATE TABLE IF NOT EXISTS product_variants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    sku VARCHAR(64) UNIQUE NOT NULL,
    attributes JSONB NOT NULL DEFAULT '{}',
    price_stroops NUMERIC(20, 0) NOT NULL,
    stock_count INTEGER NOT NULL DEFAULT 0,
    barcode VARCHAR(64),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for querying variants by product
CREATE INDEX IF NOT EXISTS idx_product_variants_product_id ON product_variants(product_id);

-- Index for JSONB attribute querying (e.g., filtering by size or color)
CREATE INDEX IF NOT EXISTS idx_product_variants_attributes ON product_variants USING gin(attributes);

-- Index for stock query optimization
CREATE INDEX IF NOT EXISTS idx_product_variants_stock ON product_variants(stock_count) WHERE stock_count > 0;

-- Index for barcode lookup
CREATE INDEX IF NOT EXISTS idx_product_variants_barcode ON product_variants(barcode) WHERE barcode IS NOT NULL;

-- Unique constraint: product + attribute combination (for variant matrix)
CREATE UNIQUE INDEX IF NOT EXISTS idx_product_variants_unique_attrs 
    ON product_variants(product_id, (attributes->>'size'), (attributes->>'color'), (attributes->>'material'))
    WHERE (attributes->>'size') IS NOT NULL OR (attributes->>'color') IS NOT NULL OR (attributes->>'material') IS NOT NULL;