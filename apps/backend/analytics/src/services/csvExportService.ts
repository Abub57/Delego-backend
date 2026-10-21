/**
 * Memory-Efficient Chunked CSV Exporter — Issue #395
 *
 * Streams database query results directly to the HTTP response as CSV chunks
 * without ever materializing the full dataset in memory.
 *
 * Design:
 *  - The caller supplies a `Readable` row stream (see `createPagedRowStream`
 *    below for a keyset-paginated DB cursor, or `Readable.from(generator)`).
 *  - Rows are serialized one at a time and pipelined into the response with
 *    `stream.pipeline`, which propagates backpressure end-to-end: the DB
 *    cursor pauses when the socket is congested, so heap usage stays flat
 *    regardless of row count (validated at 100,000 rows in unit tests).
 *  - RFC 4180 compliant: fields containing quotes, commas, or newlines are
 *    double-quoted, embedded quotes are doubled; CRLF row terminators.
 *  - Errors mid-stream terminate the (already started) CSV body so the client
 *    observes a truncated download instead of a hung connection; errors before
 *    the first byte are surfaced as a JSON 500.
 *
 * Note on types: the issue spec types `res` as an Express `Response`, but this
 * repo's HTTP layer is raw `node:http` (see `@delegolabs/utils` `startHttpServer`).
 * Express `Response` extends `http.ServerResponse`, so typing against
 * `ServerResponse` accepts both.
 */
import { pipeline } from "node:stream/promises";
import { Readable, Transform, type WritableOptions } from "node:stream";
import type { Readable as ReadableStream } from "node:stream";
import type { ServerResponse } from "node:http";
import { createLogger } from "@delegolabs/utils";

const log = createLogger("analytics:csv-export", process.env.LOG_LEVEL ?? "info");

/** RFC 4180 CRLF row terminator. */
const CSV_ROW_TERMINATOR = "\r\n";

/**
 * Serialize a single CSV field per RFC 4180:
 * quote if the value contains a quote, comma, CR, or LF; double embedded quotes.
 * `null`/`undefined` serialize as empty fields; `Date` as ISO-8601 UTC.
 */
