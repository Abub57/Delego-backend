-- Migration 038: Product catalog with pgvector embeddings
-- Issue #263: enables semantic vector search on the products table.
--
-- This migration owns the canonical `merchants` and `products` definitions.
-- Later migrations that add to these tables (041_product_catalog,
-- 055_merchants, 056_merchant_profile_fields, 061_product_variants,
-- 048_merchant_domain_verification, ...) run additively, so every column they
-- index or alter must already exist here.
--
-- Requires the pgvector extension (CREATE EXTENSION IF NOT EXISTS vector).

-- Enable pgvector
CREATE EXTENSION IF NOT EXISTS vector;

-- Merchants: store registration and on-chain verification.
-- Superset of the gateway Merchant model (apps/backend/gateway/src/models/
-- Merchant.ts) plus `name`, which is read by the catalogue search query.
CREATE TABLE IF NOT EXISTS merchants (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id     UUID NOT NULL REFERENCES users(id),
  store_name        VARCHAR(128) NOT NULL,
  description       TEXT,
  stellar_address   VARCHAR(56) NOT NULL UNIQUE,
  contact_email     VARCHAR(255) NOT NULL,
  category          VARCHAR(64) NOT NULL,
  is_verified       BOOLEAN NOT NULL DEFAULT FALSE,
  reputation_score  INTEGER NOT NULL DEFAULT 100
                      CHECK (reputation_score BETWEEN 0 AND 100),
  -- Nullable: the gateway Merchant model does not write it.
  name              TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Products, including the 1536-dimensional embedding column.
CREATE TABLE IF NOT EXISTS products (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id     UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  sku             VARCHAR(64) NOT NULL,
  title           VARCHAR(255) NOT NULL,
  description     TEXT,
  category        TEXT,
  price_stroops   BIGINT NOT NULL CHECK (price_stroops > 0),
  asset_code      VARCHAR(12) NOT NULL DEFAULT 'USDC',
  stock_quantity  INTEGER NOT NULL DEFAULT 0 CHECK (stock_quantity >= 0),
  is_listed       BOOLEAN NOT NULL DEFAULT TRUE,
  status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'unlisted', 'deleted')),
  in_stock        BOOLEAN NOT NULL DEFAULT TRUE,
  image_url       TEXT,
  metadata        JSONB NOT NULL DEFAULT '{}',
  -- 1536-dimensional vector for text-embedding-3-small
  embedding       vector(1536),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for fast cosine similarity search
CREATE INDEX IF NOT EXISTS products_embedding_hnsw_idx
  ON products
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Partial index: only index active, in-stock products to keep the index small
CREATE INDEX IF NOT EXISTS products_active_in_stock_idx
  ON products (merchant_id, category, asset_code)
  WHERE status = 'active' AND in_stock = TRUE;

-- Agent tool audit log
-- Issue #262: persists every agent tool invocation for compliance and debugging.
CREATE TABLE IF NOT EXISTS agent_tool_audit_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tool_name       TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  delegation_id   TEXT,
  input           JSONB NOT NULL DEFAULT '{}',
  output          JSONB,
  success         BOOLEAN NOT NULL,
  error           TEXT,
  duration_ms     INTEGER NOT NULL,
  executed_at     TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS agent_tool_audit_user_idx
  ON agent_tool_audit_log (user_id, executed_at DESC);

CREATE INDEX IF NOT EXISTS agent_tool_audit_tool_idx
  ON agent_tool_audit_log (tool_name, executed_at DESC);
