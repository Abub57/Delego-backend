import { Pool, PoolClient } from 'pg';

export type NotificationChannel = 'email' | 'webhook' |'telegram';

export interface StockAlertRule {
  id: string;
  merchantId: string;
  productId: string;
  skuId: string | null;
  thresholdQuantity: number;
  notificationChannel: NotificationChannel;
  channelTarget: string;
  lastTriggeredAt: Date | null;
  isActive: boolean;
  createdAt: Date;
}

export interface CreateStockAlertRuleInput {
  merchantId: string;
  productId: string;
  skuId?: string | null;
  thresholdQuantity: number;
  notificationChannel?: NotificationChannel;
  channelTarget: string;
  isActive?: boolean;
}

export interface UpdateStockAlertRuleInput {
  thresholdQuantity?: number;
  notificationChannel?: NotificationChannel;
  channelTarget?: string;
  isActive?: boolean;
}

export class DuplicateStockAlertRuleError extends Error {
  constructor(merchantId: string, productId: string, skuId: string | null) {
    super(
      `Stock alert rule already exists for merchant ${merchantId}, product ${productId}, sku ${skuId ?? 'DEFAULT'}`,
    );
    this.name = 'DuplicateStockAlertRuleError';
  }
}

interface StockAlertRuleRow {
  id: string;
  merchant_id: string;
  product_id: string;
  sku_id: string | null;
  threshold_quantity: number;
  notification_channel: NotificationChannel;
  channel_target: string;
  last_triggered_at: Date | null;
  is_active: boolean;
  created_at: Date;
}

function mapRow(row: StockAlertRuleRow): StockAlertRule {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    productId: row.product_id,
    skuId: row.sku_id,
    thresholdQuantity: row.threshold_quantity,
    notificationChannel: row.notification_channel,
    channelTarget: row.channel_target,
    lastTriggeredAt: row.last_triggered_at,
    isActive: row.is_active,
    createdAt: row.created_at,
  };
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: string }).code === '23505'
  );
}

export class StockAlertRuleRepository {
  constructor(private readonly pool: Pool) {}

  async create(input: CreateStockAlertRuleInput): Promise<StockAlertRule> {
    const skuId = input.skuId ?? null;
    try {
      const result = await this.pool.query<StockAlertRuleRow>(
        `INSERT INTO stock_alert_rules
           (merchant_id, product_id, sku_id, threshold_quantity,
            notification_channel, channel_target, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING * `,
        [
          input.merchantId,
          input.productId,
          skuId,
          input.thresholdQuantity,
          input.notificationChannel ?? 'email',
          input.channelTarget,
          input.isActive ?? true,
        ],
      );
      return mapRow(result.rows[0]);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new DuplicateStockAlertRuleError(
          input.merchantId,
          input.productId,
          skuId,
        );
      }
      throw err;
    }
  }

  async findById(id: string): Promise<StockAlertRule | null> {
    const result = await this.pool.query<StockAlertRuleRow>(
      `SELECT * FROM stock_alert_rules WHERE id = $1`,
      [id],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  async findByMerchant(merchantId: string): Promise<StockAlertRule[]> {
    const result = await this.pool.query<StockAlertRuleRow>(
      `SELECT * FROM stock_alert_rules
       WHERE merchant_id = $1
       ORDER BY created_at DESC`,
      [merchantId],
    );
    return result.rows.map(mapRow);
  }

  async findActiveBySku(
    merchantId: string,
    productId: string,
    skuId: string | null,
  ): Promise<StockAlertRule | null> {
    const result = await this.pool.query<StockAlertRuleRow>(
      `SELECT * FROM stock_alert_rules
       WHERE merchant_id = $1
         AND product_id = $2
         AND COALESCE(sku_id, 'DEFAULT') = COALESCE($3::text, 'DEFAULT')
         AND is_active = true`,
      [merchantId, productId, skuId],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  async update(
    id: string,
    input: UpdateStockAlertRuleInput,
  ): Promise<StockAlertRule | null> {
    const setClauses: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (input.thresholdQuantity !== undefined) {
      setClauses.push(`threshold_quantity = $${idx++}`);
      values.push(input.thresholdQuantity);
    }
    if (input.notificationChannel !== undefined) {
      setClauses.push(`notification_channel = $${idx++}`);
      values.push(input.notificationChannel);
    }
    if (input.channelTarget !== undefined) {
      setClauses.push(`channel_target = $${idx++}`);
      values.push(input.channelTarget);
    }
    if (input.isActive !== undefined) {
      setClauses.push(`is_active = $${idx++}`);
      values.push(input.isActive);
    }

    if (setClauses.length === 0) {
      return this.findById(id);
    }

    values.push(id);
    const result = await this.pool.query<StockAlertRuleRow>(
      `UPDATE stock_alert_rules
       SET ${setClauses.join(', ')}
       WHERE id = $${idx}
       RETURNING *`,
      values,
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  async markTriggered(id: string, triggeredAt: Date = new Date()): Promise<void> {
    await this.pool.query(
      `UPDATE stock_alert_rules SET last_triggered_at = $1 WHERE id = $2`,
      [triggeredAt, id],
    );
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM stock_alert_rules WHERE id = $1`,
      [id],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async withTransaction<T>(
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}

export default StockAlertRuleRepository;
