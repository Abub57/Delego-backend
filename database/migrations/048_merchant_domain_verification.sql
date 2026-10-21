-- Migration: 048_merchant_domain_verification
-- Description: SEP-0001 domain verification for merchants. A merchant is
--              promoted to `verified_business` when the stellar.toml served at
--              https://{home_domain}/.well-known/stellar.toml lists its
--              registered Stellar address as SIGNING_KEY or in ACCOUNTS, and is
--              demoted again when a daily re-check shows the listing was
--              revoked.

ALTER TABLE merchants
  ADD COLUMN IF NOT EXISTS home_domain                 VARCHAR(253),
  ADD COLUMN IF NOT EXISTS verification_tier           VARCHAR(32) NOT NULL DEFAULT 'unverified',
  ADD COLUMN IF NOT EXISTS domain_verified_at          TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS domain_last_checked_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS domain_verification_error   TEXT,
  -- Transient failures (timeouts, 5xx) in a row; demotion only after a grace
  -- period so a brief outage on the merchant's site doesn't revoke the badge.
  ADD COLUMN IF NOT EXISTS domain_consecutive_failures INT NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_merchants_verification_tier'
  ) THEN
    ALTER TABLE merchants
      ADD CONSTRAINT chk_merchants_verification_tier
      CHECK (verification_tier IN ('unverified', 'verified_business'));
  END IF;
END $$;

-- Daily re-verification sweep: merchants with a domain, oldest check first.
CREATE INDEX IF NOT EXISTS idx_merchants_domain_recheck
  ON merchants (domain_last_checked_at NULLS FIRST, id)
  WHERE home_domain IS NOT NULL;

-- Append-only audit trail of every check (who was verified, when, and why not).
CREATE TABLE IF NOT EXISTS merchant_domain_verifications (
  id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id       UUID         NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  domain            VARCHAR(253) NOT NULL,
  signing_key       VARCHAR(56),
  is_verified       BOOLEAN      NOT NULL,
  failure_kind      VARCHAR(16)  CHECK (failure_kind IN ('definitive', 'transient')),
  validation_error  TEXT,
  toml_fetched_at   TIMESTAMPTZ,
  tier_before       VARCHAR(32)  NOT NULL,
  tier_after        VARCHAR(32)  NOT NULL,
  checked_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_merchant_domain_verifications_merchant
  ON merchant_domain_verifications (merchant_id, checked_at DESC);

-- ── Down migration ─────────────────────────────────────────────────────────────
-- DROP INDEX IF EXISTS idx_merchant_domain_verifications_merchant;
-- DROP TABLE IF EXISTS merchant_domain_verifications;
-- DROP INDEX IF EXISTS idx_merchants_domain_recheck;
-- ALTER TABLE merchants DROP CONSTRAINT IF EXISTS chk_merchants_verification_tier;
-- ALTER TABLE merchants
--   DROP COLUMN IF EXISTS domain_consecutive_failures,
--   DROP COLUMN IF EXISTS domain_verification_error,
--   DROP COLUMN IF EXISTS domain_last_checked_at,
--   DROP COLUMN IF EXISTS domain_verified_at,
--   DROP COLUMN IF EXISTS verification_tier,
--   DROP COLUMN IF EXISTS home_domain;
