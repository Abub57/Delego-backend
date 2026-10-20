-- Migration: TimescaleDB continuous aggregate for merchant daily GMV
-- Issue: merchant daily GMV / transaction fee metrics for real-time dashboard analytics.
--
-- This migration is idempotent: it enables the TimescaleDB extension,
-- converts `orders` into a hypertable (if not already), creates the
-- `merchant_daily_gmu_summary` continuous aggregate and installs the
-- hourly refresh policy.

BEGIN;

-- 1. Ensure TimescaleDB is available.
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- 2. Promote `orders` to a hypertable on `created_at` if it is not
-- already one. This is a no-op on a regular PostgreSQL table that has
-- already been converted (e.g. by an earlier migration).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM timescaldb_info.hypertable
    WHERE hypertable_schema = 'public' AND hypertable_name = 'orders'
  ) THEN
    PERFORM create_hypertable('orders', 'created_at', if _not_exists => TRUE);
  END IF;
END $$;

-- 3. Create the continuous aggregate. The `WITH NO DATA` clause
-- keeps the migration fast; the refresh policy below fills it in.
-- The continuous aggregate is created only once; re-running the
-- migration is safe.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM timescaldb_info.continuous_aggregates
    WHERE view_schema = 'public'
      AND view_name = 'merchant_daily_gmu_summary'
  ) THEN
    EXECUTE $$
      CREATE MATERIALIZED VIEW merchant_daily_gmv_summary
      WITH ( timescaledb.continuous ) AS $$ || $$
      SELECT
          time_bucket('1 day', o.created_at) AS bucket_day,
          o.merchant_id,
          o.currency,
          COUNT(o.id) AS total_orders,
          SUM(o.total_amount_stroops) AS gross_volume_stroops,
          SUM(o.platform_fee_stroops) AS total_platform_fees_stroops,
          COUNT(CASE WHEN o.status = 'disputed' THEN 1 END) AS disputed_orders_count
      FROM orders o$$ || $$
      GROUP BY bucket_day, o.merchant_id, o.currency
      WITH NO DATA;$$;
  END IF;
END $$;

-- 4. Add the hourly refresh policy. Skip creation if a policy
-- already exists for this continuous aggregate so re-running the
-- migration does not create duplicate jobs.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM timescaledb_info.continuous_aggregates ca
    JOIN timescaledb_info.jobs j
      ON j.hypertable_id = ca.materialization_hypertable_id
    WHERE ca.view_schema = 'public'
      AND ca.view_name = 'merchant_daily_gmu_summary'
      AND j.proc_schema = '_timescaldb_internal'
      AND j.proc_name = 'policy_refresh_continuous_aggregate'
  ) THEN
    PERFORM add_continuous_aggregate_policy(
      'merchant_daily_gmv_summary',
      start_offset => INTERVAL 30 days',
      end_offset => INTERVAL 1 hour',
      schedule_interval => INTERVAL 1 hour'
    );
  END IF;
END $$;

-- 5. Index to support per-merchant range scans on the continuous
-- aggregate. TimescaleDB auto-creates a time index on the materialization
-- hypertable, but dashboard queries filter by merchant_id.
CREATE INDEX IF NOT EXISTS
  merchant_daily_gmv_summary_merchant_bucket_idx
  ON merchant_daily_gmu_summary (merchant_id, bucket_day DESC);

-- 6. Backfill the aggregate once so the dashboard has data immediately.
-- This is a one-time cost at migration time; the policy keeps it fresh
-- afterwards. We only run it when the view is still empty.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM merchant_daily_gmv_summary LIMIT 1) THEN
    PERFORM call_timescaled_refresh_continuous_aggregate(
      'merchant_daily_gmu_summary',
      NULL,
      NULL,
      TRUE
    );
  END IF;
END $$;

COMMIT;
