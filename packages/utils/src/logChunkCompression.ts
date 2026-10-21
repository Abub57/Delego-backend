/**
 * Compressed JSON logging formatter support for high-volume ingestion
 * (Issue #405 — "Implement Compressed JSON Logging Formatter for
 * High-Volume Ingestion").
 *
 * Context (from the issue): the structured logger emits JSON lines; this
 * module optionally gzip- or zstd-compresses archived log chunks before
 * they are streamed to Amazon S3 / CloudWatch.
 *
 * Scoping note (mirrors ./logAggregation.ts): this provides the
 * provider-agnostic stream compression, decompression-verification, the
 * `LogChunkArchival` record from the issue's Data Types & Schemas, and a
 * throughput benchmark (./logChunkCompressionBenchmark.ts). It does not
 * itself implement the S3/CloudWatch upload clients or bucket lifecycle
 * configuration — the compressed bytes + metadata produced here are
 * exactly what a streaming archival writer would PUT to S3 / forward to
 * a CloudWatch Logs destination.
 */

import { Readable, type Transform } from "node:stream";
import { performance } from "node:perf_hooks";
import zlib from "node:zlib";

export type LogChunkCompressionAlgorithm = "gzip" | "zstd";

export const DEFAULT_LOG_CHUNK_COMPRESSION_ALGORITHM: LogChunkCompressionAlgorithm =
  "gzip";

export interface LogChunkCompressionOptions {
  /** Compression algorithm for the chunk (default: gzip). */
  algorithm?: LogChunkCompressionAlgorithm;
  /** gzip level 0–9 (default 6, zlib's default). */
  gzipLevel?: number;
  /** zstd level 1–19 (default 3, zlib's default). */
  zstdLevel?: number;
}

/** A log chunk after stream compression — the payload an archival writer
 * (S3 / CloudWatch) would upload, plus the size metadata needed for the
 * `LogChunkArchival` record. */
export interface CompressedLogChunk {
  data: Buffer;
  algorithm: LogChunkCompressionAlgorithm;
  rawSizeBytes: number;
  compressedSizeBytes: number;
  compressionTimeMs: number;
  /** compressedSizeBytes / rawSizeBytes (1 when the chunk is empty). */
  ratio: number;
}

/** Archival record from the issue's Data Types & Schemas, persisted
 * alongside (or referenced by) the compressed chunk object in storage. */
export interface LogChunkArchival {
  chunkId: string;
  compressedSizeBytes: number;
  rawSizeBytes: number;
}

/** `LogChunkArchival` extended with the compression metadata the pipeline
 * knows at archival time (algorithm, latency, ratio, timestamp). */
export interface LogChunkArchivalContext extends LogChunkArchival {
  algorithm: LogChunkCompressionAlgorithm;
  compressionTimeMs: number;
  ratio: number;
  createdAt: string;
}

/** Result of a compress → decompress round trip validity check. */
export interface LogChunkCompressionVerification {
  valid: boolean;
  algorithm: LogChunkCompressionAlgorithm;
  rawSizeBytes: number;
  compressedSizeBytes: number;
  roundTripBytesMatch: boolean;
  compressionTimeMs: number;
  decompressionTimeMs: number;
}

export class LogChunkCompressionError extends Error {
  readonly algorithm: LogChunkCompressionAlgorithm;

  constructor(
    algorithm: LogChunkCompressionAlgorithm,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "LogChunkCompressionError";
    this.algorithm = algorithm;
  }
}

