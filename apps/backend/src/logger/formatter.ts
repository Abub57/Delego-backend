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
  level?: number;
}

export interface FormattedLogChunk {
  chunkId: string;
  algorithm: CompressionAlgorithm;
  body: Buffer;
  archival: LogChunkArchival;
}

const DEFAULT_ALGORITHM: CompressionAlgorithm = 'gzip';

/**
 * Serializes a batch of log records to newline-delimited JSON and optionally
 * compresses the resulting payload for high-volume ingestion into S3/CloudWatch.
 */
export class CompressedJsonLogFormatter {
  private readonly algorithm: CompressionAlgorithm;
  private readonly level: number;

  constructor(options: CompressedLogFormatterOptions = {}) {
    this.algorithm = options.algorithm ?? DEFAULT_ALGORITHM;
    this.level = options.level ?? 6;
  }

  /** Serialize records to newline-delimited JSON. */
  serialize(records: unknown[]): Buffer {
    const lines = records.map((record) => JSON.stringify(record));
    return Buffer.from(lines.length > 0 ? `${lines.join('\n')}\n` : '', 'utf8');
  }

  /** Compress a raw payload buffer according to the configured algorithm. */
  compress(raw: Buffer): Buffer {
    if (this.algorithm === 'none') {
      return raw;
    }
    return gzipSync(raw, { level: this.level });
  }

  /** Decompress a payload produced by {@link compress}. */
  decompress(payload: Buffer): Buffer {
    if (this.algorithm === 'none') {
      return payload;
    }
    return gunzipSync(payload);
  }

  /** Format a batch of records into a compressed, archivable log chunk. */
  format(chunkId: string, records: unknown[]): FormattedLogChunk {
    const raw = this.serialize(records);
    const body = this.compress(raw);
    return {
      chunkId,
      algorithm: this.algorithm,
      body,
      archival: {
        chunkId,
        compressedSizeBytes: body.byteLength,
        rawSizeBytes: raw.byteLength,
      },
    };
  }

  /** Stream-compress a readable source of log data into a compressed buffer. */
  async compressStream(source: Readable): Promise<Buffer> {
    if (this.algorithm === 'none') {
      const chunks: Buffer[] = [];
      for await (const chunk of source) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    }

    const chunks: Buffer[] = [];
    const collector = new Transform({
      transform(chunk, _encoding, callback) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        callback();
      },
    });

    await pipeline(source, createGzip({ level: this.level }), collector);
    return Buffer.concat(chunks);
  }

  /** Stream-decompress a compressed source back into a raw buffer. */
  async decompressStream(source: Readable): Promise<Buffer> {
    if (this.algorithm === 'none') {
      const chunks: Buffer[] = [];
      for await (const chunk of source) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    }

    const chunks: Buffer[] = [];
    const collector = new Transform({
      transform(chunk, _encoding, callback) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        callback();
      },
    });

    await pipeline(source, createGunzip(), collector);
    return Buffer.concat(chunks);
  }
}

/**
 * Measures throughput (bytes/second) of a formatting operation over the given
 * records, allowing compression gains to be benchmarked against raw streaming.
 */
export function benchmarkThroughput(
  formatter: CompressedJsonLogFormatter,
  records: unknown[],
  iterations = 1,
): { rawSizeBytes: number; compressedSizeBytes: number; elapsedMs: number; bytesPerSecond: number } {
  const start = process.hrtime.bigint();
  let rawSizeBytes = 0;
  let compressedSizeBytes = 0;

  for (let i = 0; i < iterations; i += 1) {
    const chunk = formatter.format(`bench-${i}`, records);
    rawSizeBytes = chunk.archival.rawSizeBytes;
    compressedSizeBytes = chunk.archival.compressedSizeBytes;
  }

  const elapsedNs = Number(process.hrtime.bigint() - start);
  const elapsedMs = elapsedNs / 1_000_000;
  const bytesPerSecond = elapsedMs > 0 ? (rawSizeBytes * iterations) / (elapsedMs / 1000) : 0;

  return { rawSizeBytes, compressedSizeBytes, elapsedMs, bytesPerSecond };
}
