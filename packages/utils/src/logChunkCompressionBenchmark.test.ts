/**
 * Benchmark tests for #405 — "Benchmark throughput gains" acceptance
 * criterion. Runs a reduced-size benchmark and asserts the reported
 * throughput numbers are sane, the archives stay valid, and compression
 * actually saves storage on realistic JSON log shapes.
 */
import { describe, it, expect, vi } from "vitest";
import {
  runLogChunkBenchmark,
  printLogChunkBenchmark,
} from "./logChunkCompressionBenchmark.js";

describe("runLogChunkBenchmark", () => {
  it("benchmarks gzip configs with sane throughput and valid round trips", async () => {
    const result = await runLogChunkBenchmark({
      lines: 500,
      gzipLevels: [1, 6],
      zstdLevels: [],
      repetitions: 3,
    });

    expect(result.lines).toBe(500);
    expect(result.rawSizeBytes).toBeGreaterThan(0);
    expect(result.entries.length).toBe(2);
    expect(typeof result.zstdSupported).toBe("boolean");

    for (const entry of result.entries) {
      expect(entry.algorithm).toBe("gzip");
      expect(entry.compressedSizeBytes).toBeLessThan(entry.rawSizeBytes);
      expect(entry.ratio).toBeGreaterThan(0);
      expect(entry.ratio).toBeLessThan(1);
      expect(entry.spaceSaved).toBeGreaterThan(0);
      expect(entry.compressionMs).toBeGreaterThanOrEqual(0);
      expect(entry.decompressionMs).toBeGreaterThanOrEqual(0);
      expect(entry.compressionThroughputMBps).toBeGreaterThan(0);
      expect(entry.decompressionThroughputMBps).toBeGreaterThan(0);
    }

    // Higher gzip level compresses at least as well as the lower one.
    const [low, high] = result.entries;
    expect(high.compressedSizeBytes).toBeLessThanOrEqual(low.compressedSizeBytes);

    expect(result.fastest).toBeDefined();
    expect(result.smallest).toBeDefined();
    expect(result.smallest!.compressedSizeBytes).toBeLessThanOrEqual(result.fastest!.compressedSizeBytes);
  }, 30_000);

  it("includes zstd configs when the runtime supports native zstd", async () => {
    const result = await runLogChunkBenchmark({
      lines: 200,
      gzipLevels: [6],
      zstdLevels: [1],
      repetitions: 1,
    });
    const algorithms = result.entries.map((e) => e.algorithm);
    if (result.zstdSupported) {
      expect(algorithms).toContain("zstd");
      const zstdEntry = result.entries.find((e) => e.algorithm === "zstd")!;
      expect(zstdEntry.compressedSizeBytes).toBeLessThan(zstdEntry.rawSizeBytes);
    } else {
      expect(algorithms).toEqual(["gzip"]);
    }
  });
});

describe("printLogChunkBenchmark", () => {
  it("prints a human-readable summary including per-algorithm rows", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const result = await printLogChunkBenchmark({
      lines: 100,
      gzipLevels: [6],
      zstdLevels: [],
      repetitions: 1,
    });
    expect(logSpy).toHaveBeenCalled();
    const rendered = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(rendered).toContain("Log chunk compression benchmark");
    expect(rendered).toContain("gzip");
    expect(rendered).toContain("fastest");
    expect(result.entries.length).toBe(1);
    logSpy.mockRestore();
  });
});
