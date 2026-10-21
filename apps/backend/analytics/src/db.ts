import { Sequelize } from "sequelize";
import { createLogger } from "@delegolabs/utils";

const log = createLogger("analytics:db", process.env.LOG_LEVEL ?? "info");

const databaseUrl = process.env.DATABASE_URL ?? "postgresql://delego:delego@localhost:5432/delego";

export const sequelize = new Sequelize(databaseUrl, {
  dialect: "postgres",
  logging: (msg) => log.debug(msg),
  pool: {
    min: Number(process.env.DATABASE_POOL_MIN ?? 2),
    max: Number(process.env.DATABASE_POOL_MAX ?? 10),
    acquire: 30000,
    idle: 10000,
  },
  define: {
    underscored: true,
    timestamps: true,
  },
});

export interface MerchantDailyGmvRow {
  bucket_day: Date;
  merchant_id: string;
  currency: string;
  total_orders: number;
  gross_volume_stroops: string;
  total_platform_fees_stroops: string;
  disputed_orders_count: number;
}

export interface MerchantDailyGmvQuery {
  merchantId: string;
  currency?: string;
  startDate: Date;
  endDate: Date;
}

/**
 * Query the merchant_daily_gmv_summary continuous aggregate.
 * Returns per-day GMV, fee, and order aggregates for a merchant.
 */
export async function getMerchantDailyGmv(query: MerchantDailyGmvQuery): Promise<MerchantDailyGmvRow[]> {
  const conditions = ["merchant_id = :merchantId", "bucket_day >= :startDate", "bucket_day < :endDate"];
  const replacements: Record<string, unknown> = {
    merchantId: query.merchantId,
    startDate: query.startDate,
    endDate: query.endDate,
  };

  if (query.currency) {
    conditions.push("currency = :currency");
    replacements.currency = query.currency;
  }

  const [rows] = await sequelize.query(
    `SELECT bucket_day, merchant_id, currency, total_orders,
            gross_volume_stroops, total_platform_fees_stroops, disputed_orders_count
       FROM merchant_daily_gmv_summary
      WHERE ${conditions.join(" AND ")}
      ORDER BY bucket_day ASC`,
    { replacements, raw: true }
  );

  return rows as MerchantDailyGmvRow[];
}

export async function connectDb(): Promise<void> {
  try {
    await sequelize.authenticate();
    log.info("Database connection established successfully.");
  } catch (err) {
    log.error("Unable to connect to the database", err instanceof Error ? { error: err.message } : { error: String(err) });
    throw err;
  }
}

/**
 * Check PostgreSQL connectivity with a lightweight query.
 * Returns the query latency in milliseconds or throws on failure.
 * @param timeoutMs - Query timeout in milliseconds (default: 5000)
 */
export async function checkDatabaseHealth(timeoutMs: number = 5000): Promise<number> {
  const startTime = performance.now();
  let timeoutId: NodeJS.Timeout | null = null;
  
  try {
    const queryPromise = sequelize.query("SELECT 1", { raw: true });
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error("Database health check timeout")), timeoutMs);
    });
    
    await Promise.race([queryPromise, timeoutPromise]);
    const endTime = performance.now();
    return endTime - startTime;
  } catch (err) {
    log.warn("Database health check failed", err instanceof Error ? { error: err.message } : { error: String(err) });
    throw err;
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}
