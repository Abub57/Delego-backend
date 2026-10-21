/**
 * User Memory Store — Issue #266
 *
 * Stores and retrieves long-term user preferences (sizes, dietary constraints,
 * preferred brands, saved addresses) in PostgreSQL with optional pgvector
 * similarity search.
 *
 * The `getRelevantMemories` method supports two modes:
 *   - Vector search: when an `embedText` function is supplied and the table
 *     has an `embedding` column populated, it performs a cosine-similarity
 *     KNN query.
 *   - Keyword fallback: when no embedder is provided or the embedding is null
 *     it falls back to a LIKE-based full-text search so the feature degrades
 *     gracefully in environments without an embedding service.
 */
import type { Pool } from "pg";
import { createLogger } from "@delegolabs/utils";
import type {
  MemoryCategory,
  MemorySearchOptions,
  UpsertMemoryInput,
  UserMemoryItem,
} from "./types.js";

const log = createLogger(
  "buyer-agent:memory",
  process.env.LOG_LEVEL ?? "info"
);

const DEFAULT_LIMIT = 5;
const MAX_CONFIDENCE = 1.0;

/** Optional function that converts a text prompt into a 1 536-dim embedding vector. */
export type EmbedText = (text: string) => Promise<number[]>;

export class UserMemoryStore {
  constructor(
    private readonly db: Pool,
    private readonly embedText?: EmbedText
  ) {}

  /**
   * Insert or update a memory item.
   * Keyed on (user_id, category, key) — upsert via ON CONFLICT.
   */
  async upsertMemory(input: UpsertMemoryInput): Promise<UserMemoryItem> {
    const confidence = Math.min(
      MAX_CONFIDENCE,
      Math.max(0, input.confidence ?? 1.0)
    );

    const embeddingLiteral =
      input.embedding && input.embedding.length > 0
        ? `'[${input.embedding.join(",")}]'`
        : "NULL";

    const result = await this.db.query<{
      id: string;
      user_id: string;
      category: string;
      key: string;
      value: string;
      confidence: number;
    }>(
      `INSERT INTO user_agent_memories
         (user_id, category, key, value, embedding, confidence, created_at, updated_at)
       VALUES ($1, $2, $3, $4, ${embeddingLiteral}::vector, $5, NOW(), NOW())
       ON CONFLICT (user_id, category, key)
       DO UPDATE SET
         value      = EXCLUDED.value,
         embedding  = EXCLUDED.embedding,
         confidence = EXCLUDED.confidence,
         updated_at = NOW()
       RETURNING id, user_id, category, key, value, confidence`,
      [
        input.userId,
        input.category,
        input.key,
        input.value,
        confidence,
      ]
    );

    const row = result.rows[0];
    log.debug("Memory upserted", {
      id: row.id,
      userId: row.user_id,
      category: row.category,
      key: row.key,
    });

    return {
      id: row.id,
      userId: row.user_id,
      category: row.category as MemoryCategory,
      key: row.key,
      value: row.value,
      confidence: Number(row.confidence),
    };
  }

  /**
   * Retrieve the top-N memories most relevant to `promptText`.
   *
   * When an embedder is configured, uses `<=>` (pgvector cosine distance)
   * to rank results; otherwise falls back to an unranked LIKE query.
   *
   * These memories are intended to be injected into the LLM system prompt
   * before inference.
   */
  async getRelevantMemories(
    userId: string,
    promptText: string,
    options: MemorySearchOptions = {}
  ): Promise<UserMemoryItem[]> {
    const limit = options.limit ?? DEFAULT_LIMIT;

    if (this.embedText) {
      return this.vectorSearch(userId, promptText, limit, options.category);
    }
    return this.keywordSearch(userId, promptText, limit, options.category);
  }

