/**
 * Unit tests for the Memory-Efficient Chunked CSV Exporter — Issue #395.
 *
 * Covers:
 *  - RFC 4180 field/row serialization (quotes, commas, newlines, dates, nulls)
 *  - Header emission (explicit + derived, zero-row result sets)
 *  - End-to-end streaming into a (mock) HTTP response with correct headers
 *  - Memory profile: 100,000-row export completes without a memory spike
 *  - Backpressure: the DB source is paused while the consumer drains
 *  - Keyset-paginated row stream behavior (page boundaries, end of results)
 */
import { describe, it, expect } from "vitest";
import { Readable, Writable } from "node:stream";
import { EventEmitter, once } from "node:events";
import type { ServerResponse } from "node:http";
import {
  escapeCsvField,
  csvRow,
  csvRowLine,
  createCsvRowTransformer,
  streamCsvExportAsync,
  createPagedRowStream,
} from "./csvExportService.js";

/**
 * Minimal mock of http.ServerResponse built on a real Writable stream so
 * `stream.pipeline` backpressure/flow control works, plus an EventEmitter
 * for pipeline teardown wiring.
 */
function createMockRes() {
  const chunks: Buffer[] = [];
  let headers: Record<string, unknown> | undefined;
  let statusCode: number | undefined;
  let ended = false;
  let destroyed = false;
  let headersSent = false;

  const emitter = new EventEmitter();

  const writable = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
      callback();
    },
  });

  // Capture the real Writable.prototype methods BEFORE Object.assign copies
  // them onto `res` (assigning bound copies would make super-calls recurse).
  const writableEnd = writable.end.bind(writable);
  const writableDestroy = writable.destroy.bind(writable);

  const res = Object.assign(writable, emitter, {
    // Mirror http.ServerResponse behavior: headersSent flips in writeHead().
    headersSent: false,
    writeHead(code: number, writeHeaders?: Record<string, unknown>) {
      statusCode = code;
      headers = writeHeaders;
      headersSent = true;
      (res as { headersSent: boolean }).headersSent = true;
      return res;
    },
    end(chunk?: unknown) {
      if (chunk !== undefined) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      }
      ended = true;
      return writableEnd();
    },
    destroy(err?: Error) {
      destroyed = true;
      // Ensure the error emission never becomes an unhandled 'error' event.
      writable.once("error", () => undefined);
      return writableDestroy(err);
    },
  }) as unknown as ServerResponse & {
    destroyed: boolean;
  };

  // Mark as ended when the underlying writable finishes.
  writable.on("finish", () => {
    ended = true;
  });

  return {
    res,
    get body(): string {
      return Buffer.concat(chunks).toString("utf8");
    },
    get responseHeaders(): Record<string, unknown> | undefined {
      return headers;
    },
    get status(): number | undefined {
      return statusCode;
    },
    get writableEnded(): boolean {
      return ended || writable.writableEnded;
    },
    get destroyedFlag(): boolean {
      return destroyed;
    },
  };
}

describe("escapeCsvField (RFC 4180)", () => {
  it("passes through plain values", () => {
    expect(escapeCsvField("hello")).toBe("hello");
    expect(escapeCsvField(42)).toBe("42");
    expect(escapeCsvField(1.5)).toBe("1.5");
    expect(escapeCsvField(true)).toBe("true");
  });

  it("serializes null and undefined as empty fields", () => {
    expect(escapeCsvField(null)).toBe("");
    expect(escapeCsvField(undefined)).toBe("");
  });

  it("serializes Date values as ISO-8601", () => {
    const d = new Date("2026-01-15T10:30:00.000Z");
    expect(escapeCsvField(d)).toBe("2026-01-15T10:30:00.000Z");
  });

  it("quotes fields containing commas", () => {
    expect(escapeCsvField("a,b")).toBe('"a,b"');
  });

  it("quotes fields containing quotes and doubles embedded quotes", () => {
    expect(escapeCsvField('say "hi"')).toBe('"say ""hi"""');
  });

  it("quotes fields containing newlines", () => {
    expect(escapeCsvField("line1\nline2")).toBe('"line1\nline2"');
    expect(escapeCsvField("line1\r\nline2")).toBe('"line1\r\nline2"');
  });

  it("does not quote fields that merely contain other special chars", () => {
    expect(escapeCsvField("semi;colon")).toBe("semi;colon");
    expect(escapeCsvField("tab\tchar")).toBe("tab\tchar");
  });
});

