-- Migration: 047_merchant_revenue_analytics
-- Description: Columns and indexes backing GET /api/v1/merchant/analytics/revenue.
--
--   currency              Settlement currency code of the escrow (e.g. USDC,
--                         EURC, XLM). Revenue is never summed across currencies.
--   platform_fee_stroops  Platform service fee withheld from the escrow.
--   settled_at            When the escrow reached a terminal state (released
--                         or refunded). Revenue is bucketed by this timestamp.
--                         Maintained by trg_payment_records_settled_at so
--                         writers cannot forget to set it.

ALTER TABLE payment_records
  ADD COLUMN IF NOT EXISTS currency             VARCHAR(12) NOT NULL DEFAULT 'USDC',
  ADD COLUMN IF NOT EXISTS platform_fee_stroops BIGINT      NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS settled_at           TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_payment_records_platform_fee_non_negative'
  ) THEN
    ALTER TABLE payment_records
      ADD CONSTRAINT chk_payment_records_platform_fee_non_negative
      CHECK (platform_fee_stroops >= 0 AND platform_fee_stroops <= amount_stroops);
  END IF;
END $$;

-- Backfill: existing terminal escrows settled at their last update.
UPDATE payment_records
   SET settled_at = updated_at
 WHERE settled_at IS NULL
   AND status IN ('released', 'refunded');

CREATE OR REPLACE FUNCTION set_payment_record_settled_at() RETURNS trigger AS $$
BEGIN
  IF NEW.status IN ('released', 'refunded') AND NEW.settled_at IS NULL THEN
    NEW.settled_at := NOW();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_payment_records_settled_at ON payment_records;
CREATE TRIGGER trg_payment_records_settled_at
  BEFORE INSERT OR UPDATE OF status ON payment_records
  FOR EACH ROW EXECUTE FUNCTION set_payment_record_settled_at();

-- Merchant → orders lookup for the revenue join.
CREATE INDEX IF NOT EXISTS idx_orders_merchant_id
  ON orders (merchant_id, id);

-- Range scan on settlement time per currency; INCLUDE keeps the aggregate
-- columns in the index so buckets are computed without heap fetches.
CREATE INDEX IF NOT EXISTS idx_payment_records_revenue
  ON payment_records (currency, settled_at)
  INCLUDE (order_id, amount_stroops, platform_fee_stroops, refunded_amount_stroops, status)
  WHERE settled_at IS NOT NULL;

-- ── Down migration ─────────────────────────────────────────────────────────────
-- DROP INDEX IF EXISTS idx_payment_records_revenue;
-- DROP INDEX IF EXISTS idx_orders_merchant_id;
-- DROP TRIGGER IF EXISTS trg_payment_records_settled_at ON payment_records;
-- DROP FUNCTION IF EXISTS set_payment_record_settled_at();
-- ALTER TABLE payment_records DROP CONSTRAINT IF EXISTS chk_payment_records_platform_fee_non_negative;
-- ALTER TABLE payment_records
--   DROP COLUMN IF EXISTS settled_at,
--   DROP COLUMN IF EXISTS platform_fee_stroops,
--   DROP COLUMN IF EXISTS currency;