export function escapeCsvField(value: unknown): string {
  if (value === null || value === undefined) return "";
  const str = value instanceof Date ? value.toISOString() : String(value);
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/** Serialize one row (array of fields or object) to a CSV line without the terminator. */
export function csvRow(fields: ReadonlyArray<unknown> | Record<string, unknown>): string {
  const values = Array.isArray(fields) ? fields : Object.values(fields);
  return values.map(escapeCsvField).join(",");
}

/** Serialize one row to a full CSV line including the CRLF terminator. */
export function csvRowLine(fields: ReadonlyArray<unknown> | Record<string, unknown>): string {
  return `${csvRow(fields)}${CSV_ROW_TERMINATOR}`;
}

export interface StreamCsvExportOptions {
  /**
   * Ordered CSV column headers. When omitted, headers are derived from the
   * first row's keys (object rows only).
   */
  headers?: ReadonlyArray<string>;
  /**
   * Filename for the `Content-Disposition` header.
   * Defaults to `export-<epoch-ms>.csv`.
   */
  filename?: string;
  /**
   * Optional mapper applied to each row before serialization (e.g. flatten a
   * raw DB record into a plain object/array). Errors thrown here abort the
   * export mid-stream.
   */
  mapRow?: (row: unknown) => ReadonlyArray<unknown> | Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Build the object-mode Transform that converts DB row records into CSV text
 * chunks. Kept separate from `streamCsvExport` so the serializer can be
 * unit-tested without an HTTP response.
 *
 * The header line is emitted before the first data row; a result set with zero
 * rows still yields a header-only CSV file.
 */
export function createCsvRowTransformer(
  options: StreamCsvExportOptions = {},
  writableOptions: WritableOptions = {},
): Transform {
  let headerEmitted = false;

  return new Transform({
    writableObjectMode: true, // consumes row records from the DB stream
    readableObjectMode: false, // emits string CSV chunks
    ...writableOptions,
    transform(chunk: unknown, _encoding, callback) {
      try {
        let out = "";

        if (!headerEmitted) {
          headerEmitted = true;
          const first = options.mapRow ? options.mapRow(chunk) : chunk;
          const derived = options.headers ?? (isRecord(first) ? Object.keys(first) : null);
          if (derived && derived.length > 0) {
            out += csvRowLine(derived);
          }
        }

        const row = options.mapRow ? options.mapRow(chunk) : chunk;
        out += csvRowLine(isRecord(row) || Array.isArray(row) ? row : [row]);
        callback(null, out);
      } catch (err) {
        callback(err instanceof Error ? err : new Error(String(err)));
      }
    },
    flush(callback) {
      // Zero-row export: still emit the header line so the file is a valid
      // header-only CSV rather than a 0-byte body.
      if (!headerEmitted && options.headers && options.headers.length > 0) {
        callback(null, csvRowLine(options.headers));
        return;
      }
      callback();
    },
  });
}

/**
 * Stream `queryStream` (a Readable of row records) to `res` as chunked CSV.
 *
 * Per the issue's technical specification (`streamCsvExport(queryStream, res): void`),
 * this starts the streaming pipeline synchronously and returns immediately;
 * the pipeline runs in the background and its errors are handled internally
 * (logged; JSON 500 if headers were not sent yet, stream teardown otherwise).
 *
 * Callers that need completion/error signalling (tests, batch jobs) should use
 * {@link streamCsvExportAsync} instead.
 */
export function streamCsvExport(
  queryStream: ReadableStream,
  res: ServerResponse,
  options: StreamCsvExportOptions = {},
): void {
  streamCsvExportAsync(queryStream, res, options).catch(() => {
    // Already logged + response torn down inside streamCsvExportAsync.
  });
}

/**
 * Promise-returning variant of {@link streamCsvExport}.
 *
 * Sets the CSV response headers, then pipelines `queryStream` through the CSV
 * row transformer into `res`. Resolves when the response finished successfully.
 */
export async function streamCsvExportAsync(
  queryStream: ReadableStream,
  res: ServerResponse,
  options: StreamCsvExportOptions = {},
): Promise<void> {
  const filename = options.filename ?? `export-${Date.now()}.csv`;

  res.writeHead(200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Cache-Control": "no-store",
    // No Content-Length by design: chunked transfer encoding is what keeps
    // memory flat — the body size is only known after full serialization.
  });

  const csv = createCsvRowTransformer(options);

  try {
    // `pipeline` wires error + teardown propagation and backpressure across
    // all three streams and ends `res` after the last chunk.
    await pipeline(queryStream, csv, res);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("CSV export stream failed", { error: message });

    if (!res.writableEnded) {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: null, error: { code: "EXPORT_STREAM_FAILED", message } }));
        return;
      }
      // Headers already sent mid-stream: destroy the socket so the client
      // sees a truncated download rather than a hung connection.
      res.destroy(err instanceof Error ? err : new Error(message));
    }
    throw err;
  }
}

// ─── Keyset-paginated row stream ────────────────────────────────────────────

export interface FetchPage {
  /**
   * Fetch one page of rows. `cursor` is the last row of the previous page
   * (`null` for the first page); return at most `limit` rows ordered
   * consistently so keyset pagination is stable. Return an empty array (or
   * fewer than `limit` rows) to signal end of results.
   */
  (cursor: unknown | null, limit: number): Promise<ReadonlyArray<unknown>>;
}

export interface PagedRowStreamOptions {
  /** Page size per DB round trip (default 1,000 rows). */
  pageSize?: number;
  /** Optional row mapper applied as rows leave the stream. */
  mapRow?: (row: unknown) => unknown;
}

/**
 * Build an object-mode Readable that lazily pages through a query with
 * keyset pagination. Only one page (≤ `pageSize` rows) is held in memory at
 * any time; the next page is fetched only after the current page is fully
 * consumed, so backpressure from the HTTP socket throttles DB reads.
 */
export function createPagedRowStream(fetchPage: FetchPage, options: PagedRowStreamOptions = {}): Readable {
  const pageSize = options.pageSize ?? 1_000;
  let cursor: unknown | null = null;
  let done = false;

  return Readable.from(
    (async function* rowGenerator() {
      while (!done) {
        const page = await fetchPage(cursor, pageSize);
        if (page.length === 0) {
          done = true;
          break;
        }
        for (const row of page) {
          yield options.mapRow ? options.mapRow(row) : row;
        }
        cursor = page[page.length - 1];
        if (page.length < pageSize) {
          done = true;
        }
      }
    })(),
    { objectMode: true, highWaterMark: 16 },
  );
}
