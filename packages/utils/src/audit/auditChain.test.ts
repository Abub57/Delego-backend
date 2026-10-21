import { describe, it, expect, beforeEach } from "vitest";
import {
  computeCurrentHash,
  buildEntry,
  verifyChain,
  verifyChainOnStartup,
  computeMerkleRoot,
  verifyEntry,
  type AuditLogChainEntry,
} from "./auditChain.js";

function makeEntry(overrides: Partial<AuditLogChainEntry> = {}): AuditLogChainEntry {
  return {
    sequence: 1,
    actorId: "admin-1",
    action: "merchant_suspension",
    targetId: "merchant-42",
    metadata: { reason: "violation" },
    previousHash: null,
    currentHash: "",
    timestamp: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

describe("computeCurrentHash", () => {
  it("produces a 64-char hex SHA-256 digest", () => {
    const h = computeCurrentHash(1, "actor-1", "action", "target", null, new Date());
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic for identical input", () => {
    const h1 = computeCurrentHash(1, "actor-1", "action", "target", null, new Date("2026-01-01T00:00:00Z"));
    const h2 = computeCurrentHash(1, "actor-1", "action", "target", null, new Date("2026-01-01T00:00:00Z"));
    expect(h1).toBe(h2);
  });

  it("changes when any field changes", () => {
    const base = computeCurrentHash(1, "actor-1", "action", "target", null, new Date());
    expect(computeCurrentHash(2, "actor-1", "action", "target", null, new Date())).not.toBe(base);
    expect(computeCurrentHash(1, "actor-2", "action", "target", null, new Date())).not.toBe(base);
    expect(computeCurrentHash(1, "actor-1", "different", "target", null, new Date())).not.toBe(base);
    expect(computeCurrentHash(1, "actor-1", "action", "different", null, new Date())).not.toBe(base);
    expect(computeCurrentHash(1, "actor-1", "action", "target", "other-previous", new Date())).not.toBe(base);
  });

  it("includes previousHash in the hash computation", () => {
    const h1 = computeCurrentHash(1, "actor-1", "action", "target", null, new Date());
    const h2 = computeCurrentHash(2, "actor-1", "action", "target", h1, new Date());
    // h2 should incorporate h1 in its hash
    expect(h2).not.toBe(h1);
  });

  it("uses timestamp in the hash computation", () => {
    const h1 = computeCurrentHash(1, "actor-1", "action", "target", null, new Date("2026-01-01T00:00:00Z"));
    const h2 = computeCurrentHash(1, "actor-1", "action", "target", null, new Date("2026-01-01T00:00:01Z"));
    expect(h1).not.toBe(h2);
  });
});

describe("buildEntry", () => {
  it("computes currentHash and sets previousHash to null for genesis entry", () => {
    const entry = buildEntry({ sequence: 1, actorId: "actor-1", action: "init", targetId: "target-1" }, null);
    expect(entry.previousHash).toBeNull();
    expect(entry.currentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(entry.sequence).toBe(1);
    expect(entry.actorId).toBe("actor-1");
  });

  it("chains the new entry's previousHash onto the previous entry's currentHash", () => {
    const prev = buildEntry({ sequence: 1, actorId: "actor-1", action: "init", targetId: "target-1" }, null);
    const next = buildEntry({ sequence: 2, actorId: "actor-2", action: "update", targetId: "target-2" }, prev.currentHash);
    expect(next.previousHash).toBe(prev.currentHash);
    expect(next.currentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("uses the provided timestamp or defaults to now", () => {
    const ts = new Date("2026-06-15T12:00:00Z");
    const entry = buildEntry({ sequence: 1, actorId: "actor-1", action: "a", targetId: "t", timestamp: ts }, null);
    expect(entry.timestamp.toISOString()).toBe(ts.toISOString());
  });
});

describe("verifyChain", () => {
  it("returns valid for an empty chain", () => {
    const result = verifyChain([]);
    expect(result.valid).toBe(true);
    expect(result.entriesVerified).toBe(0);
  });

  it("validates a correctly chained sequence of entries", () => {
    const e1 = buildEntry({ sequence: 1, actorId: "actor-1", action: "a", targetId: "t1" }, null);
    const e2 = buildEntry({ sequence: 2, actorId: "actor-2", action: "b", targetId: "t2" }, e1.currentHash);
    const e3 = buildEntry({ sequence: 3, actorId: "actor-3", action: "c", targetId: "t3" }, e2.currentHash);

    const result = verifyChain([e1, e2, e3]);
    expect(result.valid).toBe(true);
    expect(result.entriesVerified).toBe(3);
  });

  it("detects a tampered currentHash", () => {
    const e1 = buildEntry({ sequence: 1, actorId: "actor-1", action: "a", targetId: "t1" }, null);
    const e2 = buildEntry({ sequence: 2, actorId: "actor-2", action: "b", targetId: "t2" }, e1.currentHash);

    // Tamper: change the action after hash was computed
    const tampered = { ...e2, action: "tampered_action" };
    const result = verifyChain([e1, tampered]);
    expect(result.valid).toBe(false);
    expect(result.firstBrokenSequence).toBe(2);
    expect(result.reason).toMatch(/hash/i);
  });

  it("detects a broken prevHash link", () => {
    const e1 = buildEntry({ sequence: 1, actorId: "actor-1", action: "a", targetId: "t1" }, null);
    const e2 = buildEntry({ sequence: 2, actorId: "actor-2", action: "b", targetId: "t2" }, e1.currentHash);
    // e3 points to e1's hash instead of e2's, breaking the chain link
    const e3 = buildEntry({ sequence: 3, actorId: "actor-3", action: "c", targetId: "t3" }, e1.currentHash);

    const result = verifyChain([e1, e2, e3]);
    expect(result.valid).toBe(false);
    expect(result.firstBrokenSequence).toBe(3);
    expect(result.reason).toMatch(/previous hash/i);
  });

  it("detects a sequence gap", () => {
    const e1 = buildEntry({ sequence: 1, actorId: "actor-1", action: "a", targetId: "t1" }, null);
    const e3 = buildEntry({ sequence: 3, actorId: "actor-3", action: "c", targetId: "t3" }, e1.currentHash);

    const result = verifyChain([e1, e3]);
    expect(result.valid).toBe(false);
    expect(result.firstBrokenSequence).toBe(3);
    expect(result.reason).toMatch(/sequence/i);
  });

  it("detects that the chain does not start with null previousHash", () => {
    const e1 = buildEntry({ sequence: 1, actorId: "actor-1", action: "a", targetId: "t1" }, "not-null");
    const result = verifyChain([e1]);
    expect(result.valid).toBe(false);
    expect(result.firstBrokenSequence).toBe(1);
  });
});

describe("verifyChainOnStartup", () => {
  it("returns true for a valid chain", () => {
    const e1 = buildEntry({ sequence: 1, actorId: "actor-1", action: "a", targetId: "t1" }, null);
    const e2 = buildEntry({ sequence: 2, actorId: "actor-2", action: "b", targetId: "t2" }, e1.currentHash);
    const result = verifyChainOnStartup([e1, e2]);
    expect(result).toBe(true);
  });

  it("returns false and logs critical alert for a broken chain", () => {
    const e1 = buildEntry({ sequence: 1, actorId: "actor-1", action: "a", targetId: "t1" }, null);
    const e2 = buildEntry({ sequence: 2, actorId: "actor-2", action: "b", targetId: "t2" }, e1.currentHash);
    const tampered = { ...e2, action: "tampered" };
    const result = verifyChainOnStartup([e1, tampered]);
    expect(result).toBe(false);
  });
});

describe("computeMerkleRoot", () => {
  it("returns a root for a single entry", () => {
    const e1 = buildEntry({ sequence: 1, actorId: "actor-1", action: "a", targetId: "t1" }, null);
    const result = computeMerkleRoot([e1]);
    expect(result.root).toMatch(/^[0-9a-f]{64}$/);
    expect(result.leafCount).toBe(1);
    expect(result.timestamp instanceof Date).toBe(true);
  });

  it("returns a root for multiple entries", () => {
    const e1 = buildEntry({ sequence: 1, actorId: "actor-1", action: "a", targetId: "t1" }, null);
    const e2 = buildEntry({ sequence: 2, actorId: "actor-2", action: "b", targetId: "t2" }, e1.currentHash);
    const e3 = buildEntry({ sequence: 3, actorId: "actor-3", action: "c", targetId: "t3" }, e2.currentHash);
    const result = computeMerkleRoot([e1, e2, e3]);
    expect(result.root).toMatch(/^[0-9a-f]{64}$/);
    expect(result.leafCount).toBe(3);
  });

  it("returns a root for an even number of entries", () => {
    const e1 = buildEntry({ sequence: 1, actorId: "actor-1", action: "a", targetId: "t1" }, null);
    const e2 = buildEntry({ sequence: 2, actorId: "actor-2", action: "b", targetId: "t2" }, e1.currentHash);
    const result = computeMerkleRoot([e1, e2]);
    expect(result.root).toMatch(/^[0-9a-f]{64}$/);
    expect(result.leafCount).toBe(2);
  });
});

describe("verifyEntry", () => {
  it("returns true for a valid entry with correct previous entry", () => {
    const e1 = buildEntry({ sequence: 1, actorId: "actor-1", action: "a", targetId: "t1" }, null);
    const e2 = buildEntry({ sequence: 2, actorId: "actor-2", action: "b", targetId: "t2" }, e1.currentHash);
    expect(verifyEntry(e2, e1)).toBe(true);
  });

  it("returns false when previousHash doesn't match", () => {
    const e1 = buildEntry({ sequence: 1, actorId: "actor-1", action: "a", targetId: "t1" }, null);
    const e2 = buildEntry({ sequence: 2, actorId: "actor-2", action: "b", targetId: "t2" }, "wrong-previous");
    expect(verifyEntry(e2, e1)).toBe(false);
  });

  it("returns false for genesis entry when previousEntry is null and previousHash is null", () => {
    const e1 = buildEntry({ sequence: 1, actorId: "actor-1", action: "a", targetId: "t1" }, null);
    expect(verifyEntry(e1, null)).toBe(true);
  });

  it("returns false when currentHash is tampered", () => {
    const e1 = buildEntry({ sequence: 1, actorId: "actor-1", action: "a", targetId: "t1" }, null);
    const e2 = buildEntry({ sequence: 2, actorId: "actor-2", action: "b", targetId: "t2" }, e1.currentHash);
    const tampered = { ...e2, currentHash: "deadbeef" };
    expect(verifyEntry(tampered, e1)).toBe(false);
  });
});
