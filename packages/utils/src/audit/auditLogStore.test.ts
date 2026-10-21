import { describe, it, expect, beforeEach } from "vitest";
import { AuditLogError, recordAuditEntry, queryAuditLog, getChainSegment } from "./auditLogStore.js";
import { verifyChain } from "./hashChain.js";
import { verifyStoredChain, formatChainVerificationReport } from "./verifyStoredChain.js";
import type { Queryable } from "./types.js";

/**
 * A minimal in-memory Postgres-compatible fake for the audit_log table:
 * interprets just enough SQL to exercise real INSERT/SELECT behavior
 * end-to-end without a live database, mirroring
 * ../softDelete/softDeleteTable.test.ts's FakeDb for the same reason.
 */
class FakeAuditDb implements Queryable {
  rows: Record<string, unknown>[] = [];
  private idCounter = 0;
  private sequenceCounter = 0;

  private nextId(): string {
    this.idCounter += 1;
    return `audit-${this.idCounter}`;
  }

  /** Mirrors the DB's BIGSERIAL: strictly increasing regardless of wall-clock time, which is the whole point of using it over occurred_at for chain order. */
  private nextSequenceNum(): number {
    this.sequenceCounter += 1;
    return this.sequenceCounter;
  }

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values: unknown[] = []
  ): Promise<{ rows: Row[]; rowCount: number | null }> {
    const sql = text.replace(/\s+/g, " ").trim();

    if (sql.startsWith("INSERT INTO audit_log")) {
      const [
        tableName,
        recordId,
        operation,
        userId,
        sessionId,
        ipAddress,
        userAgent,
        oldValues,
        newValues,
        changedFields,
        occurredAt,
        transactionId,
        prevHash,
        entryHash,
      ] = values;

      const row = {
        id: this.nextId(),
        sequence_num: this.nextSequenceNum(),
        table_name: tableName,
        record_id: recordId,
        operation,
        user_id: userId,
        session_id: sessionId,
        ip_address: ipAddress,
        user_agent: userAgent,
        old_values: oldValues,
        new_values: newValues,
        changed_fields: changedFields,
        occurred_at: occurredAt,
        transaction_id: transactionId,
        prev_hash: prevHash,
        entry_hash: entryHash,
      };
      this.rows.push(row);
      return { rows: [row as unknown as Row], rowCount: 1 };
    }

    if (sql.startsWith("SELECT entry_hash FROM audit_log ORDER BY")) {
      if (this.rows.length === 0) return { rows: [], rowCount: 0 };
      const sorted = [...this.rows].sort(
        (a, b) => (b.sequence_num as number) - (a.sequence_num as number)
      );
      return { rows: [sorted[0] as unknown as Row], rowCount: 1 };
    }

    if (sql.startsWith("SELECT sequence_num FROM audit_log WHERE id")) {
      const [id] = values as [string];
      const row = this.rows.find((r) => r.id === id);
      return row ? { rows: [row as unknown as Row], rowCount: 1 } : { rows: [], rowCount: 0 };
    }

    if (sql.startsWith("SELECT * FROM audit_log")) {
      // Extremely small filter interpreter: only supports the exact
      // fragments this module generates, in the order it generates them.
      let filtered = [...this.rows];
      let valueIdx = 0;

      const consumeEq = (column: string) => {
        if (sql.includes(`${column} = $`)) {
          const v = values[valueIdx++];
          filtered = filtered.filter((r) => r[column] === v);
        }
      };
      consumeEq("table_name");
      consumeEq("record_id");
      consumeEq("operation");
      consumeEq("user_id");

      if (sql.includes("occurred_at >= $")) {
        const v = values[valueIdx++] as Date;
        filtered = filtered.filter((r) => (r.occurred_at as Date).getTime() >= v.getTime());
      }
      if (sql.includes("occurred_at <= $")) {
        const v = values[valueIdx++] as Date;
        filtered = filtered.filter((r) => (r.occurred_at as Date).getTime() <= v.getTime());
      }

      if (sql.includes("sequence_num >")) {
        const v = values[valueIdx++] as number;
        filtered = filtered.filter((r) => (r.sequence_num as number) > v);
      }
      if (sql.includes("sequence_num <")) {
        const v = values[valueIdx++] as number;
        filtered = filtered.filter((r) => (r.sequence_num as number) < v);
      }

      const descending = sql.includes("sequence_num DESC");
      filtered.sort((a, b) => {
        const diff = (a.sequence_num as number) - (b.sequence_num as number);
        return descending ? -diff : diff;
      });

      const limit = values[values.length - 1] as number;
      const limited = filtered.slice(0, limit);
      return { rows: limited as unknown as Row[], rowCount: limited.length };
    }

    throw new Error(`FakeAuditDb: unhandled query: ${sql}`);
  }
}

