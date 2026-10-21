import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { QueryTypes, Sequelize } from "sequelize";
import { aggregateSpendMetrics } from "./aggregator.js";
import { getSpendSummary } from "./spendSummary.js";

const databaseUrl = process.env.SPEND_METRICS_TEST_DATABASE_URL;
const userId = "00000000-0000-0000-0000-000000000001";
const otherUserId = "00000000-0000-0000-0000-000000000002";
const merchantId = "00000000-0000-0000-0000-000000000003";
const query = { userId, periodStart: "2026-01-01", periodEnd: "2026-03-01", granularity: "daily" as const };

describe.skipIf(!databaseUrl)("spend metrics PostgreSQL integration", () => {
  const schema = `spend_test_${randomUUID().replaceAll("-", "")}`;
  let admin: Sequelize;
  let db: Sequelize;

  beforeAll(async () => {
    admin = new Sequelize(databaseUrl!, { logging: false });
    await admin.query(`CREATE SCHEMA ${schema}`);
    db = new Sequelize(databaseUrl!, {
      logging: false,
      dialectOptions: { options: `-c search_path=${schema},public` },
    });
    // Apply the actual baseline and this feature's migration dependencies in
    // an isolated schema; never clear the developer's application tables.
    for (const file of [
      "schema/001_initial.sql", "migrations/009_payment_records.sql",
      "migrations/016_disputes.sql", "migrations/040_merchants.sql",
      "migrations/043_spend_metrics.sql",
    ]) {
      await db.query(await readFile(new URL(`../../../../../database/${file}`, import.meta.url), "utf8"));
    }
  }, 30_000);

  afterAll(async () => {
    await db?.close();
    if (admin) {
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.close();
    }
  });

  beforeEach(async () => {
    await db.query("TRUNCATE users, daily_spend_metrics, monthly_spend_metrics CASCADE");
    await db.query(`INSERT INTO users (id, email) VALUES ($userId, 'one@example.test'), ($otherUserId, 'two@example.test')`,
      { bind: { userId, otherUserId } });
    await db.query(`INSERT INTO merchants (id, owner_user_id, store_name, stellar_address, contact_email, category)
      VALUES ($merchantId, $userId, 'Test', 'GTEST', 'store@example.test', 'food')`, { bind: { merchantId, userId } });
  });

  async function payment(amount: string, status = "released", date = "2026-01-31T23:30:00Z", owner = userId, merchant = merchantId, refund = "0") {
    const orderId = randomUUID();
    await db.query(`INSERT INTO orders (id, user_id, merchant_id) VALUES ($orderId, $owner, $merchant)`,
      { bind: { orderId, owner, merchant } });
    await db.query(`INSERT INTO payment_records (order_id, escrow_contract_id, buyer_address, seller_address,
        token_contract_id, amount_stroops, refunded_amount_stroops, status, updated_at)
      VALUES ($orderId, 'escrow', 'buyer', 'seller', 'token', $amount, $refund, $status, $date)`,
      { bind: { orderId, amount, refund, status, date } });
    return orderId;
  }

  it("aggregates only released escrows, nets refunds, preserves BIGINTs, and groups in UTC", async () => {
    await payment("9007199254740993");
    await payment("10", "released", "2026-02-01T01:30:00+02:00", userId, merchantId, "3");
    await payment("11", "released", "2026-02-01T00:30:00Z");
    await payment("12", "released", "2026-02-02T00:00:00Z", userId, "legacy-merchant");
    await payment("500", "funded");
    await payment("500", "refunded");
    await payment("500", "failed");
    await payment("500", "released", "2026-01-31T00:00:00Z", otherUserId);
    expect(await aggregateSpendMetrics(db)).toBe(true);
    expect(await getSpendSummary(query, db)).toEqual([
      { date: "2026-01-31", category: "food", totalSpentStroops: "9007199254741000", ordersCount: 2 },
      { date: "2026-02-01", category: "food", totalSpentStroops: "11", ordersCount: 1 },
      { date: "2026-02-02", category: "uncategorized", totalSpentStroops: "12", ordersCount: 1 },
    ]);
    expect(await getSpendSummary({ ...query, granularity: "monthly", category: "food" }, db)).toEqual([
      { date: "2026-01-01", category: "food", totalSpentStroops: "9007199254741000", ordersCount: 2 },
      { date: "2026-02-01", category: "food", totalSpentStroops: "11", ordersCount: 1 },
    ]);
    expect(await getSpendSummary({ ...query, periodEnd: "2026-02-01" }, db)).toHaveLength(1);
    expect(await getSpendSummary({ ...query, category: "food' OR 1=1 --" }, db)).toEqual([]);
  });

  it("is idempotent and incorporates late records and corrected statuses/categories", async () => {
    const id = await payment("10");
    await aggregateSpendMetrics(db);
    await aggregateSpendMetrics(db);
    expect((await getSpendSummary(query, db))[0].ordersCount).toBe(1);
    await payment("20", "released", "2026-01-01T00:00:00Z");
    await db.query("UPDATE payment_records SET status = 'refunded' WHERE order_id = $id", { bind: { id } });
    await db.query("UPDATE merchants SET category = 'books'");
    await aggregateSpendMetrics(db);
    expect(await getSpendSummary(query, db)).toEqual([
      { date: "2026-01-01", category: "books", totalSpentStroops: "20", ordersCount: 1 },
    ]);
    await db.query("UPDATE payment_records SET status = 'refunded'");
    await aggregateSpendMetrics(db);
    expect(await getSpendSummary(query, db)).toEqual([]);
    expect(await getSpendSummary({ ...query, granularity: "monthly" }, db)).toEqual([]);
  });

  it("rolls back both summaries on failure and permits a subsequent retry", async () => {
    await payment("10");
    await aggregateSpendMetrics(db);
    await payment("20");
    await db.query("ALTER TABLE monthly_spend_metrics ADD CONSTRAINT fail_refresh CHECK (orders_count < 2)");
    try {
      await expect(aggregateSpendMetrics(db)).rejects.toThrow();
      expect((await getSpendSummary(query, db))[0].totalSpentStroops).toBe("10");
      expect((await getSpendSummary({ ...query, granularity: "monthly" }, db))[0].totalSpentStroops).toBe("10");
    } finally {
      await db.query("ALTER TABLE monthly_spend_metrics DROP CONSTRAINT fail_refresh");
    }
    await aggregateSpendMetrics(db);
    expect((await getSpendSummary(query, db))[0].totalSpentStroops).toBe("30");
  });

  it("skips a refresh while another replica owns the transaction lock", async () => {
    await db.transaction(async (transaction) => {
      await db.query("SELECT pg_advisory_xact_lock(306, 1)", { transaction });
      expect(await aggregateSpendMetrics(db)).toBe(false);
    });
    expect(await aggregateSpendMetrics(db)).toBe(true);
  });

  it.skipIf(process.env.SPEND_METRICS_BENCHMARK !== "true")("benchmarks a dashboard query over one million released escrows", async () => {
    await db.query(`INSERT INTO orders (id, user_id, merchant_id)
      SELECT md5(i::text)::uuid, $userId::uuid, $merchantId FROM generate_series(1, 1000000) i`,
      { bind: { userId, merchantId } });
    await db.query(`INSERT INTO payment_records (order_id, escrow_contract_id, buyer_address, seller_address,
        token_contract_id, amount_stroops, status, updated_at)
      SELECT id, 'escrow', 'buyer', 'seller', 'token', 100, 'released',
        '2026-01-01'::timestamptz + (row_number() OVER () % 59) * interval '1 day' FROM orders`);
    await db.query("ANALYZE orders; ANALYZE payment_records");
    const rawSql = `SELECT (p.updated_at AT TIME ZONE 'UTC')::date, m.category,
        SUM(p.amount_stroops - p.refunded_amount_stroops), COUNT(*)
      FROM payment_records p JOIN orders o ON o.id = p.order_id
      LEFT JOIN merchants m ON m.id::text = o.merchant_id
      WHERE p.status = 'released' AND o.user_id = $userId::uuid
        AND p.updated_at >= '2026-01-01' AND p.updated_at < '2026-03-01'
      GROUP BY 1, 2`;
    const rawStart = performance.now();
    await db.query(rawSql, { bind: { userId }, type: QueryTypes.SELECT });
    const rawMs = performance.now() - rawStart;
    const refreshStart = performance.now();
    await aggregateSpendMetrics(db);
    const refreshMs = performance.now() - refreshStart;
    await db.query("ANALYZE daily_spend_metrics; ANALYZE monthly_spend_metrics");
    await getSpendSummary(query, db);
    const timings: number[] = [];
    for (let i = 0; i < 30; i++) {
      const start = performance.now();
      const rows = await getSpendSummary(query, db);
      timings.push(performance.now() - start);
      expect(rows.reduce((sum, row) => sum + row.ordersCount, 0)).toBe(1_000_000);
    }
    timings.sort((a, b) => a - b);
    const p95Ms = timings[Math.ceil(timings.length * 0.95) - 1];
    console.info(JSON.stringify({ escrows: 1_000_000, rawMs, refreshMs, summaryP95Ms: p95Ms, samples: timings.length }));
    expect(p95Ms).toBeLessThan(20);
  }, 120_000);

  it("supports rolling back and reapplying the new migration", async () => {
    await db.query(await readFile(new URL("../../../../../database/migrations/043_spend_metrics.down.sql", import.meta.url), "utf8"));
    await db.query(await readFile(new URL("../../../../../database/migrations/043_spend_metrics.sql", import.meta.url), "utf8"));
    await aggregateSpendMetrics(db);
    expect(await getSpendSummary(query, db)).toEqual([]);
  });
});
