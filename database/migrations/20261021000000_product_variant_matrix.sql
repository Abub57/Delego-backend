-- Product variant matrices with deterministic SKU attributes.
CREATE TABLE IF NOT EXISTS product_variant_matrices (
  id BIGSERIAL PRIMARY KEY,
  product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
  sku TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (product_id, sku)
);
CREATE INDEX IF NOT EXISTS product_variant_matrices_attributes_gin
  ON product_variant_matrices USING GIN (attributes);
