/**
 * Database Query Latency SLA Metric Tracker with Histogram Buckets
 * Issue #387: Track database query execution times in Prometheus histograms
 * and alert on queries exceeding 100ms.
 *
 * Features:
 * - Wraps database client with timing metrics
 * - Exports Prometheus histograms with configurable buckets
 * - Tracks slow queries (> 100ms by default)
 * - Provides query tagging for granular metrics
 * - Integrates with existing ServiceMetricsRegistry
 */

import { createLogger } from "@delegolabs/utils";
import { ServiceMetricsRegistry, Histogram } from "@delegolabs/utils";

const log = createLogger("gateway:dbMetrics", process.env.LOG_LEVEL ?? "info");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QuerySlaMetric {
  queryTag: string;
  durationMs: number;
  isSlow: boolean;
}

export interface DbMetricsConfig {
  slowQueryThresholdMs: number;
  histogramBuckets: number[];
  enableSlowQueryLogging: boolean;
}

export interface DbMetrics {
  queryDurationHistogram: Histogram;
  slowQueryCounter: any;
  queryCounter: any;
}

export interface QueryMetricsResult {
  queryTag: string;
  durationMs: number;
  isSlow: boolean;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: DbMetricsConfig = {
  slowQueryThresholdMs: 100,
  histogramBuckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
  enableSlowQueryLogging: true,
};

const DEFAULT_HISTOGRAM_BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

// ---------------------------------------------------------------------------
// Internal State
// ---------------------------------------------------------------------------

let config: DbMetricsConfig = DEFAULT_CONFIG;
let metricsRegistry: ServiceMetricsRegistry | null = null;
let queryDurationHistogram: Histogram | null = null;
let slowQueryCounter: any = null;
let queryCounter: any = null;
let isInitialized = false;

// Slow query log buffer for alerting
const slowQueryLog: QueryMetricsResult[] = [];
const MAX_SLOW_QUERY_LOG = 1000;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export function configureDbMetrics(
  cfg: Partial<DbMetricsConfig>,
  registry?: ServiceMetricsRegistry
): void {
  config = { ...DEFAULT_CONFIG, ...cfg };
  metricsRegistry = registry ?? null;

  if (metricsRegistry) {
    queryDurationHistogram = metricsRegistry.histogram("db_query_duration_ms");
    slowQueryCounter = metricsRegistry.counter("db_slow_queries_total");
    queryCounter = metricsRegistry.counter("db_queries_total");
  } else {
    // Create standalone histogram if no registry provided
    queryDurationHistogram = createStandaloneHistogram();
    slowQueryCounter = createSimpleCounter("db_slow_queries_total");
    queryCounter = createSimpleCounter("db_queries_total");
  }

  isInitialized = true;

  log.info("Database metrics configured", {
    slowQueryThresholdMs: config.slowQueryThresholdMs,
    histogramBuckets: config.histogramBuckets,
    enableSlowQueryLogging: config.enableSlowQueryLogging,
  });
}

function createStandaloneHistogram(): Histogram {
  const buckets = new Map<string, number[]>();

  return {
    observe(value: number, labels?: Record<string, string>): void {
      const key = labels ? Object.entries(labels).sort().map(([k, v]) => `${k}=${v}`).join(",") : "";
      if (!buckets.has(key)) {
        buckets.set(key, []);
      }
      buckets.get(key)!.push(value);
    },
    count(labels?: Record<string, string>): number {
      const key = labels ? Object.entries(labels).sort().map(([k, v]) => `${k}=${v}`).join(",") : "";
      return buckets.get(key)?.length ?? 0;
    },
    sum(labels?: Record<string, string>): number {
      const key = labels ? Object.entries(labels).sort().map(([k, v]) => `${k}=${v}`).join(",") : "";
      return buckets.get(key)?.reduce((a, b) => a + b, 0) ?? 0;
    },
    entries() {
      return [];
    },
  };
}

function createSimpleCounter(name: string) {
  const counts = new Map<string, number>();
  return {
    inc(value = 1, labels?: Record<string, string>): void {
      const key = labels ? Object.entries(labels).sort().map(([k, v]) => `${k}=${v}`).join(",") : "";
      counts.set(key, (counts.get(key) ?? 0) + value);
    },
    value(labels?: Record<string, string>): number {
      const key = labels ? Object.entries(labels).sort().map(([k, v]) => `${k}=${v}`).join(",") : "";
      return counts.get(key) ?? 0;
    },
    entries() {
      return Array.from(counts.entries()).map(([key, value]) => ({
        labels: key.split(",").reduce((acc, pair) => {
          const [k, v] = pair.split("=");
          if (k) acc[k] = v;
          return acc;
        }, {} as Record<string, string>),
        value,
      }));
    },
  };
}

// ---------------------------------------------------------------------------
// Core Metrics Recording
// ---------------------------------------------------------------------------

export function recordQueryDuration(
  queryTag: string,
  durationMs: number,
  labels?: Record<string, string>
): QuerySlaMetric {
  if (!isInitialized) {
    configureDbMetrics({});
  }

  const isSlow = durationMs > config.slowQueryThresholdMs;

  const metricLabels = {
    query_tag: queryTag,
    ...labels,
  };

  queryDurationHistogram?.observe(durationMs, metricLabels);
  queryCounter?.inc(1, metricLabels);

  if (isSlow) {
    slowQueryCounter?.inc(1, metricLabels);

    const result: QueryMetricsResult = {
      queryTag,
      durationMs,
      isSlow: true,
      timestamp: Date.now(),
    };

    slowQueryLog.push(result);
    if (slowQueryLog.length > MAX_SLOW_QUERY_LOG) {
      slowQueryLog.shift();
    }

    if (config.enableSlowQueryLogging) {
      log.warn("Slow query detected", {
        queryTag,
        durationMs,
        thresholdMs: config.slowQueryThresholdMs,
        ...labels,
      });
    }
  }

  return { queryTag, durationMs, isSlow };
}

export function recordQuery(
  queryTag: string,
  durationMs: number,
  labels?: Record<string, string>
): QuerySlaMetric {
  return recordQueryDuration(queryTag, durationMs, labels);
}

// ---------------------------------------------------------------------------
// Wrapper Functions for Database Clients
// ---------------------------------------------------------------------------

export interface QueryExecutor<T> {
  (): Promise<T>;
}

export async function withQueryTiming<T>(
  queryTag: string,
  executor: QueryExecutor<T>,
  labels?: Record<string, string>
): Promise<T> {
  const startTime = performance.now();
  try {
    const result = await executor();
    return result;
  } finally {
    const durationMs = performance.now() - startTime;
    recordQueryDuration(queryTag, durationMs, labels);
  }
}

export function createTimedQueryWrapper<T extends (...args: any[]) => Promise<any>>(
  queryTag: string,
  fn: T,
  labels?: Record<string, string>
): T {
  const wrapped = async (...args: Parameters<T>): Promise<ReturnType<T>> => {
    const startTime = performance.now();
    try {
      return await fn(...args);
    } finally {
      const durationMs = performance.now() - startTime;
      recordQueryDuration(queryTag, durationMs, labels);
    }
  };
  return wrapped as T;
}

// ---------------------------------------------------------------------------
// Sequelize Integration
// ---------------------------------------------------------------------------

let originalQuery: any = null;
let originalQueryRaw: any = null;

export function instrumentSequelize(sequelize: any): void {
  if (!isInitialized) {
    configureDbMetrics({});
  }

  if (originalQuery) {
    log.warn("Sequelize already instrumented");
    return;
  }

  originalQuery = sequelize.query.bind(sequelize);
  originalQueryRaw = sequelize.queryRaw?.bind(sequelize) ?? null;

  sequelize.query = async function instrumentedQuery(sql: string, options: any = {}): Promise<any> {
    const queryTag = extractQueryTag(sql, options);
    const startTime = performance.now();

    try {
      const result = await originalQuery(sql, options);
      return result;
    } finally {
      const durationMs = performance.now() - startTime;
      recordQueryDuration(queryTag, durationMs, {
        type: options.raw ? "raw" : "orm",
        model: options.model?.name ?? "unknown",
      });
    }
  };

  if (originalQueryRaw) {
    sequelize.queryRaw = async function instrumentedQueryRaw(sql: string, options: any = {}): Promise<any> {
      const queryTag = extractQueryTag(sql, options);
      const startTime = performance.now();

      try {
        const result = await originalQueryRaw(sql, options);
        return result;
      } finally {
        const durationMs = performance.now() - startTime;
        recordQueryDuration(queryTag, durationMs, {
          type: "raw",
          model: "unknown",
        });
      }
    };
  }

  log.info("Sequelize instrumented for query timing");
}

function extractQueryTag(sql: string, options: any): string {
  // Try to get a meaningful tag from the query
  if (options?.model?.name) {
    return `model:${options.model.name}`;
  }

  // Extract first word (SELECT, INSERT, UPDATE, DELETE, etc.)
  const match = sql.trim().match(/^(\w+)/i);
  if (match) {
    return match[1].toLowerCase();
  }

  // Check for common patterns
  if (sql.includes("FROM ")) {
    const fromMatch = sql.match(/FROM\s+(\w+)/i);
    if (fromMatch) return `select:${fromMatch[1]}`;
  }
  if (sql.includes("INTO ")) {
    const intoMatch = sql.match(/INTO\s+(\w+)/i);
    if (intoMatch) return `insert:${intoMatch[1]}`;
  }
  if (sql.includes("UPDATE ")) {
    const updateMatch = sql.match(/UPDATE\s+(\w+)/i);
    if (updateMatch) return `update:${updateMatch[1]}`;
  }
  if (sql.includes("DELETE FROM ")) {
    const deleteMatch = sql.match(/DELETE FROM\s+(\w+)/i);
    if (deleteMatch) return `delete:${deleteMatch[1]}`;
  }

  return "unknown";
}

export function uninstrumentSequelize(sequelize: any): void {
  if (originalQuery) {
    sequelize.query = originalQuery;
    originalQuery = null;
  }
  if (originalQueryRaw) {
    sequelize.queryRaw = originalQueryRaw;
    originalQueryRaw = null;
  }
  log.info("Sequelize uninstrumented");
}

// ---------------------------------------------------------------------------
// pg (node-postgres) Pool Integration
// ---------------------------------------------------------------------------

export function instrumentPgPool(pool: any): void {
  if (!isInitialized) {
    configureDbMetrics({});
  }

  const originalQuery = pool.query.bind(pool);

  pool.query = async function instrumentedQuery(text: string, params?: any[]): Promise<any> {
    const queryTag = extractQueryTag(text, {});
    const startTime = performance.now();

    try {
      const result = await originalQuery(text, params);
      return result;
    } finally {
      const durationMs = performance.now() - startTime;
      recordQueryDuration(queryTag, durationMs, {
        type: "pg",
      });
    }
  };

  log.info("pg Pool instrumented for query timing");
}

// ---------------------------------------------------------------------------
// Metrics Retrieval
// ---------------------------------------------------------------------------

export function getSlowQueries(limit = 100): QueryMetricsResult[] {
  return slowQueryLog.slice(-limit).reverse();
}

export function getSlowQueryCount(): number {
  return slowQueryLog.length;
}

export function clearSlowQueryLog(): void {
  slowQueryLog.length = 0;
}

export function getDbMetricsConfig(): DbMetricsConfig {
  return { ...config };
}

// ---------------------------------------------------------------------------
// Health Check / SLA Status
// ---------------------------------------------------------------------------

export interface SlaStatus {
  healthy: boolean;
  slowQueryRate: number;
  avgQueryDurationMs: number;
  p95QueryDurationMs: number;
  p99QueryDurationMs: number;
  totalQueries: number;
  slowQueries: number;
  thresholdMs: number;
}

export function getSlaStatus(): SlaStatus {
  if (!queryDurationHistogram) {
    return {
      healthy: true,
      slowQueryRate: 0,
      avgQueryDurationMs: 0,
      p95QueryDurationMs: 0,
      p99QueryDurationMs: 0,
      totalQueries: 0,
      slowQueries: 0,
      thresholdMs: config.slowQueryThresholdMs,
    };
  }

  // Note: SimpleHistogram doesn't store individual values, so we can't compute percentiles
  // This would need a more sophisticated histogram implementation
  const totalQueries = queryCounter?.entries().reduce((sum: number, e: any) => sum + e.value, 0) ?? 0;
  const slowQueries = slowQueryCounter?.entries().reduce((sum: number, e: any) => sum + e.value, 0) ?? 0;

  return {
    healthy: slowQueries === 0 || (totalQueries > 0 && slowQueries / totalQueries < 0.05),
    slowQueryRate: totalQueries > 0 ? slowQueries / totalQueries : 0,
    avgQueryDurationMs: 0, // Would need percentile histogram
    p95QueryDurationMs: 0,
    p99QueryDurationMs: 0,
    totalQueries,
    slowQueries,
    thresholdMs: config.slowQueryThresholdMs,
  };
}

// ---------------------------------------------------------------------------
// Prometheus Export
// ---------------------------------------------------------------------------

export function toPrometheusText(): string {
  if (!metricsRegistry) {
    return "";
  }
  return metricsRegistry.toPrometheusText();
}

// ---------------------------------------------------------------------------
// Test Utilities
// ---------------------------------------------------------------------------

export function resetDbMetrics(): void {
  config = DEFAULT_CONFIG;
  metricsRegistry = null;
  queryDurationHistogram = null;
  slowQueryCounter = null;
  queryCounter = null;
  isInitialized = false;
  slowQueryLog.length = 0;
}