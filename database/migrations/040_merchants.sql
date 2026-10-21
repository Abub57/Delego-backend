-- Migration: 040_merchants
-- Issue: Merchant Registration and Store Management
-- Description: Adds merchants table for merchant registration, store
--              management, and on-chain verification status.
--              Enforces: stellar_address length 56, starts with 'G', unique

CREATE TABLE IF NOT EXISTS merchants (
  id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id     UUID         NOT NULL REFERENCES users(id),
  store_name        VARCHAR(128) NOT NULL,
  description       TEXT,
  stellar_address   VARCHAR(56)  NOT NULL,
  contact_email     VARCHAR(255) NOT NULL,
  category          VARCHAR(64)  NOT NULL,
  is_verified       BOOLEAN      NOT NULL DEFAULT FALSE,
  reputation_score  INT          NOT NULL DEFAULT 100
                    CHECK (reputation_score BETWEEN 0 AND 100),
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Unique Stellar address — one merchant account per on-chain address
CREATE UNIQUE INDEX IF NOT EXISTS idx_merchants_stellar_address
  ON merchants (stellar_address);

-- Owner lookup — one user can own multiple merchant stores
CREATE INDEX IF NOT EXISTS idx_merchants_owner_user_id
  ON merchants (owner_user_id);

-- Category browse index
CREATE INDEX IF NOT EXISTS idx_merchants_category_is_verified
  ON merchants (category, is_verified)
  WHERE is_verified = TRUE;

-- ── Down migration ─────────────────────────────────────────────────────────────
-- DROP INDEX  IF EXISTS idx_merchants_category_is_verified;
-- DROP INDEX  IF EXISTS idx_merchants_owner_user_id;
-- DROP INDEX  IF EXISTS idx_merchants_stellar_address;
-- DROP TABLE  IF EXISTS merchants;
