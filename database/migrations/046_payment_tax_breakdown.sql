-- Migration: 046_payment_tax_breakdown
-- Description: Add itemized tax breakdown columns to payment_records so
--              frontend invoices and tax reporting can show line-item
--              subtotal, VAT/sales tax amount, and applied tax rate.
--
-- All monetary columns use NUMERIC(20, 0) — the same precision as
-- amount_stroops — to store stroop values as exact integers without
-- floating-point drift.  tax_rate_basis_points stores the rate as an
-- integer number of basis points (100 bp = 1 %) so no decimal arithmetic
-- is needed at the application layer.
--
-- Backfill: historical rows pre-date tax breakdown; they are populated with
-- safe defaults (subtotal = full amount, tax = 0, rate = 0, jurisdiction =
-- NULL) so existing queries and invoice renders continue to work correctly
-- without special-casing NULL.

ALTER TABLE payment_records
  ADD COLUMN IF NOT EXISTS subtotal_stroops      NUMERIC(20, 0),
  ADD COLUMN IF NOT EXISTS tax_amount_stroops    NUMERIC(20, 0) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tax_rate_basis_points INTEGER        NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tax_jurisdiction      VARCHAR(64);

-- Backfill existing rows: subtotal = full amount, tax = 0 (already the
-- column default, but an explicit UPDATE makes the intent clear and keeps
-- the backfill self-documenting for future engineers).
UPDATE payment_records
   SET subtotal_stroops = amount_stroops
 WHERE subtotal_stroops IS NULL;

-- Now that the backfill is done, add the NOT NULL constraint.  Using a
-- separate ALTER avoids locking issues on large tables: the UPDATE above
-- sets all rows to non-NULL before we enforce the constraint.
ALTER TABLE payment_records
  ALTER COLUMN subtotal_stroops SET NOT NULL,
  ALTER COLUMN subtotal_stroops SET DEFAULT 0;

-- Constraint: tax_amount_stroops must not exceed subtotal_stroops.
-- Expressed as a CHECK so the database enforces it on every INSERT/UPDATE,
-- not just at the application layer.
ALTER TABLE payment_records
  ADD CONSTRAINT chk_tax_amount_lte_subtotal
    CHECK (tax_amount_stroops <= subtotal_stroops);

-- Constraint: basis points must be non-negative (a negative tax rate is
-- not a valid concept for sales tax / VAT).
ALTER TABLE payment_records
  ADD CONSTRAINT chk_tax_rate_non_negative
    CHECK (tax_rate_basis_points >= 0);

-- Index for tax-jurisdiction reporting queries (analytics service groups by
-- jurisdiction to produce per-region tax summaries).
CREATE INDEX IF NOT EXISTS idx_payment_records_tax_jurisdiction
  ON payment_records (tax_jurisdiction)
  WHERE tax_jurisdiction IS NOT NULL;

COMMENT ON COLUMN payment_records.subtotal_stroops IS
  'Pre-tax item total in stroops. Equals amount_stroops for historical rows (backfilled).';
COMMENT ON COLUMN payment_records.tax_amount_stroops IS
  'VAT / sales tax charged in stroops. 0 for historical rows (backfilled).';
COMMENT ON COLUMN payment_records.tax_rate_basis_points IS
  'Applied tax rate in basis points (100 bp = 1 %). 0 for historical rows (backfilled).';
COMMENT ON COLUMN payment_records.tax_jurisdiction IS
  'ISO 3166-2 subdivision code or free-form jurisdiction label (e.g. "US-CA"). NULL for historical rows.';

-- ── Down migration ──────────────────────────────────────────────────────────
-- ALTER TABLE payment_records
--   DROP CONSTRAINT IF EXISTS chk_tax_rate_non_negative,
--   DROP CONSTRAINT IF EXISTS chk_tax_amount_lte_subtotal,
--   DROP COLUMN IF EXISTS tax_jurisdiction,
--   DROP COLUMN IF EXISTS tax_rate_basis_points,
--   DROP COLUMN IF EXISTS tax_amount_stroops,
--   DROP COLUMN IF EXISTS subtotal_stroops;
-- DROP INDEX IF EXISTS idx_payment_records_tax_jurisdiction;
