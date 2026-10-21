/**
 * Tests for Database Query Latency SLA Metric Tracker
 * Issue #387
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  configureDbMetrics,
  recordQueryDuration,
  getSlowQueries,
  getSlowQueryCount,
  clearSlowQueryLog,
  getSlaStatus,
  getDbMetricsConfig,
  resetDbMetrics,
  createTimedQueryWrapper,
  withQueryTiming,
  type QuerySlaMetric,
} from "./dbMetrics.js";

describe("Database Metrics", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetDbMetrics();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetDbMetrics();
  });

  describe("configureDbMetrics", () => {
    it("initializes with default config", () => {
      configureDbMetrics({});
      const config = getDbMetricsConfig();
      expect(config.slowQueryThresholdMs).toBe(100);
      expect(config.enableSlowQueryLogging).toBe(true);
      expect(config.histogramBuckets).toEqual([5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000]);
    });

    it("accepts custom configuration", () => {
      configureDbMetrics({
        slowQueryThresholdMs: 200,
        histogramBuckets: [10, 50, 100, 500],
        enableSlowQueryLogging: false,
      });
      const config = getDbMetricsConfig();
      expect(config.slowQueryThresholdMs).toBe(200);
      expect(config.histogramBuckets).toEqual([10, 50, 100, 500]);
      expect(config.enableSlowQueryLogging).toBe(false);
    });
  });

  describe("recordQueryDuration", () => {
    it("records query duration and returns metric", () => {
      configureDbMetrics({ slowQueryThresholdMs: 100 });
      const metric = recordQueryDuration("test_query", 50);

      expect(metric.queryTag).toBe("test_query");
      expect(metric.durationMs).toBe(50);
      expect(metric.isSlow).toBe(false);
    });

    it("marks queries exceeding threshold as slow", () => {
      configureDbMetrics({ slowQueryThresholdMs: 100 });
      const metric = recordQueryDuration("slow_query", 150);

      expect(metric.isSlow).toBe(true);
    });

    it("tracks slow queries in log", () => {
      configureDbMetrics({ slowQueryThresholdMs: 100, enableSlowQueryLogging: false });
      recordQueryDuration("slow_query", 150);
      recordQueryDuration("fast_query", 50);
      recordQueryDuration("another_slow", 200);

      const slowQueries = getSlowQueries();
      expect(slowQueries).toHaveLength(2);
      // getSlowQueries returns most recent first
      expect(slowQueries[0].queryTag).toBe("another_slow");
      expect(slowQueries[1].queryTag).toBe("slow_query");
    });

    it("limits slow query log size", () => {
      configureDbMetrics({ slowQueryThresholdMs: 10, enableSlowQueryLogging: false });

      for (let i = 0; i < 1100; i++) {
        recordQueryDuration(`query_${i}`, 20);
      }

      const slowQueries = getSlowQueries();
      expect(slowQueries.length).toBeLessThanOrEqual(1000);
    });

    it("includes custom labels", () => {
      configureDbMetrics({});
      const metric = recordQueryDuration("tagged_query", 50, { custom: "label", env: "test" });

      expect(metric.queryTag).toBe("tagged_query");
      expect(metric.durationMs).toBe(50);
    });
  });

  describe("getSlowQueries", () => {
    it("returns empty array when no slow queries", () => {
      configureDbMetrics({ slowQueryThresholdMs: 100 });
      recordQueryDuration("fast", 50);

      expect(getSlowQueries()).toHaveLength(0);
    });

    it("returns most recent slow queries first", () => {
      configureDbMetrics({ slowQueryThresholdMs: 100, enableSlowQueryLogging: false });
      recordQueryDuration("first_slow", 150);
      recordQueryDuration("second_slow", 200);
      recordQueryDuration("third_slow", 250);

      const slowQueries = getSlowQueries();
      // getSlowQueries returns most recent first (reverse chronological)
      expect(slowQueries[0].queryTag).toBe("third_slow");
      expect(slowQueries[1].queryTag).toBe("second_slow");
      expect(slowQueries[2].queryTag).toBe("first_slow");
    });

    it("respects limit parameter", () => {
      configureDbMetrics({ slowQueryThresholdMs: 10, enableSlowQueryLogging: false });
      for (let i = 0; i < 10; i++) {
        recordQueryDuration(`slow_${i}`, 20);
      }

      expect(getSlowQueries(3)).toHaveLength(3);
    });
  });

  describe("getSlaStatus", () => {
    it("returns healthy status when no slow queries", () => {
      configureDbMetrics({});
      recordQueryDuration("query1", 10);
      recordQueryDuration("query2", 20);

      const status = getSlaStatus();
      expect(status.healthy).toBe(true);
      expect(status.slowQueryRate).toBe(0);
      expect(status.totalQueries).toBe(2);
      expect(status.slowQueries).toBe(0);
    });

    it("returns unhealthy status when slow query rate exceeds 5%", () => {
      configureDbMetrics({ slowQueryThresholdMs: 100 });
      // 20 queries, 2 slow = 10% rate > 5%
      for (let i = 0; i < 18; i++) {
        recordQueryDuration(`fast_${i}`, 50);
      }
      recordQueryDuration("slow1", 150);
      recordQueryDuration("slow2", 200);

      const status = getSlaStatus();
      expect(status.healthy).toBe(false);
      expect(status.slowQueryRate).toBeGreaterThan(0.05);
    });

    it("includes threshold in status", () => {
      configureDbMetrics({ slowQueryThresholdMs: 200 });
      const status = getSlaStatus();
      expect(status.thresholdMs).toBe(200);
    });
  });

  describe("clearSlowQueryLog", () => {
    it("clears slow query log", () => {
      configureDbMetrics({ slowQueryThresholdMs: 100, enableSlowQueryLogging: false });
      recordQueryDuration("slow", 150);

      expect(getSlowQueryCount()).toBe(1);
      clearSlowQueryLog();
      expect(getSlowQueryCount()).toBe(0);
      expect(getSlowQueries()).toHaveLength(0);
    });
  });

  describe("withQueryTiming", () => {
    it("wraps async function and records timing", async () => {
      configureDbMetrics({ slowQueryThresholdMs: 100, enableSlowQueryLogging: false });

      // Use a function that returns immediately (fast)
      const fastFn = async (): Promise<string> => {
        return "result";
      };

      const result = await withQueryTiming("wrapped_query", fastFn);
      expect(result).toBe("result");

      const slowQueries = getSlowQueries();
      expect(slowQueries).toHaveLength(0);
    });

    it("records slow queries from wrapped function", async () => {
      configureDbMetrics({ slowQueryThresholdMs: 0, enableSlowQueryLogging: false });

      // Use a function that returns immediately - with threshold 0, any query is "slow"
      const fn = async (): Promise<string> => {
        return "result";
      };

      await withQueryTiming("slow_wrapped", fn);

      const slowQueries = getSlowQueries();
      expect(slowQueries).toHaveLength(1);
      expect(slowQueries[0].queryTag).toBe("slow_wrapped");
    });

    it("records timing even when function throws", async () => {
      configureDbMetrics({ slowQueryThresholdMs: 100, enableSlowQueryLogging: false });

      const throwingFn = async (): Promise<never> => {
        vi.advanceTimersByTime(30);
        throw new Error("test error");
      };

      await expect(withQueryTiming("throwing_query", throwingFn)).rejects.toThrow("test error");

      const slowQueries = getSlowQueries();
      expect(slowQueries).toHaveLength(0); // 30ms < 100ms
    });
  });

  describe("createTimedQueryWrapper", () => {
    it("creates wrapped function that records timing", async () => {
      configureDbMetrics({ slowQueryThresholdMs: 100, enableSlowQueryLogging: false });

      const originalFn = async (x: number): Promise<number> => {
        vi.advanceTimersByTime(25);
        return x * 2;
      };

      const wrappedFn = createTimedQueryWrapper("wrapped_multiply", originalFn);
      const result = await wrappedFn(5);

      expect(result).toBe(10);
      const slowQueries = getSlowQueries();
      expect(slowQueries).toHaveLength(0);
    });

    it("preserves function arguments and return type", async () => {
      configureDbMetrics({});

      const fn = async (a: string, b: number): Promise<string> => {
        return `${a}-${b}`;
      };

      const wrapped = createTimedQueryWrapper("concat", fn);
      const result = await wrapped("test", 42);

      expect(result).toBe("test-42");
    });
  });

  describe("resetDbMetrics", () => {
    it("resets all metrics state", () => {
      configureDbMetrics({ slowQueryThresholdMs: 50 });
      recordQueryDuration("test", 100);
      recordQueryDuration("test2", 200);

      expect(getSlowQueryCount()).toBe(2);

      resetDbMetrics();

      expect(getSlowQueryCount()).toBe(0);
      expect(getSlowQueries()).toHaveLength(0);
      const config = getDbMetricsConfig();
      expect(config.slowQueryThresholdMs).toBe(100); // back to default
    });
  });

  describe("getDbMetricsConfig", () => {
    it("returns current configuration", () => {
      configureDbMetrics({
        slowQueryThresholdMs: 150,
        histogramBuckets: [10, 20, 30],
        enableSlowQueryLogging: false,
      });

      const config = getDbMetricsConfig();
      expect(config.slowQueryThresholdMs).toBe(150);
      expect(config.histogramBuckets).toEqual([10, 20, 30]);
      expect(config.enableSlowQueryLogging).toBe(false);
    });
  });
});