import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import {
  StockAlertRuleRepository,
  StockAlertRuleDuplicateError,
} from "./stockAlertRuleRepository.js";

/**
 * Integration tests for the stock alert rule repository.
 *
 * Requires a reachable Postgres database. Configure via the standard
 * PG environment variables (PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE) or
 * DATABASE_URL. Tests are skipped when no connection is configured.
 */

const connectionString = process.env.DATABASE_URL;
const hasDbConfig = Boolean(
  connectionString || (process.env.PGHOST && process.env.PGDATABASE)
);

const migrationPath = join(
  __dirname,
  "../../../../database/migrations/20261020_stock_alert_rules.sql"
);

describe.skip(!hasDbConfig, "StockAlertRuleRepository integration", () => {
  let client: Client;
  let repo: StockAlertRuleRepository;

  beforeAll(async () => {
    client = new Client(connectionString ? { connectionString } : {});
    await client.connect();
    const migrationSql = readFileSync(migrationPath, "utf-8");
    await client.query(migrationSql);
    repo = new StockAlertRuleRepository(client);
  });

  afterAll(async () => {
    await client.query("DROP TABLE IF EXISTS stock_alert_rules");
    await client.end();
  });

  beforeEach(async () => {
    await client.query("TRUNCATE TABLE stock_alert_rules");
  });

  it("creates and retrieves a rule", async () => {
    const created = await repo.create({
      merchantId: "merchant-1",
      productId: "product-1",
      skuId: "sku-1",
      thresholdQuantity: 10,
      channelTarget: "ops-alerts@example.com",
    });

    expect(created.id).toBeTruthy();
    expect(created.merchantId).toBe("merchant-1");
    expect(created.notificationChannel).toBe("email");
    expect(created.isActive).toBe(true);

    const found = await repo.findById(created.id);
    expect(found).not.toBeNull();
    expect(found?.skuId).toBe("sku-1");
  });

  it("prevents duplicate rules for the same merchant/product/SKU", async () => {
    const input = {
      merchantId: "merchant-1",
      productId: "product-1",
      skuId: "sku-1",
      thresholdQuantity: 5,
      channelTarget: "ops@example.com",
    } as const;

    await repo.create(input);
    await expect(repo.create(input)).rejects.toBeInstanceOf(
      StockAlertRuleDuplicateError
    );
  });

  it("prevents duplicates when SKU is null (DEFAULT bucket)", async () => {
    const input = {
      merchantId: "merchant-1",
      productId: "product-1",
      skuId: null,
      thresholdQuantity: 5,
      channelTarget: "ops@example.com",
    } as const;

    await repo.create(input);
    await expect(repo.create(input)).rejects.toBeInstanceOf(
      StockAlertRuleDuplicateError
    );
  });

  it("allows different SKUs for the same product", async () => {
    const base = {
      merchantId: "merchant-1",
      productId: "product-1",
      thresholdQuantity: 5,
      channelTarget: "ops@example.com",
    } as const;

    const a = await repo.create({ ...base, skuId: "sku-1" });
    const b = await repo.create({ ...base, skuId: "sku-2" });
    expect(a.id).not.toBe(b.id);
  });

  it("updates and deletes a rule", async () => {
    const created = await repo.create({
      merchantId: "merchant-1",
      productId: "product-1",
      skuId: "sku-1",
      thresholdQuantity: 5,
      channelTarget: "ops@example.com",
    });

    const updated = await repo.update(created.id, {
      thresholdQuantity: 20,
      notificationChannel: "webhook",
      channelTarget: "https://hooks.example.com/stock",
    });
    expect(updated?.thresholdQuantity).toBe(20);
    expect(updated?.notificationChannel).toBe("webhook");

    await repo.markTriggered(created.id);
    const triggered = await repo.findById(created.id);
    expect(triggered?.lastTriggeredAt).instanceof(Date);

    const deleted = await repo.delete(created.id);
    expect(deleted).toBe(true);
    expect(await repo.findById(created.id)).toBeNull();
  });
});
