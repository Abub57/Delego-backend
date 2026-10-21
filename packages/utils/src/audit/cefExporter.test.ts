import { afterEach, describe, expect, it, vi } from "vitest";
import * as tls from "node:tls";
import { configureAuditLogTransport, createCefSyslogTransport, formatCef } from "./cefExporter.js";
import { recordAuditEntry } from "./auditLogStore.js";
import type { AuditLogEntry } from "./types.js";
import type { Queryable } from "../softDelete/types.js";

const sampleEntry: AuditLogEntry = {
  id: "event-1",
  sequenceNum: 7,
  tableName: "user|records",
  recordId: "record=1\nnext",
  operation: "UPDATE",
  userId: "user-1",
  sessionId: null,
  ipAddress: "192.0.2.1",
  userAgent: null,
  oldValues: { password: "not-exported" },
  newValues: { password: "also-not-exported" },
  changedFields: ["password"],
  occurredAt: new Date("2026-09-28T12:00:00.000Z"),
  transactionId: "tx-1",
  prevHash: null,
  entryHash: "hash-1",
};

class InsertAuditDb implements Queryable {
  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string
  ): Promise<{ rows: Row[]; rowCount: number | null }> {
    if (text.includes("SELECT entry_hash")) return { rows: [], rowCount: 0 };
    if (text.includes("INSERT INTO audit_log")) {
      return {
        rows: [{
          id: "event-1",
          sequence_num: 7,
          table_name: "users",
          record_id: "user-1",
          operation: "INSERT",
          user_id: null,
          session_id: null,
          ip_address: null,
          user_agent: null,
          old_values: null,
          new_values: null,
          changed_fields: [],
          occurred_at: new Date("2026-09-28T12:00:00.000Z"),
          transaction_id: "tx-1",
          prev_hash: null,
          entry_hash: "hash-1",
        } as unknown as Row],
        rowCount: 1,
      };
    }
    throw new Error(`Unexpected audit query: ${text}`);
  }
}

afterEach(() => configureAuditLogTransport(undefined));

describe("CEF exporter", () => {
  it("escapes CEF delimiters and line breaks without exporting old or new values", () => {
    const cef = formatCef(sampleEntry);

    expect(cef).toContain("CEF:0|DelegoLabs|Delego|1.0|UPDATE|UPDATE audit event|5");
    expect(cef).toContain("cs1=user|records");
    expect(cef).toContain("cs2=record\\=1\\nnext");
    expect(cef).toContain("src=192.0.2.1");
    expect(cef).not.toContain("not-exported");
    expect(cef).not.toContain("also-not-exported");
  });

  it("dispatches the committed audit entry to the configured streaming transport", async () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    let sentMessage = "";
    const socket = {
      setTimeout: vi.fn(),
      once: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        listeners.set(event, listener);
        return socket;
      }),
      end: vi.fn((message: string, callback: () => void) => {
        sentMessage = message;
        callback();
      }),
      destroy: vi.fn(),
    } as unknown as tls.TLSSocket;
    const connect = vi.fn(() => socket) as unknown as typeof tls.connect;
    configureAuditLogTransport(createCefSyslogTransport({ host: "siem.example", port: 6514 }, connect));

    await recordAuditEntry(new InsertAuditDb(), {
      tableName: "users",
      recordId: "user-1",
      operation: "INSERT",
      transactionId: "tx-1",
    });

    listeners.get("secureConnect")?.();
    expect(connect).toHaveBeenCalledWith(expect.objectContaining({
      host: "siem.example",
      port: 6514,
      rejectUnauthorized: true,
      servername: "siem.example",
    }));
    expect(sentMessage).toContain("CEF:0|DelegoLabs|Delego|1.0|INSERT|");
    expect(sentMessage.endsWith("\n")).toBe(true);
  });

  it("does not make a committed audit write fail when the SIEM transport rejects", async () => {
    configureAuditLogTransport(() => Promise.reject(new Error("SIEM unavailable")));

    await expect(recordAuditEntry(new InsertAuditDb(), {
      tableName: "users",
      recordId: "user-1",
      operation: "INSERT",
      transactionId: "tx-1",
    })).resolves.toMatchObject({ id: "event-1" });
  });
});