describe("recordAuditEntry", () => {
  let db: FakeAuditDb;

  beforeEach(() => {
    db = new FakeAuditDb();
  });

  it("records an entry with prevHash null when the log is empty", async () => {
    const entry = await recordAuditEntry(db, {
      tableName: "users",
      recordId: "u1",
      operation: "INSERT",
      transactionId: "tx-1",
      newValues: { name: "Alice" },
    });

    expect(entry.prevHash).toBeNull();
    expect(entry.entryHash).toMatch(/^[0-9a-f]{64}$/);
    expect(entry.tableName).toBe("users");
  });

  it("chains the second entry's prevHash onto the first entry's entryHash", async () => {
    const first = await recordAuditEntry(db, {
      tableName: "users",
      recordId: "u1",
      operation: "INSERT",
      transactionId: "tx-1",
      newValues: { name: "Alice" },
    });

    const second = await recordAuditEntry(db, {
      tableName: "users",
      recordId: "u1",
      operation: "UPDATE",
      transactionId: "tx-2",
      oldValues: { name: "Alice" },
      newValues: { name: "Alicia" },
    });

    expect(second.prevHash).toBe(first.entryHash);
  });

  it("derives changedFields from old/new values when not supplied explicitly", async () => {
    const entry = await recordAuditEntry(db, {
      tableName: "users",
      recordId: "u1",
      operation: "UPDATE",
      transactionId: "tx-1",
      oldValues: { name: "Alice", email: "a@example.com" },
      newValues: { name: "Alicia", email: "a@example.com" },
    });

    expect(entry.changedFields).toEqual(["name"]);
  });

  it("uses explicitly supplied changedFields over derived ones", async () => {
    const entry = await recordAuditEntry(db, {
      tableName: "users",
      recordId: "u1",
      operation: "UPDATE",
      transactionId: "tx-1",
      oldValues: { name: "Alice" },
      newValues: { name: "Alicia" },
      changedFields: ["name", "some_computed_field"],
    });

    expect(entry.changedFields).toEqual(["name", "some_computed_field"]);
  });

  it("rejects an entry with an empty tableName", async () => {
    await expect(
      recordAuditEntry(db, { tableName: "", recordId: "u1", operation: "INSERT", transactionId: "tx-1" })
    ).rejects.toThrow(AuditLogError);
  });

  it("rejects an entry with an empty recordId", async () => {
    await expect(
      recordAuditEntry(db, { tableName: "users", recordId: "", operation: "INSERT", transactionId: "tx-1" })
    ).rejects.toThrow(AuditLogError);
  });

  it("rejects an entry with an empty transactionId", async () => {
    await expect(
      recordAuditEntry(db, { tableName: "users", recordId: "u1", operation: "INSERT", transactionId: "" })
    ).rejects.toThrow(AuditLogError);
  });

  it("produces a chain of entries that passes verifyChain end-to-end", async () => {
    await recordAuditEntry(db, {
      tableName: "users",
      recordId: "u1",
      operation: "INSERT",
      transactionId: "tx-1",
      newValues: { name: "Alice" },
    });
    await recordAuditEntry(db, {
      tableName: "users",
      recordId: "u1",
      operation: "UPDATE",
      transactionId: "tx-2",
      oldValues: { name: "Alice" },
      newValues: { name: "Alicia" },
    });
    await recordAuditEntry(db, {
      tableName: "orders",
      recordId: "o1",
      operation: "DELETE",
      transactionId: "tx-3",
      oldValues: { status: "pending" },
    });

    const chain = await getChainSegment(db);
    const result = verifyChain(chain);
    expect(result.valid).toBe(true);
    expect(result.entriesChecked).toBe(3);
  });
});

