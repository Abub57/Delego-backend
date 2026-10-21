/**
 * In-Memory LRU Cache for Merchant Catalog Semantic Embeddings
 * Issue #389: Cache vector embeddings of popular products to reduce
 * OpenAI/Cohere embedding API costs and latency.
 *
 * Features:
 * - LRU eviction policy with configurable max entries
 * - Cache hit/miss metrics tracking
 * - TTL-based expiration
 * - Thread-safe operations
 */

import { createLogger } from "@delegolabs/utils";

const log = createLogger("gateway:embeddingCache", process.env.LOG_LEVEL ?? "info");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EmbeddingCacheEntry {
  productTextHash: string;
  vector: number[];
  cachedAt: number;
}

export interface EmbeddingCacheConfig {
  maxEntries: number;
  ttlMs: number;
}

export interface EmbeddingCacheMetrics {
  hits: number;
  misses: number;
  hitRate: number;
  cacheSize: number;
  evictions: number;
  avgLatencyMs: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: EmbeddingCacheConfig = {
  maxEntries: 10000,
  ttlMs: 24 * 60 * 60 * 1000, // 24 hours
};

// ---------------------------------------------------------------------------
// Internal State
// ---------------------------------------------------------------------------

let config: EmbeddingCacheConfig = DEFAULT_CONFIG;
const cache = new Map<string, EmbeddingCacheEntry>();
const accessOrder: string[] = [];

let metrics = {
  hits: 0,
  misses: 0,
  evictions: 0,
  totalLatencyMs: 0,
  totalRequests: 0,
};

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export function configureEmbeddingCache(cfg: Partial<EmbeddingCacheConfig>): void {
  config = { ...DEFAULT_CONFIG, ...cfg };
  log.info("Embedding cache configured", {
    maxEntries: config.maxEntries,
    ttlMs: config.ttlMs,
  });
}

// ---------------------------------------------------------------------------
// Cache Key Generation
// ---------------------------------------------------------------------------

export function generateEmbeddingCacheKey(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}

// ---------------------------------------------------------------------------
// Core Cache Operations
// ---------------------------------------------------------------------------

function isExpired(entry: EmbeddingCacheEntry): boolean {
  return Date.now() - entry.cachedAt > config.ttlMs;
}

function moveToFront(key: string): void {
  const idx = accessOrder.indexOf(key);
  if (idx >= 0) {
    accessOrder.splice(idx, 1);
  }
  accessOrder.unshift(key);
}

function evictLeastRecentlyUsed(): void {
  while (accessOrder.length > config.maxEntries) {
    const evictKey = accessOrder.pop();
    if (evictKey) {
      cache.delete(evictKey);
      metrics.evictions++;
    }
  }
}

function evictExpired(): number {
  let evicted = 0;
  const now = Date.now();
  for (const [key, entry] of cache.entries()) {
    if (now - entry.cachedAt > config.ttlMs) {
      cache.delete(key);
      const idx = accessOrder.indexOf(key);
      if (idx >= 0) accessOrder.splice(idx, 1);
      evicted++;
    }
  }
  if (evicted > 0) {
    metrics.evictions += evicted;
  }
  return evicted;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function getCachedEmbedding(productTextHash: string): number[] | null {
  const startTime = performance.now();

  const entry = cache.get(productTextHash);

  metrics.totalRequests++;
  metrics.totalLatencyMs += performance.now() - startTime;

  if (!entry) {
    metrics.misses++;
    return null;
  }

  if (isExpired(entry)) {
    cache.delete(productTextHash);
    const idx = accessOrder.indexOf(productTextHash);
    if (idx >= 0) accessOrder.splice(idx, 1);
    metrics.misses++;
    return null;
  }

  moveToFront(productTextHash);
  metrics.hits++;

  log.debug("Embedding cache hit", { productTextHash });
  return entry.vector;
}

export function setCachedEmbedding(productTextHash: string, vector: number[]): void {
  const now = Date.now();
  const entry: EmbeddingCacheEntry = {
    productTextHash,
    vector,
    cachedAt: now,
  };

  cache.set(productTextHash, entry);
  moveToFront(productTextHash);
  evictLeastRecentlyUsed();

  log.debug("Embedding cached", { productTextHash, vectorLength: vector.length });
}

export function getEmbeddingCacheMetrics(): EmbeddingCacheMetrics {
  const total = metrics.hits + metrics.misses;
  return {
    hits: metrics.hits,
    misses: metrics.misses,
    hitRate: total > 0 ? Number(((metrics.hits / total) * 100).toFixed(2)) : 0,
    cacheSize: cache.size,
    evictions: metrics.evictions,
    avgLatencyMs: metrics.totalRequests > 0
      ? Number((metrics.totalLatencyMs / metrics.totalRequests).toFixed(2))
      : 0,
  };
}

export function clearEmbeddingCache(): void {
  cache.clear();
  accessOrder.length = 0;
  metrics = {
    hits: 0,
    misses: 0,
    evictions: 0,
    totalLatencyMs: 0,
    totalRequests: 0,
  };
  log.info("Embedding cache cleared");
}

export function invalidateEmbeddingCache(pattern?: RegExp): number {
  let invalidated = 0;
  if (!pattern) {
    invalidated = cache.size;
    clearEmbeddingCache();
    return invalidated;
  }

  for (const [key, entry] of cache.entries()) {
    if (pattern.test(entry.productTextHash)) {
      cache.delete(key);
      const idx = accessOrder.indexOf(key);
      if (idx >= 0) accessOrder.splice(idx, 1);
      invalidated++;
    }
  }
  metrics.evictions += invalidated;
  log.info("Embedding cache invalidated", { count: invalidated });
  return invalidated;
}

// ---------------------------------------------------------------------------
// Periodic Cleanup
// ---------------------------------------------------------------------------

let cleanupInterval: ReturnType<typeof setInterval> | null = null;

export function startPeriodicCleanup(intervalMs: number = 60 * 60 * 1000): void {
  if (cleanupInterval) return;
  cleanupInterval = setInterval(() => {
    evictExpired();
  }, intervalMs);
  log.debug("Embedding cache periodic cleanup started", { intervalMs });
}

export function stopPeriodicCleanup(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
    log.debug("Embedding cache periodic cleanup stopped");
  }
}