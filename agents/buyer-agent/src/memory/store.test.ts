/**
 * User Memory Store tests — Issue #266
 */
import { describe, it, expect, vi } from "vitest";
import {
  UserMemoryStore,
  formatMemoriesForSystemPrompt,
} from "./store.js";
import type { UserMemoryItem } from "./types.js";

// ── helpers ───────────────────────────────────────────────────────────────────

function makeRow(overrides: Partial<{
  id: string;
  user_id: string;
  category: string;
  key: string;
  value: string;
  confidence: number;
}> = {}) {
  return {
    id: overrides.id ?? "m1",
    user_id: overrides.user_id ?? "u1",
    category: overrides.category ?? "preference",
    key: overrides.key ?? "clothing_size",
    value: overrides.value ?? "Medium",
    confidence: overrides.confidence ?? 1.0,
  };
}

function makeDb(rows: ReturnType<typeof makeRow>[] = [makeRow()]) {
  return {
    query: vi.fn().mockResolvedValue({ rowCount: rows.length, rows }),
  };
}

// ── upsertMemory ──────────────────────────────────────────────────────────────

describe("UserMemoryStore.upsertMemory", () => {
  it("returns the upserted memory item", async () => {
    const db = makeDb();
    const store = new UserMemoryStore(db as any);

    const result = await store.upsertMemory({
      userId: "u1",
      category: "preference",
      key: "clothing_size",
      value: "Medium",
    });

    expect(result.key).toBe("clothing_size");
    expect(result.userId).toBe("u1");
    expect(result.confidence).toBe(1.0);
  });

  it("clamps confidence to [0, 1]", async () => {
    const db = makeDb([makeRow({ confidence: 1.0 })]);
    const store = new UserMemoryStore(db as any);

    await store.upsertMemory({
      userId: "u1",
      category: "preference",
      key: "clothing_size",
      value: "M",
      confidence: 99,
    });

    const call = (db.query as any).mock.calls[0];
    // Confidence param should be clamped to 1.0
    expect(call[1]).toContain(1.0);
  });

  it("uses NULL for embedding when not provided", async () => {
    const db = makeDb();
    const store = new UserMemoryStore(db as any);

    await store.upsertMemory({
      userId: "u1",
      category: "preference",
      key: "brand",
      value: "Nike",
    });

    const sql: string = (db.query as any).mock.calls[0][0];
    expect(sql).toContain("NULL");
  });
});

// ── getRelevantMemories — keyword fallback ─────────────────────────────────────

describe("UserMemoryStore.getRelevantMemories (keyword fallback)", () => {
  it("returns up to 5 memories by default", async () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      makeRow({ id: `m${i}`, key: `key_${i}` })
    );
    const db = makeDb(rows);
    const store = new UserMemoryStore(db as any); // no embedder

    const results = await store.getRelevantMemories("u1", "clothing preference");
    expect(results).toHaveLength(5);
  });

  it("respects the limit option", async () => {
    const db = makeDb([makeRow()]);
    const store = new UserMemoryStore(db as any);

    await store.getRelevantMemories("u1", "diet", { limit: 3 });

    const sql: string = (db.query as any).mock.calls[0][0];
    expect(sql).toContain("LIMIT");
  });

  it("filters by category when provided", async () => {
    const db = makeDb([makeRow({ category: "constraint" })]);
    const store = new UserMemoryStore(db as any);

    await store.getRelevantMemories("u1", "diet", { category: "constraint" });

    const params: unknown[] = (db.query as any).mock.calls[0][1];
    expect(params).toContain("constraint");
  });
});

// ── getRelevantMemories — vector search ───────────────────────────────────────

describe("UserMemoryStore.getRelevantMemories (vector search)", () => {
  it("calls embedText and uses <=> operator when embedder is configured", async () => {
    const embedding = new Array(1536).fill(0.1);
    const embedText = vi.fn().mockResolvedValue(embedding);
    const db = makeDb([makeRow()]);
    const store = new UserMemoryStore(db as any, embedText);

    await store.getRelevantMemories("u1", "shoe size");

    expect(embedText).toHaveBeenCalledWith("shoe size");
    const sql: string = (db.query as any).mock.calls[0][0];
    expect(sql).toContain("<=>");
  });

  it("falls back to keyword search when embedder throws", async () => {
    const embedText = vi.fn().mockRejectedValue(new Error("embedding unavailable"));
    const db = makeDb([makeRow()]);
    const store = new UserMemoryStore(db as any, embedText);

    // Should not throw — gracefully falls back
    const results = await store.getRelevantMemories("u1", "shoe size");
    expect(Array.isArray(results)).toBe(true);
  });
});

// ── formatMemoriesForSystemPrompt ─────────────────────────────────────────────

describe("formatMemoriesForSystemPrompt", () => {
  it("returns empty string for empty array", () => {
    expect(formatMemoriesForSystemPrompt([])).toBe("");
  });

  it("includes all memories in the output", () => {
    const memories: UserMemoryItem[] = [
      { id: "m1", userId: "u1", category: "preference", key: "size", value: "M", confidence: 0.9 },
      { id: "m2", userId: "u1", category: "constraint", key: "dietary", value: "vegetarian", confidence: 1.0 },
    ];
    const prompt = formatMemoriesForSystemPrompt(memories);
    expect(prompt).toContain("preference / size: M");
    expect(prompt).toContain("constraint / dietary: vegetarian");
    expect(prompt).toContain("User preferences and constraints:");
  });
});