export class UnsupportedLogChunkCompressionError extends LogChunkCompressionError {
  constructor(algorithm: LogChunkCompressionAlgorithm) {
    super(
      algorithm,
      `unsupported log chunk compression algorithm: '${algorithm}'`,
    );
    this.name = "UnsupportedLogChunkCompressionError";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// zstd support (Node ≥ 23.8 / ≥ 22.15 ships zlib zstd streams natively)
// ─────────────────────────────────────────────────────────────────────────────

interface ZstdStreamOptions {
  params?: Record<number, number>;
}

type ZlibWithZstd = typeof zlib & {
  createZstdCompress?: (options?: ZstdStreamOptions) => Transform;
  createZstdDecompress?: (options?: Record<string, unknown>) => Transform;
};

const zlibWithZstd = zlib as ZlibWithZstd;

/** zstd streams are available natively in the running Node runtime. */
export function isZstdCompressionSupported(): boolean {
  return (
    typeof zlibWithZstd.createZstdCompress === "function" &&
    typeof zlibWithZstd.createZstdDecompress === "function"
  );
}

function zstdLevelParam(zstdLevel: number): ZstdStreamOptions {
  const key = (
    zlib.constants as unknown as Record<string, number | undefined>
  ).ZSTD_c_compressionLevel;
  return key !== undefined ? { params: { [key]: zstdLevel } } : {};
}

// ─────────────────────────────────────────────────────────────────────────────
// Stream plumbing
// ─────────────────────────────────────────────────────────────────────────────

function collectStream(stream: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

/** Pipe the chunk through a (de)compression Transform and collect the
 * output — bounded in-memory chunks, matching the archival use case. */
async function runThroughStream(
  input: Buffer,
  transform: Transform,
): Promise<Buffer> {
  const source = Readable.from(input);
  source.on("error", (err) => transform.destroy(err));
  source.pipe(transform);
  return collectStream(transform);
}

function toBuffer(input: string | Buffer, label: string): Buffer {
  if (typeof input === "string") return Buffer.from(input, "utf8");
  if (Buffer.isBuffer(input)) return input;
  throw new TypeError(
    `${label} must be a string or Buffer, got ${typeof input}`,
  );
}

function validateOptions(
  algorithm: LogChunkCompressionAlgorithm,
  options: LogChunkCompressionOptions,
): void {
  if (algorithm !== "gzip" && algorithm !== "zstd") {
    throw new UnsupportedLogChunkCompressionError(algorithm);
  }
  if (options.gzipLevel !== undefined) {
    if (!Number.isInteger(options.gzipLevel) || options.gzipLevel < 0 || options.gzipLevel > 9) {
      throw new RangeError(`gzipLevel must be an integer in [0, 9], got ${options.gzipLevel}`);
    }
  }
  if (options.zstdLevel !== undefined) {
    if (!Number.isInteger(options.zstdLevel) || options.zstdLevel < 1 || options.zstdLevel > 19) {
      throw new RangeError(`zstdLevel must be an integer in [1, 19], got ${options.zstdLevel}`);
    }
  }
}

function createChunkCompressor(
  algorithm: LogChunkCompressionAlgorithm,
  options: LogChunkCompressionOptions,
): Transform {
  switch (algorithm) {
    case "gzip":
      return zlib.createGzip({ level: options.gzipLevel ?? 6 });
    case "zstd": {
      if (!isZstdCompressionSupported()) {
        throw new UnsupportedLogChunkCompressionError("zstd");
      }
      return zlibWithZstd.createZstdCompress!(
        zstdLevelParam(options.zstdLevel ?? 3),
      );
    }
  }
}

function createChunkDecompressor(
  algorithm: LogChunkCompressionAlgorithm,
): Transform {
  switch (algorithm) {
    case "gzip":
      return zlib.createGunzip();
    case "zstd": {
      if (!isZstdCompressionSupported()) {
        throw new UnsupportedLogChunkCompressionError("zstd");
      }
      return zlibWithZstd.createZstdDecompress!();
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/** Compress one archived log chunk (JSON lines) with a stream compressor,
 * returning the compressed bytes plus the raw/compressed sizes for the
 * archival record. */
export async function compressLogChunk(
  input: string | Buffer,
  options: LogChunkCompressionOptions = {},
): Promise<CompressedLogChunk> {
  const raw = toBuffer(input, "log chunk");
  const algorithm = options.algorithm ?? DEFAULT_LOG_CHUNK_COMPRESSION_ALGORITHM;
  validateOptions(algorithm, options);

  const compressor = createChunkCompressor(algorithm, options);
  const started = performance.now();
  let data: Buffer;
  try {
    data = await runThroughStream(raw, compressor);
  } catch (cause) {
    throw new LogChunkCompressionError(
      algorithm,
      `failed to compress log chunk: ${(cause as Error).message}`,
      { cause },
    );
  }

  return {
    data,
    algorithm,
    rawSizeBytes: raw.length,
    compressedSizeBytes: data.length,
    compressionTimeMs: performance.now() - started,
    ratio: raw.length > 0 ? data.length / raw.length : 1,
  };
}

/** Decompress a previously compressed log chunk (validates the archive is
 * readable — e.g. before or after an S3 / CloudWatch upload). */
export async function decompressLogChunk(
  data: Buffer,
  algorithm: LogChunkCompressionAlgorithm,
): Promise<Buffer> {
  if (!Buffer.isBuffer(data)) {
    throw new TypeError(`data must be a Buffer, got ${typeof data}`);
  }
  if (algorithm !== "gzip" && algorithm !== "zstd") {
    throw new UnsupportedLogChunkCompressionError(algorithm);
  }

  const decompressor = createChunkDecompressor(algorithm);
  let result: Buffer;
  try {
    result = await runThroughStream(data, decompressor);
  } catch (cause) {
    throw new LogChunkCompressionError(
      algorithm,
      `failed to decompress log chunk (archive may be corrupt): ${(cause as Error).message}`,
      { cause },
    );
  }
  return result;
}

/** Compress → decompress round trip: verifies the compressed archive
 * decompresses back to the exact original bytes. */
export async function verifyLogChunkCompression(
  input: string | Buffer,
  options: LogChunkCompressionOptions = {},
): Promise<LogChunkCompressionVerification> {
  const raw = toBuffer(input, "log chunk");
  const compressed = await compressLogChunk(raw, options);

  const started = performance.now();
  const roundTrip = await decompressLogChunk(compressed.data, compressed.algorithm);
  const decompressionTimeMs = performance.now() - started;
  const roundTripBytesMatch = roundTrip.equals(raw);

  return {
    valid: roundTripBytesMatch,
    algorithm: compressed.algorithm,
    rawSizeBytes: compressed.rawSizeBytes,
    compressedSizeBytes: compressed.compressedSizeBytes,
    roundTripBytesMatch,
    compressionTimeMs: compressed.compressionTimeMs,
    decompressionTimeMs,
  };
}

/** Build the issue's `LogChunkArchival` record from a compressed chunk. */
export function buildLogChunkArchival(input: {
  chunkId: string;
  chunk: Pick<CompressedLogChunk, "rawSizeBytes" | "compressedSizeBytes" | "algorithm" | "compressionTimeMs" | "ratio">;
}): LogChunkArchivalContext {
  const { chunkId, chunk } = input;
  if (typeof chunkId !== "string" || chunkId.trim().length === 0) {
    throw new TypeError("chunkId must be a non-empty string");
  }
  for (const field of ["rawSizeBytes", "compressedSizeBytes"] as const) {
    const value = chunk[field];
    if (!Number.isInteger(value) || value < 0) {
      throw new TypeError(`chunk.${field} must be a non-negative integer, got ${value}`);
    }
  }
  return {
    chunkId,
    rawSizeBytes: chunk.rawSizeBytes,
    compressedSizeBytes: chunk.compressedSizeBytes,
    algorithm: chunk.algorithm,
    compressionTimeMs: chunk.compressionTimeMs,
    ratio: chunk.ratio,
    createdAt: new Date().toISOString(),
  };
}
