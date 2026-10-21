/**
 * Throughput benchmark for archived log-chunk compression (Issue #405 —
 * acceptance criterion "Benchmark throughput gains").
 *
 * Measures compression + decompression latency and throughput (MB/s)
 * across gzip levels and zstd levels on synthetic high-volume JSON log
 * lines, and reports the compressed-size (storage) savings vs. the raw
 * JSON-lines payload. Run directly (see bottom) or via the repo script
 * `pnpm ts-benchmark:log-chunks`.
 */

import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import {
  compressLogChunk,
  decompressLogChunk,
  isZstdCompressionSupported,
  type LogChunkCompressionAlgorithm,
  type LogChunkCompressionOptions,
} from "./logChunkCompression.js";

export interface LogChunkBenchmarkOptions {
  /** Number of JSON log lines per synthetic chunk. */
  lines?: number;
  /** gzip levels to sample (default [1, 6, 9]). */
  gzipLevels?: number[];
  /** zstd levels to sample (default [1, 3, 9]); skipped when unsupported. */
  zstdLevels?: number[];
  /** Repetitions per configuration; the median run is reported. */
  repetitions?: number;
  /** Seed for the deterministic line generator (default 42). */
  seed?: number;
}

export interface LogChunkBenchmarkEntry {
  algorithm: LogChunkCompressionAlgorithm;
  level: number;
  rawSizeBytes: number;
  compressedSizeBytes: number;
  /** compressed / raw, lower is better storage-wise. */
  ratio: number;
  /** Storage saved vs raw JSON lines, as a fraction (higher is better). */
  spaceSaved: number;
  /** Median across repetitions, in milliseconds. */
  compressionMs: number;
  /** Median across repetitions, in milliseconds. */
  decompressionMs: number;
  /** MB/s, raw bytes per second of wall-clock compression time. */
  compressionThroughputMBps: number;
  decompressionThroughputMBps: number;
}

export interface LogChunkBenchmarkResult {
  lines: number;
  rawSizeBytes: number;
  entries: LogChunkBenchmarkEntry[];
  /** Fastest configuration by compression throughput. */
  fastest: LogChunkBenchmarkEntry | undefined;
  /** Configuration with the smallest compressed size. */
  smallest: LogChunkBenchmarkEntry | undefined;
  zstdSupported: boolean;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
}

/** Deterministic pseudo-random JSON log line generator so benchmark runs
 * are reproducible. */
function generateLogLines(count: number, seed: number): string {
  let state = seed >>> 0;
  const nextRandom = () => {
    // xorshift32
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };

  const services = ["gateway", "wallet", "payments", "orchestrator", "notifications", "cdc"];
  const levels = ["debug", "info", "warn", "error"];
  const messages = [
    "request handled",
    "delegation created",
    "escrow funded",
    "payment settled",
    "rate limit applied",
    "wallet lookup ok",
    "retrying upstream call",
  ];
  const parts: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const line = JSON.stringify({
      timestamp: new Date(1_700_000_000_000 + i * 7).toISOString(),
      level: levels[Math.floor(nextRandom() * levels.length)],
      service: services[Math.floor(nextRandom() * services.length)],
      traceId: `trc_${Math.floor(nextRandom() * 1e12).toString(36)}`,
      spanId: `spn_${Math.floor(nextRandom() * 1e9).toString(36)}`,
      message: messages[Math.floor(nextRandom() * messages.length)],
      fields: {
        requestId: `req_${i}`,
        wallet: `G${Math.floor(nextRandom() * 1e12).toString(36).toUpperCase()}`,
        amountStroops: Math.floor(nextRandom() * 5_000_000),
        durationMs: Math.floor(nextRandom() * 900),
      },
    });
    parts.push(line);
  }
  return parts.join("\n");
}

const MB = 1024 * 1024;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return percentile(sorted, 50);
}

async function sample(
  raw: Buffer,
  algorithm: LogChunkCompressionAlgorithm,
  level: number,
  repetitions: number,
): Promise<LogChunkBenchmarkEntry> {
  const options: LogChunkCompressionOptions =
    algorithm === "gzip" ? { algorithm, gzipLevel: level } : { algorithm, zstdLevel: level };

  const compressTimes: number[] = [];
  const decompressTimes: number[] = [];
  let compressedSize = 0;

  for (let i = 0; i < repetitions; i += 1) {
    const t0 = performance.now();
    const chunk = await compressLogChunk(raw, options);
    compressTimes.push(performance.now() - t0);
    compressedSize = chunk.compressedSizeBytes;

    const t1 = performance.now();
    const roundTrip = await decompressLogChunk(chunk.data, algorithm);
    decompressTimes.push(performance.now() - t1);
    if (!roundTrip.equals(raw)) {
      throw new Error(`benchmark round trip mismatch for ${algorithm} level ${level}`);
    }
  }

  const compressionMs = median(compressTimes);
  const decompressionMs = median(decompressTimes);
  const rawMB = raw.length / MB;

  return {
    algorithm,
    level,
    rawSizeBytes: raw.length,
    compressedSizeBytes: compressedSize,
    ratio: compressedSize / raw.length,
    spaceSaved: 1 - compressedSize / raw.length,
    compressionMs,
    decompressionMs,
    compressionThroughputMBps: rawMB / (compressionMs / 1000),
    decompressionThroughputMBps: rawMB / (decompressionMs / 1000),
  };
}

