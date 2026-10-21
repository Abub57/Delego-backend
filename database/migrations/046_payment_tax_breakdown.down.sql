-- Down migration: 046_payment_tax_breakdown
-- Reverses the tax breakdown columns added in 046_payment_tax_breakdown.sql.

DROP INDEX IF EXISTS idx_payment_records_tax_jurisdiction;

ALTER TABLE payment_records
  DROP CONSTRAINT IF EXISTS chk_tax_rate_non_negative,
  DROP CONSTRAINT IF EXISTS chk_tax_amount_lte_subtotal,
  DROP COLUMN IF EXISTS tax_jurisdiction,
  DROP COLUMN IF EXISTS tax_rate_basis_points,
  DROP COLUMN IF EXISTS tax_amount_stroops,
  DROP COLUMN IF EXISTS subtotal_stroops;
