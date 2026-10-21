/**
 * Tests for In-Memory LRU Cache for Merchant Catalog Semantic Embeddings
 * Issue #389
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  configureEmbeddingCache,
  getCachedEmbedding,
  setCachedEmbedding,
  generateEmbeddingCacheKey,
  getEmbeddingCacheMetrics,
  clearEmbeddingCache,
  invalidateEmbeddingCache,
  startPeriodicCleanup,
  stopPeriodicCleanup,
} from "./embeddingCache.js";

describe("Embedding Cache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearEmbeddingCache();
    configureEmbeddingCache({ maxEntries: 3, ttlMs: 1000 });
  });

  afterEach(() => {
    vi.useRealTimers();
    stopPeriodicCleanup();
  });

  describe("generateEmbeddingCacheKey", () => {
    it("generates consistent keys for same input", () => {
      const key1 = generateEmbeddingCacheKey("test query");
      const key2 = generateEmbeddingCacheKey("test query");
      expect(key1).toBe(key2);
    });

    it("generates different keys for different inputs", () => {
      const key1 = generateEmbeddingCacheKey("query 1");
      const key2 = generateEmbeddingCacheKey("query 2");
      expect(key1).not.toBe(key2);
    });
  });

  describe("getCachedEmbedding / setCachedEmbedding", () => {
    it("returns null for cache miss", () => {
      const result = getCachedEmbedding("nonexistent");
      expect(result).toBeNull();
    });

    it("stores and retrieves embedding", () => {
      const vector = [0.1, 0.2, 0.3, 0.4];
      const key = generateEmbeddingCacheKey("test query");

      setCachedEmbedding(key, vector);
      const result = getCachedEmbedding(key);

      expect(result).toEqual(vector);
    });

    it("tracks cache hits and misses", () => {
      const key = generateEmbeddingCacheKey("test");

      getCachedEmbedding(key);
      const metrics1 = getEmbeddingCacheMetrics();
      expect(metrics1.misses).toBe(1);
      expect(metrics1.hits).toBe(0);

      const vector = [0.1, 0.2, 0.3];
      setCachedEmbedding(key, vector);
      getCachedEmbedding(key);

      const metrics2 = getEmbeddingCacheMetrics();
      expect(metrics2.hits).toBe(1);
      expect(metrics2.misses).toBe(1);
    });

    it("calculates hit rate correctly", () => {
      const key = generateEmbeddingCacheKey("test");
      const vector = [0.1, 0.2, 0.3];

      setCachedEmbedding(key, vector);
      // 3 hits, 0 misses = 3/3 = 100%
      getCachedEmbedding(key);
      getCachedEmbedding(key);
      getCachedEmbedding(key);

      const metrics = getEmbeddingCacheMetrics();
      expect(metrics.hitRate).toBe(100); // 3 hits / 3 total = 100%
    });
  });

  describe("LRU eviction", () => {
    it("evicts least recently used entry when maxEntries exceeded", () => {
      const key1 = generateEmbeddingCacheKey("query1");
      const key2 = generateEmbeddingCacheKey("query2");
      const key3 = generateEmbeddingCacheKey("query3");
      const key4 = generateEmbeddingCacheKey("query4");

      setCachedEmbedding(key1, [1, 2, 3]);
      setCachedEmbedding(key2, [2, 3, 4]);
      setCachedEmbedding(key3, [3, 4, 5]);

      // Access key1 to make it recently used
      getCachedEmbedding(key1);

      // Add key4, should evict key2 (least recently used)
      setCachedEmbedding(key4, [4, 5, 6]);

      expect(getCachedEmbedding(key1)).toEqual([1, 2, 3]);
      expect(getCachedEmbedding(key2)).toBeNull(); // evicted
      expect(getCachedEmbedding(key3)).toEqual([3, 4, 5]);
      expect(getCachedEmbedding(key4)).toEqual([4, 5, 6]);

      const metrics = getEmbeddingCacheMetrics();
      expect(metrics.evictions).toBe(1);
    });

    it("updates access order on cache hit", () => {
      const key1 = generateEmbeddingCacheKey("query1");
      const key2 = generateEmbeddingCacheKey("query2");
      const key3 = generateEmbeddingCacheKey("query3");
      const key4 = generateEmbeddingCacheKey("query4");

      setCachedEmbedding(key1, [1, 2, 3]);
      setCachedEmbedding(key2, [2, 3, 4]);
      setCachedEmbedding(key3, [3, 4, 5]);

      // Access key1 and key2
      getCachedEmbedding(key1);
      getCachedEmbedding(key2);

      // Add key4, should evict key3 (least recently used)
      setCachedEmbedding(key4, [4, 5, 6]);

      expect(getCachedEmbedding(key1)).toEqual([1, 2, 3]);
      expect(getCachedEmbedding(key2)).toEqual([2, 3, 4]);
      expect(getCachedEmbedding(key3)).toBeNull(); // evicted
      expect(getCachedEmbedding(key4)).toEqual([4, 5, 6]);
    });
  });

  describe("TTL expiration", () => {
    it("expires entries after TTL", () => {
      const key = generateEmbeddingCacheKey("test");
      setCachedEmbedding(key, [0.1, 0.2, 0.3]);

      expect(getCachedEmbedding(key)).toEqual([0.1, 0.2, 0.3]);

      vi.advanceTimersByTime(2000); // Advance past TTL

      expect(getCachedEmbedding(key)).toBeNull();

      const metrics = getEmbeddingCacheMetrics();
      expect(metrics.misses).toBe(1);
    });

    it("does not expire entries before TTL", () => {
      const key = generateEmbeddingCacheKey("test");
      setCachedEmbedding(key, [0.1, 0.2, 0.3]);

      vi.advanceTimersByTime(500); // Advance but not past TTL

      expect(getCachedEmbedding(key)).toEqual([0.1, 0.2, 0.3]);
    });
  });

  describe("clearEmbeddingCache", () => {
    it("clears all entries and resets metrics", () => {
      const key = generateEmbeddingCacheKey("test");
      setCachedEmbedding(key, [0.1, 0.2, 0.3]);
      getCachedEmbedding(key); // hit

      clearEmbeddingCache();

      // Check metrics immediately after clear (before any new requests)
      const metrics = getEmbeddingCacheMetrics();
      expect(metrics.hits).toBe(0);
      expect(metrics.misses).toBe(0);
      expect(metrics.cacheSize).toBe(0);
      expect(metrics.evictions).toBe(0);

      // Now verify cache is actually empty
      expect(getCachedEmbedding(key)).toBeNull();
    });
  });

  describe("invalidateEmbeddingCache", () => {
    it("invalidates all entries when no pattern provided", () => {
      const key1 = generateEmbeddingCacheKey("test1");
      const key2 = generateEmbeddingCacheKey("test2");
      setCachedEmbedding(key1, [0.1, 0.2, 0.3]);
      setCachedEmbedding(key2, [0.4, 0.5, 0.6]);

      const invalidated = invalidateEmbeddingCache();

      expect(invalidated).toBe(2);
      expect(getCachedEmbedding(key1)).toBeNull();
      expect(getCachedEmbedding(key2)).toBeNull();
    });

    it("invalidates entries matching pattern", () => {
      const key1 = generateEmbeddingCacheKey("product_1");
      const key2 = generateEmbeddingCacheKey("product_2");
      const key3 = generateEmbeddingCacheKey("other");
      setCachedEmbedding(key1, [0.1, 0.2, 0.3]);
      setCachedEmbedding(key2, [0.4, 0.5, 0.6]);
      setCachedEmbedding(key3, [0.7, 0.8, 0.9]);

      // Pattern matches against the hash key
      // Use the full key1 as pattern to match only that entry
      const invalidated = invalidateEmbeddingCache(new RegExp(`^${key1}$`));

      expect(invalidated).toBe(1);
      expect(getCachedEmbedding(key1)).toBeNull();
      expect(getCachedEmbedding(key2)).toEqual([0.4, 0.5, 0.6]);
      expect(getCachedEmbedding(key3)).toEqual([0.7, 0.8, 0.9]);
    });
  });

  describe("configureEmbeddingCache", () => {
    it("updates configuration", () => {
      configureEmbeddingCache({ maxEntries: 5000, ttlMs: 3600000 });

      const metrics = getEmbeddingCacheMetrics();
      expect(metrics.cacheSize).toBe(0);
    });
  });

  describe("periodic cleanup", () => {
    it("starts and stops cleanup interval", () => {
      startPeriodicCleanup(1000);
      stopPeriodicCleanup();

      // Should not throw
      expect(true).toBe(true);
    });

    it("cleans up expired entries periodically", () => {
      const key = generateEmbeddingCacheKey("test");
      setCachedEmbedding(key, [0.1, 0.2, 0.3]);

      startPeriodicCleanup(100);

      vi.advanceTimersByTime(2000);

      expect(getCachedEmbedding(key)).toBeNull();

      stopPeriodicCleanup();
    });
  });

  describe("metrics tracking", () => {
    it("tracks average latency", () => {
      const key = generateEmbeddingCacheKey("test");
      const vector = [0.1, 0.2, 0.3];

      setCachedEmbedding(key, vector);

      // Multiple hits
      for (let i = 0; i < 10; i++) {
        getCachedEmbedding(key);
      }

      const metrics = getEmbeddingCacheMetrics();
      expect(metrics.avgLatencyMs).toBeGreaterThanOrEqual(0);
    });
  });
});