describe("queryAuditLog", () => {
  let db: FakeAuditDb;

  beforeEach(async () => {
    db = new FakeAuditDb();
    await recordAuditEntry(db, {
      tableName: "users",
      recordId: "u1",
      operation: "INSERT",
      userId: "admin-1",
      transactionId: "tx-1",
      newValues: { name: "Alice" },
    });
    await recordAuditEntry(db, {
      tableName: "users",
      recordId: "u1",
      operation: "UPDATE",
      userId: "admin-2",
      transactionId: "tx-2",
      oldValues: { name: "Alice" },
      newValues: { name: "Alicia" },
    });
    await recordAuditEntry(db, {
      tableName: "orders",
      recordId: "o1",
      operation: "INSERT",
      userId: "admin-1",
      transactionId: "tx-3",
      newValues: { status: "pending" },
    });
  });

  it("returns all entries with no filters, newest first by default", async () => {
    const result = await queryAuditLog(db, {});
    expect(result.entries).toHaveLength(3);
    expect(result.entries[0].transactionId).toBe("tx-3");
    expect(result.entries[2].transactionId).toBe("tx-1");
  });

  it("filters by tableName", async () => {
    const result = await queryAuditLog(db, { tableName: "orders" });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].recordId).toBe("o1");
  });

  it("filters by recordId", async () => {
    const result = await queryAuditLog(db, { recordId: "u1" });
    expect(result.entries).toHaveLength(2);
  });

  it("filters by operation", async () => {
    const result = await queryAuditLog(db, { operation: "UPDATE" });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].transactionId).toBe("tx-2");
  });

  it("filters by userId", async () => {
    const result = await queryAuditLog(db, { userId: "admin-2" });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].userId).toBe("admin-2");
  });

  it("combines multiple filters", async () => {
    const result = await queryAuditLog(db, { tableName: "users", userId: "admin-1" });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].transactionId).toBe("tx-1");
  });

  it("respects limit and returns a nextCursor when more results exist", async () => {
    const result = await queryAuditLog(db, { limit: 2 });
    expect(result.entries).toHaveLength(2);
    expect(result.nextCursor).not.toBeNull();
  });

  it("returns null nextCursor when all results fit within limit", async () => {
    const result = await queryAuditLog(db, { limit: 10 });
    expect(result.entries).toHaveLength(3);
    expect(result.nextCursor).toBeNull();
  });

  it("paginates forward using the cursor from the previous page", async () => {
    const page1 = await queryAuditLog(db, { limit: 2 });
    expect(page1.entries).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await queryAuditLog(db, { limit: 2, cursor: page1.nextCursor! });
    expect(page2.entries).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();

    const seenIds = new Set([...page1.entries, ...page2.entries].map((e) => e.id));
    expect(seenIds.size).toBe(3);
  });

  it("sorts ascending when sort: 'asc' is given", async () => {
    const result = await queryAuditLog(db, { sort: "asc" });
    expect(result.entries[0].transactionId).toBe("tx-1");
    expect(result.entries[2].transactionId).toBe("tx-3");
  });

  it("returns an empty result set when no entries match the filter", async () => {
    const result = await queryAuditLog(db, { tableName: "nonexistent_table" });
    expect(result.entries).toHaveLength(0);
    expect(result.nextCursor).toBeNull();
  });
});

describe("getChainSegment", () => {
  it("returns entries in oldest-first order regardless of insertion timing", async () => {
    const db = new FakeAuditDb();
    await recordAuditEntry(db, {
      tableName: "users",
      recordId: "u1",
      operation: "INSERT",
      transactionId: "tx-1",
    });
    await recordAuditEntry(db, {
      tableName: "users",
      recordId: "u2",
      operation: "INSERT",
      transactionId: "tx-2",
    });

    const segment = await getChainSegment(db);
    expect(segment[0].transactionId).toBe("tx-1");
    expect(segment[1].transactionId).toBe("tx-2");
  });
});

