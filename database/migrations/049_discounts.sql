-- Migration: 049_discounts
-- Issue: Merchant Discount Campaigns
-- Description: Adds discounts table for merchant discount campaigns,
--              enforcing unique promo codes per merchant, valid date ranges,
--              and usage limits.

CREATE TABLE IF NOT EXISTS discounts (
  id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id       UUID         NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  code              VARCHAR(64)  NOT NULL,
  discount_type     VARCHAR(32)  NOT NULL CHECK (discount_type IN ('percentage', 'fixed_stroops')),
  discount_value    VARCHAR(64)  NOT NULL,
  min_order_stroops VARCHAR(64),
  max_uses          INT          CHECK (max_uses IS NULL OR max_uses > 0),
  uses_count        INT          NOT NULL DEFAULT 0 CHECK (uses_count >= 0),
  valid_from        TIMESTAMPTZ  NOT NULL,
  valid_until       TIMESTAMPTZ  NOT NULL,
  is_active         BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_discounts_valid_dates CHECK (valid_until > valid_from)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_discounts_merchant_code
  ON discounts (merchant_id, code);

CREATE INDEX IF NOT EXISTS idx_discounts_merchant_id
  ON discounts (merchant_id);
