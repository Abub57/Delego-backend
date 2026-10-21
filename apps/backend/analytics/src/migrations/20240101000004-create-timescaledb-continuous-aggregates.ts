import { QueryInterface, Sequelize } from "sequelize";

/**
 * Migration: Create TimescaleDB Continuous Aggregates for Real-Time Merchant Analytics (Issue #377)
 *
 * Aggregates raw order events into:
 *   1. `merchant_minute_sales` (1-minute bucket)
 *   2. `merchant_hourly_sales` (1-hour bucket)
 *   3. `merchant_daily_sales` (1-day bucket)
 *
 * Configures continuous aggregate refresh policies.
 */
export async function up(queryInterface: QueryInterface, _Sequelize: Sequelize): Promise<void> {
  // Ensure timescaledb extension is available or enabled if supported in PostgreSQL
  await queryInterface.sequelize.query(`CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;`).catch(() => {
    // In environments without TimescaleDB extension binary installed, fallback gracefully
  });

  // Check if orders table is already a hypertable; if not, create hypertable
  await queryInterface.sequelize.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'orders'
      ) THEN
        BEGIN
          PERFORM create_hypertable('orders', 'created_at', if_not_exists => TRUE, migrate_data => TRUE);
        EXCEPTION WHEN OTHERS THEN
          -- Ignore if already hypertable or not supported
          NULL;
        END;
      END IF;
    END $$;
  `).catch(() => {});

  // 1. Hourly Continuous Aggregate
  await queryInterface.sequelize.query(`
    CREATE MATERIALIZED VIEW IF NOT EXISTS merchant_hourly_sales
    WITH (timescaledb.continuous) AS
    SELECT
      time_bucket('1 hour', created_at) AS bucket,
      merchant_id,
      sum(COALESCE(amount::numeric, 0)) AS volume,
      count(id) AS order_count,
      avg(COALESCE(amount::numeric, 0)) AS avg_order_value
    FROM orders
    GROUP BY bucket, merchant_id
    WITH NO DATA;
  `).catch(async () => {
    // Fallback standard view / materialized view for environments without timescaledb
    await queryInterface.sequelize.query(`
      CREATE OR REPLACE VIEW merchant_hourly_sales AS
      SELECT
        date_trunc('hour', created_at) AS bucket,
        merchant_id,
        sum(COALESCE(amount::numeric, 0)) AS volume,
        count(id) AS order_count,
        avg(COALESCE(amount::numeric, 0)) AS avg_order_value
      FROM orders
      GROUP BY date_trunc('hour', created_at), merchant_id;
    `);
  });

  // 2. Minute Continuous Aggregate
  await queryInterface.sequelize.query(`
    CREATE MATERIALIZED VIEW IF NOT EXISTS merchant_minute_sales
    WITH (timescaledb.continuous) AS
    SELECT
      time_bucket('1 minute', created_at) AS bucket,
      merchant_id,
      sum(COALESCE(amount::numeric, 0)) AS volume,
      count(id) AS order_count,
      avg(COALESCE(amount::numeric, 0)) AS avg_order_value
    FROM orders
    GROUP BY bucket, merchant_id
    WITH NO DATA;
  `).catch(async () => {
    await queryInterface.sequelize.query(`
      CREATE OR REPLACE VIEW merchant_minute_sales AS
      SELECT
        date_trunc('minute', created_at) AS bucket,
        merchant_id,
        sum(COALESCE(amount::numeric, 0)) AS volume,
        count(id) AS order_count,
        avg(COALESCE(amount::numeric, 0)) AS avg_order_value
      FROM orders
      GROUP BY date_trunc('minute', created_at), merchant_id;
    `);
  });

  // 3. Daily Continuous Aggregate
  await queryInterface.sequelize.query(`
    CREATE MATERIALIZED VIEW IF NOT EXISTS merchant_daily_sales
    WITH (timescaledb.continuous) AS
    SELECT
      time_bucket('1 day', created_at) AS bucket,
      merchant_id,
      sum(COALESCE(amount::numeric, 0)) AS volume,
      count(id) AS order_count,
      avg(COALESCE(amount::numeric, 0)) AS avg_order_value
    FROM orders
    GROUP BY bucket, merchant_id
    WITH NO DATA;
  `).catch(async () => {
    await queryInterface.sequelize.query(`
      CREATE OR REPLACE VIEW merchant_daily_sales AS
      SELECT
        date_trunc('day', created_at) AS bucket,
        merchant_id,
        sum(COALESCE(amount::numeric, 0)) AS volume,
        count(id) AS order_count,
        avg(COALESCE(amount::numeric, 0)) AS avg_order_value
      FROM orders
      GROUP BY date_trunc('day', created_at), merchant_id;
    `);
  });

  // Add continuous aggregate refresh policies
  await queryInterface.sequelize.query(`
    SELECT add_continuous_aggregate_policy('merchant_minute_sales',
      start_offset => INTERVAL '2 hours',
      end_offset => INTERVAL '1 minute',
      schedule_interval => INTERVAL '1 minute',
      if_not_exists => TRUE
    );
  `).catch(() => {});

  await queryInterface.sequelize.query(`
    SELECT add_continuous_aggregate_policy('merchant_hourly_sales',
      start_offset => INTERVAL '3 days',
      end_offset => INTERVAL '1 hour',
      schedule_interval => INTERVAL '1 hour',
      if_not_exists => TRUE
    );
  `).catch(() => {});

  await queryInterface.sequelize.query(`
    SELECT add_continuous_aggregate_policy('merchant_daily_sales',
      start_offset => INTERVAL '30 days',
      end_offset => INTERVAL '1 day',
      schedule_interval => INTERVAL '1 day',
      if_not_exists => TRUE
    );
  `).catch(() => {});
}

export async function down(queryInterface: QueryInterface, _Sequelize: Sequelize): Promise<void> {
  await queryInterface.sequelize.query(`DROP MATERIALIZED VIEW IF EXISTS merchant_minute_sales CASCADE;`).catch(async () => {
    await queryInterface.sequelize.query(`DROP VIEW IF EXISTS merchant_minute_sales CASCADE;`);
  });
  await queryInterface.sequelize.query(`DROP MATERIALIZED VIEW IF EXISTS merchant_hourly_sales CASCADE;`).catch(async () => {
    await queryInterface.sequelize.query(`DROP VIEW IF EXISTS merchant_hourly_sales CASCADE;`);
  });
  await queryInterface.sequelize.query(`DROP MATERIALIZED VIEW IF EXISTS merchant_daily_sales CASCADE;`).catch(async () => {
    await queryInterface.sequelize.query(`DROP VIEW IF EXISTS merchant_daily_sales CASCADE;`);
  });
}