describe("verifyStoredChain", () => {
  async function seedChain(db: FakeAuditDb, count: number): Promise<void> {
    for (let i = 1; i <= count; i++) {
      await recordAuditEntry(db, {
        tableName: "users",
        recordId: `u${i}`,
        operation: "INSERT",
        transactionId: `tx-${i}`,
        newValues: { name: `user-${i}` },
      });
    }
  }

  it("reports a valid chain for an untampered log", async () => {
    const db = new FakeAuditDb();
    await seedChain(db, 3);

    const result = await verifyStoredChain(db);

    expect(result.valid).toBe(true);
    expect(result.entriesChecked).toBe(3);
    expect(result.firstBrokenEntryId).toBeNull();
    expect(result.pagesChecked).toBe(1);
    expect(result.lastSequenceNum).toBe(3);
  });

  it("reports an empty log as valid without checking anything", async () => {
    const db = new FakeAuditDb();

    const result = await verifyStoredChain(db);

    expect(result.valid).toBe(true);
    expect(result.entriesChecked).toBe(0);
    expect(result.lastSequenceNum).toBeNull();
  });

  it("detects a row whose payload was modified out-of-band", async () => {
    const db = new FakeAuditDb();
    await seedChain(db, 3);

    // Simulate someone with direct DB access altering a historical row:
    // the stored payload changes but its entry_hash stays as recorded.
    db.rows[0].new_values = { name: "MALLORY" };

    const result = await verifyStoredChain(db);

    expect(result.valid).toBe(false);
    expect(result.entriesChecked).toBe(0);
    expect(result.firstBrokenEntryId).toBe("audit-1");
    expect(result.reason).toMatch(/entryHash mismatch/);
  });

  it("detects a row whose stored entry_hash was modified out-of-band", async () => {
    const db = new FakeAuditDb();
    await seedChain(db, 3);

    db.rows[1].entry_hash = "0".repeat(64);

    const result = await verifyStoredChain(db);

    expect(result.valid).toBe(false);
    expect(result.entriesChecked).toBe(1);
    expect(result.firstBrokenEntryId).toBe("audit-2");
  });

  it("detects a deleted row via a broken prevHash link", async () => {
    const db = new FakeAuditDb();
    await seedChain(db, 3);

    db.rows.splice(1, 1); // remove audit-2

    const result = await verifyStoredChain(db);

    expect(result.valid).toBe(false);
    expect(result.firstBrokenEntryId).toBe("audit-3");
    expect(result.reason).toMatch(/prevHash mismatch/);
  });

  it("walks the whole chain across pages instead of stopping at the page size", async () => {
    const db = new FakeAuditDb();
    await seedChain(db, 5);

    const result = await verifyStoredChain(db, { pageSize: 2 });

    expect(result.valid).toBe(true);
    expect(result.entriesChecked).toBe(5);
    expect(result.pagesChecked).toBe(3);
    expect(result.lastSequenceNum).toBe(5);
  });

  it("detects tampering that falls on a later page", async () => {
    const db = new FakeAuditDb();
    await seedChain(db, 5);

    db.rows[3].new_values = { name: "MALLORY" }; // audit-4, on the second page

    const result = await verifyStoredChain(db, { pageSize: 2 });

    expect(result.valid).toBe(false);
    expect(result.firstBrokenEntryId).toBe("audit-4");
    expect(result.entriesChecked).toBe(3);
    expect(result.lastSequenceNum).toBe(3);
  });

  it("rejects a non-positive pageSize", async () => {
    const db = new FakeAuditDb();
    await expect(verifyStoredChain(db, { pageSize: 0 })).rejects.toThrow(RangeError);
  });
});

describe("formatChainVerificationReport", () => {
  it("summarizes an intact chain", () => {
    const report = formatChainVerificationReport({
      valid: true,
      entriesChecked: 3,
      firstBrokenEntryId: null,
      reason: null,
      pagesChecked: 1,
      lastSequenceNum: 3,
    });
    expect(report).toContain("OK");
    expect(report).toContain("3 entries");
  });

  it("includes the first broken entry and reason for a broken chain", () => {
    const report = formatChainVerificationReport({
      valid: false,
      entriesChecked: 2,
      firstBrokenEntryId: "audit-3",
      reason: "entryHash mismatch on entry audit-3",
      pagesChecked: 1,
      lastSequenceNum: 2,
    });
    expect(report).toContain("BROKEN");
    expect(report).toContain("audit-3");
    expect(report).toContain("entryHash mismatch");
  });
});