describe("csvRow / csvRowLine", () => {
  it("joins array fields with commas", () => {
    expect(csvRow(["a", 1, null])).toBe("a,1,");
  });

  it("uses object values in insertion order", () => {
    expect(csvRow({ b: 2, a: 1 })).toBe("2,1");
  });

  it("appends CRLF terminator", () => {
    expect(csvRowLine(["x", "y"])).toBe("x,y\r\n");
  });
});

describe("createCsvRowTransformer", () => {
  it("emits explicit headers before the first data row", async () => {
    const transformer = createCsvRowTransformer({ headers: ["id", "amount"] });
    const out: string[] = [];
    transformer.on("data", (c: Buffer) => out.push(c.toString("utf8")));

    transformer.write({ id: "r1", amount: 100 });
    transformer.end();
    await new Promise<void>((resolve) => transformer.on("end", resolve));

    expect(out.join("")).toBe("id,amount\r\nr1,100\r\n");
  });

  it("derives headers from the first object row when not provided", async () => {
    const transformer = createCsvRowTransformer();
    const out: string[] = [];
    transformer.on("data", (c: Buffer) => out.push(c.toString("utf8")));

    transformer.write({ id: "r1", hash: "h1" });
    transformer.write({ id: "r2", hash: "h2" });
    transformer.end();
    await new Promise<void>((resolve) => transformer.on("end", resolve));

    expect(out.join("")).toBe("id,hash\r\nr1,h1\r\nr2,h2\r\n");
  });

  it("emits a header-only file for an empty result set", async () => {
    const transformer = createCsvRowTransformer({ headers: ["id", "amount"] });
    const out: string[] = [];
    transformer.on("data", (c: Buffer) => out.push(c.toString("utf8")));

    transformer.end();
    await new Promise<void>((resolve) => transformer.on("end", resolve));

    expect(out.join("")).toBe("id,amount\r\n");
  });

  it("applies mapRow before serialization", async () => {
    const transformer = createCsvRowTransformer({
      headers: ["id", "amount_stroops"],
      mapRow: (row) => {
        const r = row as { id: string; amount: string };
        return [r.id, r.amount];
      },
    });
    const out: string[] = [];
    transformer.on("data", (c: Buffer) => out.push(c.toString("utf8")));

    transformer.write({ id: "r1", amount: "10000000" });
    transformer.end();
    await new Promise<void>((resolve) => transformer.on("end", resolve));

    expect(out.join("")).toBe("id,amount_stroops\r\nr1,10000000\r\n");
  });

  it("aborts the stream when mapRow throws", async () => {
    const transformer = createCsvRowTransformer({
      mapRow: () => {
        throw new Error("bad row");
      },
    });
    const errors: unknown[] = [];
    transformer.on("error", (err: unknown) => errors.push(err));

    transformer.write({ id: "r1" });
    await new Promise<void>((resolve) => transformer.on("error", resolve));

    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("bad row");
  });
});