export async function runLogChunkBenchmark(
  options: LogChunkBenchmarkOptions = {},
): Promise<LogChunkBenchmarkResult> {
  const lines = options.lines ?? 10_000;
  const repetitions = options.repetitions ?? 3;
  const seed = options.seed ?? 42;
  const zstdSupported = isZstdCompressionSupported();

  const raw = Buffer.from(generateLogLines(lines, seed), "utf8");

  const configs: Array<{ algorithm: LogChunkCompressionAlgorithm; level: number }> = [];
  for (const level of options.gzipLevels ?? [1, 6, 9]) {
    configs.push({ algorithm: "gzip", level });
  }
  if (zstdSupported) {
    for (const level of options.zstdLevels ?? [1, 3, 9]) {
      configs.push({ algorithm: "zstd", level });
    }
  }

  const entries: LogChunkBenchmarkEntry[] = [];
  for (const { algorithm, level } of configs) {
    // eslint-disable-next-line no-await-in-loop
    entries.push(await sample(raw, algorithm, level, repetitions));
  }

  const byThroughput = (a: LogChunkBenchmarkEntry, b: LogChunkBenchmarkEntry) =>
    b.compressionThroughputMBps - a.compressionThroughputMBps;
  const bySize = (a: LogChunkBenchmarkEntry, b: LogChunkBenchmarkEntry) =>
    a.compressedSizeBytes - b.compressedSizeBytes;

  return {
    lines,
    rawSizeBytes: raw.length,
    entries,
    fastest: [...entries].sort(byThroughput)[0],
    smallest: [...entries].sort(bySize)[0],
    zstdSupported,
  };
}

function formatBytes(bytes: number): string {
  if (bytes >= MB) return `${(bytes / MB).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${bytes} B`;
}

/** Prints a human-readable table to stdout. */
export async function printLogChunkBenchmark(
  options: LogChunkBenchmarkOptions = {},
): Promise<LogChunkBenchmarkResult> {
  const result = await runLogChunkBenchmark(options);
  // eslint-disable-next-line no-console
  console.log(
    `Log chunk compression benchmark — ${result.lines} JSON log lines (${formatBytes(result.rawSizeBytes)}), ` +
      `${result.entries.length} configurations${result.zstdSupported ? "" : " (zstd unavailable in this Node runtime)"}`,
  );
  // eslint-disable-next-line no-console
  console.log(
    "  algorithm  level  compressed   ratio  saved   comp ms   MB/s   decomp ms   MB/s",
  );
  for (const e of result.entries) {
    // eslint-disable-next-line no-console
    console.log(
      `  ${e.algorithm.padEnd(9)}  ${String(e.level).padStart(5)}  ` +
        `${formatBytes(e.compressedSizeBytes).padStart(10)}  ` +
        `${e.ratio.toFixed(3)}  ${(e.spaceSaved * 100).toFixed(1)}%  ` +
        `${e.compressionMs.toFixed(2).padStart(8)}  ${e.compressionThroughputMBps.toFixed(0).padStart(6)}  ` +
        `${e.decompressionMs.toFixed(2).padStart(10)}  ${e.decompressionThroughputMBps.toFixed(0).padStart(6)}`,
    );
  }
  if (result.fastest) {
    // eslint-disable-next-line no-console
    console.log(
      `  fastest: ${result.fastest.algorithm} level ${result.fastest.level} ` +
        `(${result.fastest.compressionThroughputMBps.toFixed(0)} MB/s)`,
    );
  }
  if (result.smallest) {
    // eslint-disable-next-line no-console
    console.log(
      `  smallest: ${result.smallest.algorithm} level ${result.smallest.level} ` +
        `(ratio ${result.smallest.ratio.toFixed(3)}, ${(result.smallest.spaceSaved * 100).toFixed(1)}% saved)`,
    );
  }
  return result;
}

// Run directly: `pnpm --filter @delegolabs/utils ts-benchmark:log-chunks`
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await printLogChunkBenchmark();
}
