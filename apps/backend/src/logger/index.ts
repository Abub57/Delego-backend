import { createGzip, createGunzip, gzipSync, gunzipSync } from 'zlib';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';

export interface LogChunkArchival {
  chunkId: string;
  compressedSizeBytes: number;
  rawSizeBytes: number;
}

export type CompressionAlgorithm = 'gzip' | 'none';

export interface CompressedLogFormatterOptions {
  algorithm?: CompressionAlgorithm;
  /** gzip compression level (0-9). Higher = smaller output, slower. */
  level?: number;
}

/**
 * Serializes a log record to a single JSON line (newline-delimited JSON).
 */
export function formatJsonLine(record: unknown): string {
  return `${JSON.stringify(record)}\n`;
}

/**
 * Compressed JSON logging formatter for high-volume ingestion.
 *
 * Buffers newline-delimited JSON records and emits a single compressed
 * payload (gzip) suitable for streaming to S3 / CloudWatch. When the
 * algorithm is 'none' the raw NDJSON buffer is returned unchanged.
 */
export class CompressedJsonLogFormatter {
  private readonly algorithm: CompressionAlgorithm;
  private readonly level: number;
  private buffer: string[] = [];

  constructor(options: CompressedLogFormatterOptions = {}) {
    this.algorithm = options.algorithm ?? 'gzip';
    this.level = options.level ?? 6;
  }

  /** Append a record to the pending chunk. */
  write(record: unknown): void {
    this.buffer.push(formatJsonLine(record));
  }

  /** Number of buffered records awaiting flush. */
  get pending(): number {
    return this.buffer.length;
  }

  /**
   * Flush the buffered records into a compressed chunk.
   * Returns the compressed payload plus archival metadata.
   */
  flush(chunkId: string): { payload: Buffer; archival: LogChunkArchival } {
    const raw = Buffer.from(this.buffer.join(''), 'utf8');
    this.buffer = [];

    const payload =
      this.algorithm === 'gzip'
        ? gzipSync(raw, { level: this.level })
        : raw;

    return {
      payload,
      archival: {
        chunkId,
        compressedSizeBytes: payload.byteLength,
        rawSizeBytes: raw.byteLength,
      },
    };
  }
}

/**
 * Stream-compress a readable source of NDJSON into a gzip stream.
 * Useful for piping large log chunks directly to S3 / CloudWatch.
 */
export function compressLogStream(
  source: Readable,
  options: CompressedLogFormatterOptions = {},
): Transform {
  if ((options.algorithm ?? 'gzip') === 'none') {
    return new Transform({
      transform(chunk, _enc, cb) {
        cb(null, chunk);
      },
    });
  }
  return createGzip({ level: options.level ?? 6 });
}

/**
 * Decompress a gzip-compressed log chunk back to its raw NDJSON buffer.
 * Used to validate decompression round-trips.
 */
export function decompressLogChunk(payload: Buffer): Buffer {
  return gunzipSync(payload);
}

/**
 * Stream-decompress a gzip source back to raw NDJSON.
 */
export function decompressLogStream(source: Readable): Transform {
  return createGunzip();
}

/**
 * Pipe a readable NDJSON source through gzip compression into a writable sink.
 */
export async function streamCompressTo(
  source: Readable,
  sink: NodeJS.WritableStream,
  options: CompressedLogFormatterOptions = {},
): Promise<void> {
  await pipeline(source, compressLogStream(source, options), sink);
}

/**
 * Benchmark throughput gains of compression vs raw streaming.
 * Returns the compression ratio and the relative throughput delta.
 */
export function benchmarkCompression(
  raw: Buffer,
  options: CompressedLogFormatterOptions = {},
): { archival: LogChunkArchival; ratio: number; throughputGain: number } {
  const start = process.hrtime.bigint();
  const payload =
    (options.algorithm ?? 'gzip') === 'gzip'
      ? gzipSync(raw, { level: options.level ?? 6 })
      : raw;
  const elapsedNs = Number(process.hrtime.bigint() - start);

  const ratio = raw.byteLength === 0 ? 1 : payload.byteLength / raw.byteLength;
  // Throughput gain approximates bytes saved per unit of compression time.
  const throughputGain = elapsedNs === 0 ? 0 : (raw.byteLength - payload.byteLength) / elapsedNs;

  return {
    archival: {
      chunkId: '',
      compressedSizeBytes: payload.byteLength,
      rawSizeBytes: raw.byteLength,
    },
    ratio,
    throughputGain,
  };
}
