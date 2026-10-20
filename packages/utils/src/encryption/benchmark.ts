/**
 * Encryption performance benchmark (#68 — "add encryption performance
 * benchmarks", acceptance criterion "encryption adds < 2ms per field").
 *
 * Measures the end-to-end cost of encrypting + decrypting a PII field
 * through the ColumnEncryptor (including data-key resolution from the
 * provider cache and audit recording), reporting p50/p95/max latencies and
 * ops/sec. Run via the repo script: `pnpm ts-benchmark:encryption`.
 */

import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { ColumnEncryptor } from "./columnEncryptor.js";
import { LocalKeyProvider } from "./keyProvider.js";
import { KeyAccessAuditor } from "./audit.js";
import { FieldAccessController } from "./accessControl.js";

export interface BenchmarkOptions {
  /** Number of encrypt+decrypt round trips. */
  iterations?: number;
  /** Payload length in characters approximating a PII value. */
  payloadLength?: number;
  /** Skip data-key minting (KMS/Vault round trip) and profile only the field path. */
  skipKeySetup?: boolean;
}

export interface BenchmarkResult {
  iterations: number;
  totalMs: number;
  opsPerSec: number;
  encrypt: { p50Ms: number; p95Ms: number; maxMs: number; avgMs: number };
  decrypt: { p50Ms: number; p95Ms: number; maxMs: number; avgMs: number };
  /** Passes the issue's <2ms per field acceptance criterion. */
  underBudget: boolean;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
}

export async function runEncryptionBenchmark(
  options: BenchmarkOptions = {}
): Promise<BenchmarkResult> {
  const iterations = options.iterations ?? 1_000;
  const payloadLength = options.payloadLength ?? 64;

  const keyProvider = new LocalKeyProvider({
    secrets: { 1: "benchmark-master-secret-value-32-chars-long!!" },
  });
  const encryptor = new ColumnEncryptor({
    keyProvider,
    config: {
      algorithm: "AES-256-GCM",
      keyProvider: "local",
      keyId: "benchmark",
      keyRotationDays: 90,
    },
    access: new FieldAccessController(),
    audit: new KeyAccessAuditor({ maxRecords: iterations * 2 }),
  });

  const plaintext = "x".repeat(payloadLength);
  const context = { userId: "benchmark-row" };

  // Warm data-key cache (the KMS/Vault envelope round trip happens on first
  // resolution — real services run warm after startup).
  if (options.skipKeySetup !== false) {
    await keyProvider.getDataKey(1);
  }

  const encryptSamples: number[] = [];
  const decryptSamples: number[] = [];

  const start = performance.now();
  for (let i = 0; i < iterations; i += 1) {
    const t0 = performance.now();
    // eslint-disable-next-line no-await-in-loop
    const field = await encryptor.encrypt("users", "email", plaintext, {
      context,
      actorRole: "system",
    });
    encryptSamples.push(performance.now() - t0);

    const t1 = performance.now();
    // eslint-disable-next-line no-await-in-loop
    await encryptor.decrypt("users", "email", field, { context, actorRole: "admin" });
    decryptSamples.push(performance.now() - t1);
  }
  const totalMs = performance.now() - start;

  const encSorted = [...encryptSamples].sort((a, b) => a - b);
  const decSorted = [...decryptSamples].sort((a, b) => a - b);
  const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;

  return {
    iterations,
    totalMs,
    opsPerSec: Math.round((iterations * 2) / (totalMs / 1000)),
    encrypt: {
      p50Ms: percentile(encSorted, 50),
      p95Ms: percentile(encSorted, 95),
      maxMs: encSorted[encSorted.length - 1] ?? 0,
      avgMs: avg(encSorted),
    },
    decrypt: {
      p50Ms: percentile(decSorted, 50),
      p95Ms: percentile(decSorted, 95),
      maxMs: decSorted[decSorted.length - 1] ?? 0,
      avgMs: avg(decSorted),
    },
    underBudget: percentile(decSorted, 95) < 2 && percentile(encSorted, 95) < 2,
  };
}

/** Prints a human-readable table to stdout. */
export async function printEncryptionBenchmark(options: BenchmarkOptions = {}): Promise<void> {
  const result = await runEncryptionBenchmark(options);
  const line = (label: string, m: { p50Ms: number; p95Ms: number; maxMs: number; avgMs: number }) =>
    // eslint-disable-next-line no-console
    console.log(
      `  ${label.padEnd(9)} avg ${m.avgMs.toFixed(3)}ms  p50 ${m.p50Ms.toFixed(3)}ms  ` +
        `p95 ${m.p95Ms.toFixed(3)}ms  max ${m.maxMs.toFixed(3)}ms`
    );

  // eslint-disable-next-line no-console
  console.log(`Encryption benchmark — ${result.iterations} iters on ${options.payloadLength ?? 64}-char PII`);
  line("encrypt", result.encrypt);
  line("decrypt", result.decrypt);
  // eslint-disable-next-line no-console
  console.log(`  ops/sec  ${result.opsPerSec}`);
  // eslint-disable-next-line no-console
  console.log(
    result.underBudget
      ? "  ✓ within the <2ms per-field budget"
      : "  ✗ EXCEEDS the <2ms per-field budget — investigate provider path"
  );
}

// Run directly: `pnpm --filter @delegolabs/utils ts-benchmark:encryption`
const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  void printEncryptionBenchmark().catch((error: unknown) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exitCode = 1;
  });
}