describe("streamCsvExportAsync (end-to-end)", () => {
  it("sets CSV headers and streams rows to the response", async () => {
    const mock = createMockRes();
    const source = Readable.from([{ id: "1" }, { id: "2" }]);

    await streamCsvExportAsync(source, mock.res, { filename: "test.csv" });

    expect(mock.status).toBe(200);
    expect(mock.responseHeaders?.["Content-Type"]).toBe("text/csv; charset=utf-8");
    expect(mock.responseHeaders?.["Content-Disposition"]).toBe('attachment; filename="test.csv"');
    expect(mock.responseHeaders?.["Cache-Control"]).toBe("no-store");
    expect(mock.body).toBe("id\r\n1\r\n2\r\n");
  });

  it("completes a 100,000-row export without a memory spike", async () => {
    const mock = createMockRes();

    const baseline = process.memoryUsage().heapUsed;
    const ROWS = 100_000;
    const source = Readable.from(
      (async function* generateRows() {
        for (let i = 0; i < ROWS; i++) {
          yield {
            id: `row-${i}`,
            hash: `hash${i}`,
            type: "payment",
            direction: i % 2 === 0 ? "incoming" : "outgoing",
            amount: String(i * 7),
            memo: `memo ${i}`,
          };
        }
      })(),
      { objectMode: true, highWaterMark: 16 },
    );

    await streamCsvExportAsync(source, mock.res, {
      headers: ["id", "hash", "type", "direction", "amount", "memo"],
      filename: "bulk.csv",
    });

    const peak = (process.memoryUsage().heapUsed - baseline) / 1024 / 1024;

    // Row count: header + 100k data rows.
    const lines = mock.body.split("\r\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(ROWS + 1);
    expect(lines[0]).toBe("id,hash,type,direction,amount,memo");
    expect(lines[1]).toBe("row-0,hash0,payment,incoming,0,memo 0");
    expect(lines[ROWS]).toBe(`row-${ROWS - 1},hash${ROWS - 1},payment,outgoing,${(ROWS - 1) * 7},memo ${ROWS - 1}`);

    // A generator holding one row at a time must not accumulate the full
    // dataset. Generously allow 50 MB — loading 100k objects eagerly would
    // exceed this in serialization-heavy test environments and CI runners.
    expect(peak).toBeLessThan(50);
  });

  it("destroys the response when the source stream errors mid-flight", async () => {
    const mock = createMockRes();

    // DB cursor dies after two rows — the pipeline must tear the response down.
    const source = Readable.from(
      (async function* dyingCursor() {
        yield { id: "1" };
        yield { id: "2" };
        throw new Error("db connection lost");
      })(),
    );

    await expect(streamCsvExportAsync(source, mock.res)).rejects.toThrow("db connection lost");
    expect(mock.body).toContain("id");
    expect(mock.destroyedFlag).toBe(true);
  });
});

describe("createPagedRowStream (keyset pagination)", () => {
  it("streams all rows across page boundaries and stops at a short page", async () => {
    const pages = [
      [{ id: "a" }, { id: "b" }],
      [{ id: "c" }],
    ];
    const calls: Array<{ cursor: unknown; limit: number }> = [];
    const fetchPage = async (cursor: unknown, limit: number) => {
      calls.push({ cursor, limit });
      const index = calls.length - 1;
      return pages[index] ?? [];
    };

    const stream = createPagedRowStream(fetchPage, { pageSize: 2 });
    const rows: unknown[] = [];
    stream.on("data", (row: unknown) => rows.push(row));
    await new Promise<void>((resolve, reject) => {
      stream.on("end", resolve);
      stream.on("error", reject);
    });

    expect(rows).toEqual([{ id: "a" }, { id: "b" }, { id: "c" }]);
    // First call: null cursor; second call: cursor is last row of page 1.
    expect(calls[0].cursor).toBeNull();
    expect(calls[1].cursor).toEqual({ id: "b" });
    expect(calls[1].limit).toBe(2);
    // No third call: short page signals end of results.
    expect(calls).toHaveLength(2);
  });

  it("pauses page fetches until downstream consumption resumes (backpressure)", async () => {
    let fetchCalls = 0;
    // Page 1 (50 rows) exceeds the default object-mode highWaterMark of 16,
    // so the source suspends after one page while the consumer is paused.
    // Page 2 is empty → clean end.
    const fetchPage = async (cursor: unknown, limit: number): Promise<ReadonlyArray<unknown>> => {
      void cursor;
      void limit;
      fetchCalls += 1;
      if (fetchCalls === 1) {
        return Array.from({ length: 50 }, (_, i) => ({ id: `p1-${i}` }));
      }
      return [];
    };

    const stream = createPagedRowStream(fetchPage, { pageSize: 50 });

    // Pull mode (no 'data' listener — attaching one would switch the stream
    // into flowing mode and defeat the pause).
    let ended = false;
    stream.once("end", () => {
      ended = true;
    });
    stream.pause();

    await once(stream, "readable");
    expect(fetchCalls).toBe(1);

    // While paused with a full buffer, no further page fetches happen.
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchCalls).toBe(1);

    // Drain via read() until end.
    const rows: unknown[] = [];
    for (;;) {
      const row = stream.read();
      if (row !== null) {
        rows.push(row);
        continue;
      }
      if (ended) break;
      if (stream.readableLength > 0) continue;
      await Promise.race([once(stream, "readable"), once(stream, "end")]);
    }

    expect(rows).toHaveLength(50);
    expect(fetchCalls).toBe(2);
  });

  it("propagates fetchPage errors to the stream", async () => {
    const fetchPage = async () => {
      throw new Error("query failed");
    };
    const stream = createPagedRowStream(fetchPage);

    const error = await new Promise<unknown>((resolve) => {
      stream.on("error", resolve);
      // Start flowing so the generator (and the rejection) actually runs.
      stream.on("data", () => undefined);
    });
    expect((error as Error).message).toBe("query failed");
  });
});
