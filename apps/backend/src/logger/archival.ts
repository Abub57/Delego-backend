import { createGzip, createGunzip, gzipSync, gunzipSync } from 'zlib';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';

export interface LogChunkArchival {
  chunkId: string;
  compressedSizeBytes: number;
  rawSizeBytes: number;
}

export type CompressionAlgorithm = 'gzip' | 'none';

export interface CompressedLogChunk extends LogChunkArchival {
  algorithm: CompressionAlgorithm;
  data: Buffer;
}

export interface ArchivalOptions {
  algorithm?: CompressionAlgorithm;
  chunkId?: string;
}

/**
 * Compressed JSON logging formatter for high-volume ingestion.
 * Serializes log records to newline-delimited JSON and optionally compresses
 * the resulting byte stream before it is streamed to S3 / CloudWatch.
 */
export class CompressedJsonLogFormatter {
  private readonly algorithm: CompressionAlgorithm;

  constructor(algorithm: CompressionAlgorithm = 'gzip') {
    this.algorithm = algorithm;
  }

  /** Serialize records to newline-delimited JSON. */
  format(records: unknown[]): Buffer {
    const lines = records.map((record) => JSON.stringify(record));
    return Buffer.from(lines.join('\n'), 'utf8');
  }

  /** Compress a raw buffer according to the configured algorithm. */
  compress(raw: Buffer): Buffer {
    if (this.algorithm === 'none') {
      return raw;
    }
    return gzipSync(raw);
  }

  /** Decompress a buffer produced by {@link compress}. */
  decompress(data: Buffer): Buffer {
    if (this.algorithm === 'none') {
      return data;
    }
    return gunzipSync(data);
  }

  /** Format and compress records into an archival chunk. */
  toChunk(records: unknown[], options: ArchivalOptions = {}): CompressedLogChunk {
    const raw = this.format(records);
    const data = this.compress(raw);
    return {
      chunkId: options.chunkId ?? generateChunkId(),
      algorithm: this.algorithm,
      rawSizeBytes: raw.byteLength,
      compressedSizeBytes: data.byteLength,
      data,
    };
  }
}

/**
 * Stream compression transform for archived log chunks.
 * Pipes raw JSON bytes through gzip (or passes them through unchanged).
 */
export function createCompressionStream(
  algorithm: CompressionAlgorithm = 'gzip',
): Transform {
  if (algorithm === 'none') {
    return new Transform({
      transform(chunk, _encoding, callback) {
        callback(null, chunk);
      },
    });
  }
  return createGzip();
}

/** Decompression transform matching {@link createCompressionStream}. */
export function createDecompressionStream(
  algorithm: CompressionAlgorithm = 'gzip',
): Transform {
  if (algorithm === 'none') {
    return new Transform({
      transform(chunk, _encoding, callback) {
        callback(null, chunk);
      },
    });
  }
  return createGunzip();
}

/**
 * Compress a readable stream of raw log bytes into a single archival chunk.
 */
export async function compressStream(
  source: Readable,
  options: ArchivalOptions = {},
): Promise<CompressedLogChunk> {
  const algorithm = options.algorithm ?? 'gzip';
  const chunks: Buffer[] = [];
  let rawSizeBytes = 0;

  const collector = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      rawSizeBytes += chunk.byteLength;
      callback(null, chunk);
    },
  });

  const compressed: Buffer[] = [];
  const sink = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      compressed.push(chunk);
      callback();
    },
  });

  await pipeline(source, collector, createCompressionStream(algorithm), sink);

  const data = Buffer.concat(compressed);
  return {
    chunkId: options.chunkId ?? generateChunkId(),
    algorithm,
    rawSizeBytes,
    compressedSizeBytes: data.byteLength,
    data,
  };
}

/**
 * Benchmark compression throughput against raw streaming for a payload.
 * Returns the ratio of raw bytes to compressed bytes (higher is better).
 */
export function benchmarkThroughput(
  raw: Buffer,
  algorithm: CompressionAlgorithm = 'gzip',
): { rawSizeBytes: number; compressedSizeBytes: number; ratio: number } {
  const formatter = new CompressedJsonLogFormatter(algorithm);
  const compressed = formatter.compress(raw);
  const ratio = compressed.byteLength === 0 ? 0 : raw.byteLength / compressed.byteLength;
  return {
    rawSizeBytes: raw.byteLength,
    compressedSizeBytes: compressed.byteLength,
    ratio,
  };
}

function generateChunkId(): string {
  return `chunk-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
