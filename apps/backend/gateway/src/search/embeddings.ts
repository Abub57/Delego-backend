import { fetchWithCorrelation } from "../../middleware/correlation.js";
import {
  getCachedEmbedding,
  setCachedEmbedding,
  generateEmbeddingCacheKey,
  configureEmbeddingCache,
  getEmbeddingCacheMetrics,
  clearEmbeddingCache,
  startPeriodicCleanup,
} from "./embeddingCache.js";

/**
 * Text embedding helper for semantic product search.
 * Issue #263: embed a user query into a float vector using the configured
 * embedding model (OpenAI text-embedding-3-small by default).
 *
 * The implementation uses the OpenAI Embeddings REST API directly so the
 * gateway does not need to depend on the full openai npm SDK.
 *
 * Issue #389: Added in-memory LRU cache for embeddings to reduce API costs
 * and latency for repeated queries.
 */

const EMBED_API_URL = "https://api.openai.com/v1/embeddings";
const DEFAULT_EMBED_MODEL = "text-embedding-3-small";
const EMBED_DIMENSIONS = 1536;

interface EmbedResponse {
  data: Array<{ embedding: number[] }>;
}

configureEmbeddingCache({
  maxEntries: Number(process.env["EMBEDDING_CACHE_MAX_ENTRIES"] ?? 10000),
  ttlMs: Number(process.env["EMBEDDING_CACHE_TTL_MS"] ?? 24 * 60 * 60 * 1000),
});

if (process.env["EMBEDDING_CACHE_CLEANUP_INTERVAL_MS"]) {
  startPeriodicCleanup(Number(process.env["EMBEDDING_CACHE_CLEANUP_INTERVAL_MS"]));
}

/**
 * Embed a text string and return a float array suitable for pgvector queries.
 * Throws if the API key is not set or the upstream call fails.
 * Uses LRU cache to avoid redundant API calls for identical text.
 */
export async function embedText(text: string): Promise<number[]> {
  const cacheKey = generateEmbeddingCacheKey(text);

  const cached = getCachedEmbedding(cacheKey);
  if (cached) {
    return cached;
  }

  const apiKey = process.env["OPENAI_API_KEY"];
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set — cannot embed query");
  }

  const model = process.env["EMBED_MODEL"] ?? DEFAULT_EMBED_MODEL;

  const res = await fetchWithCorrelation(EMBED_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ input: text, model }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => res.statusText);
    throw new Error(`Embedding API error ${res.status}: ${body}`);
  }

  const data = (await res.json()) as EmbedResponse;
  const embedding = data.data[0]?.embedding;
  if (!embedding || embedding.length !== EMBED_DIMENSIONS) {
    throw new Error(
      `Unexpected embedding dimensions: expected ${EMBED_DIMENSIONS}, got ${embedding?.length ?? 0}`
    );
  }

  setCachedEmbedding(cacheKey, embedding);
  return embedding;
}

export { getEmbeddingCacheMetrics, clearEmbeddingCache, configureEmbeddingCache };
export type { EmbeddingCacheConfig, EmbeddingCacheMetrics } from "./embeddingCache.js";