  /**
   * Retrieve all memories for a user (useful for building the full
   * preference context at session start).
   */
  async getAllMemories(
    userId: string,
    category?: MemoryCategory
  ): Promise<UserMemoryItem[]> {
    const conditions = ["user_id = $1"];
    const params: unknown[] = [userId];

    if (category) {
      conditions.push(`category = $${params.length + 1}`);
      params.push(category);
    }

    const result = await this.db.query<{
      id: string;
      user_id: string;
      category: string;
      key: string;
      value: string;
      confidence: number;
    }>(
      `SELECT id, user_id, category, key, value, confidence
         FROM user_agent_memories
        WHERE ${conditions.join(" AND ")}
        ORDER BY confidence DESC, updated_at DESC`,
      params
    );

    return result.rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      category: row.category as MemoryCategory,
      key: row.key,
      value: row.value,
      confidence: Number(row.confidence),
    }));
  }

  /**
   * Delete a specific memory by id — enforces user ownership.
   */
  async deleteMemory(userId: string, memoryId: string): Promise<boolean> {
    const result = await this.db.query(
      `DELETE FROM user_agent_memories WHERE id = $1 AND user_id = $2`,
      [memoryId, userId]
    );
    return (result.rowCount ?? 0) > 0;
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private async vectorSearch(
    userId: string,
    promptText: string,
    limit: number,
    category?: MemoryCategory
  ): Promise<UserMemoryItem[]> {
    let embedding: number[];
    try {
      embedding = await this.embedText!(promptText);
    } catch (err) {
      log.warn("Embedding service unavailable; falling back to keyword search", {
        error: err instanceof Error ? err.message : String(err),
      });
      return this.keywordSearch(userId, promptText, limit, category);
    }

    const embeddingLiteral = `'[${embedding.join(",")}]'::vector`;
    const conditions = ["user_id = $1", "embedding IS NOT NULL"];
    const params: unknown[] = [userId];

    if (category) {
      conditions.push(`category = $${params.length + 1}`);
      params.push(category);
    }

    const result = await this.db.query<{
      id: string;
      user_id: string;
      category: string;
      key: string;
      value: string;
      confidence: number;
    }>(
      `SELECT id, user_id, category, key, value, confidence
         FROM user_agent_memories
        WHERE ${conditions.join(" AND ")}
        ORDER BY embedding <=> ${embeddingLiteral}
        LIMIT $${params.length + 1}`,
      [...params, limit]
    );

    return result.rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      category: row.category as MemoryCategory,
      key: row.key,
      value: row.value,
      confidence: Number(row.confidence),
    }));
  }

  private async keywordSearch(
    userId: string,
    promptText: string,
    limit: number,
    category?: MemoryCategory
  ): Promise<UserMemoryItem[]> {
    const keywords = promptText
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 2)
      .slice(0, 8); // keep top 8 tokens to avoid ridiculous LIKE chains

    const conditions = ["user_id = $1"];
    const params: unknown[] = [userId];

    if (keywords.length > 0) {
      const likeClauses = keywords.map((kw, _i) => {
        params.push(`%${kw}%`);
        return `(value ILIKE $${params.length} OR key ILIKE $${params.length})`;
      });
      conditions.push(`(${likeClauses.join(" OR ")})`);
    }

    if (category) {
      conditions.push(`category = $${params.length + 1}`);
      params.push(category);
    }

    const result = await this.db.query<{
      id: string;
      user_id: string;
      category: string;
      key: string;
      value: string;
      confidence: number;
    }>(
      `SELECT id, user_id, category, key, value, confidence
         FROM user_agent_memories
        WHERE ${conditions.join(" AND ")}
        ORDER BY confidence DESC, updated_at DESC
        LIMIT $${params.length + 1}`,
      [...params, limit]
    );

    return result.rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      category: row.category as MemoryCategory,
      key: row.key,
      value: row.value,
      confidence: Number(row.confidence),
    }));
  }
}

/**
 * Format a list of memories into a system-prompt snippet to inject
 * before LLM inference.
 *
 * Example output:
 *   User preferences and constraints:
 *   - preference / clothing_size: Medium (confidence: 0.9)
 *   - constraint / dietary: vegetarian (confidence: 1.0)
 */
export function formatMemoriesForSystemPrompt(
  memories: UserMemoryItem[]
): string {
  if (memories.length === 0) return "";

  const lines = memories.map(
    (m) =>
      `- ${m.category} / ${m.key}: ${m.value} (confidence: ${m.confidence.toFixed(1)})`
  );

  return `User preferences and constraints:\n${lines.join("\n")}`;
}
