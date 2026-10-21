/**
 * Tests for #405 — compressed JSON logging formatter for high-volume
 * ingestion (stream compression of archived log chunks).
 */
import { describe, it, expect } from "vitest";
import { gunzipSync } from "node:zlib";
import {
  compressLogChunk,
  decompressLogChunk,
  verifyLogChunkCompression,
  buildLogChunkArchival,
  isZstdCompressionSupported,
  LogChunkCompressionError,
  UnsupportedLogChunkCompressionError,
  DEFAULT_LOG_CHUNK_COMPRESSION_ALGORITHM,
  type LogChunkArchival,
} from "./logChunkCompression.js";

function makeChunk(lines: number): string {
  const parts: string[] = [];
  for (let i = 0; i < lines; i += 1) {
    parts.push(
      JSON.stringify({
        timestamp: new Date(1_700_000_000_000 + i * 5).toISOString(),
        level: "info",
        service: "gateway",
        traceId: `trc_${i}`,
        message: "request handled",
        fields: { requestId: `req_${i}`, durationMs: i % 500 },
      }),
    );
  }
  return parts.join("\n");
}

describe("compressLogChunk", () => {
  it("defaults to gzip and produces a valid gzip archive", async () => {
    const raw = makeChunk(100);
    const chunk = await compressLogChunk(raw);
    expect(chunk.algorithm).toBe("gzip");
    expect(DEFAULT_LOG_CHUNK_COMPRESSION_ALGORITHM).toBe("gzip");

    // Cross-check with zlib's own gunzip: the archive must be readable
    // by standard gzip decompressors (S3/CloudWatch-side requirement).
    expect(gunzipSync(chunk.data).toString("utf8")).toBe(raw);
  });

  it("reports raw and compressed sizes that match the buffers", async () => {
    const raw = makeChunk(100);
    const chunk = await compressLogChunk(raw);
    expect(chunk.rawSizeBytes).toBe(Buffer.byteLength(raw));
    expect(chunk.compressedSizeBytes).toBe(chunk.data.length);
    expect(chunk.compressedSizeBytes).toBeLessThan(chunk.rawSizeBytes);
    expect(chunk.ratio).toBeCloseTo(chunk.compressedSizeBytes / chunk.rawSizeBytes, 6);
    expect(chunk.compressionTimeMs).toBeGreaterThanOrEqual(0);
  });

  it("compresses repetitively-structured JSON lines aggressively", async () => {
    const chunk = await compressLogChunk(makeChunk(500));
    // High-volume JSON log lines share keys/shape — expect solid savings.
    expect(chunk.ratio).toBeLessThan(0.5);
  });

  it("accepts Buffer input", async () => {
    const raw = Buffer.from(makeChunk(50), "utf8");
    const chunk = await compressLogChunk(raw, { algorithm: "gzip" });
    expect(chunk.rawSizeBytes).toBe(raw.length);
  });

  it("handles an empty chunk without throwing", async () => {
    const chunk = await compressLogChunk("");
    expect(chunk.rawSizeBytes).toBe(0);
    expect(chunk.ratio).toBe(1);
    const restored = await decompressLogChunk(chunk.data, chunk.algorithm);
    expect(restored.toString("utf8")).toBe("");
  });

  it("handles unicode content round trips", async () => {
    const raw = JSON.stringify({ message: "pago completado ✓ 汉字 🚀" }) + "\n".repeat(10);
    const verification = await verifyLogChunkCompression(raw);
    expect(verification.valid).toBe(true);
  });

  it("rejects unsupported algorithms with UnsupportedLogChunkCompressionError", async () => {
    await expect(
      compressLogChunk("x", { algorithm: "brotli" as never }),
    ).rejects.toBeInstanceOf(UnsupportedLogChunkCompressionError);
    await expect(
      compressLogChunk("x", { algorithm: "brotli" as never }),
    ).rejects.toBeInstanceOf(LogChunkCompressionError);
  });

  it("rejects invalid gzip/zstd levels", async () => {
    await expect(compressLogChunk("x", { gzipLevel: 10 })).rejects.toBeInstanceOf(RangeError);
    await expect(compressLogChunk("x", { gzipLevel: -1 })).rejects.toBeInstanceOf(RangeError);
    await expect(compressLogChunk("x", { zstdLevel: 0 })).rejects.toBeInstanceOf(RangeError);
    await expect(compressLogChunk("x", { zstdLevel: 20 })).rejects.toBeInstanceOf(RangeError);
  });

  it("rejects non-string/non-buffer input with a TypeError", async () => {
    await expect(compressLogChunk(42 as never)).rejects.toBeInstanceOf(TypeError);
  });

  it("supports zstd when the runtime ships native zstd streams", async () => {
    if (!isZstdCompressionSupported()) {
      // Older Node runtimes without native zstd: the error path must be
      // an UnsupportedLogChunkCompressionError, not a crash.
      await expect(compressLogChunk("x", { algorithm: "zstd" })).rejects.toBeInstanceOf(
        UnsupportedLogChunkCompressionError,
      );
      return;
    }

    const raw = makeChunk(200);
    const chunk = await compressLogChunk(raw, { algorithm: "zstd", zstdLevel: 3 });
    expect(chunk.algorithm).toBe("zstd");
    expect(chunk.compressedSizeBytes).toBeLessThan(chunk.rawSizeBytes);

    const restored = await decompressLogChunk(chunk.data, "zstd");
    expect(restored.toString("utf8")).toBe(raw);
  });
});

describe("decompressLogChunk", () => {
  it("round trips gzip byte-for-byte", async () => {
    const raw = makeChunk(120);
    const compressed = await compressLogChunk(raw, { algorithm: "gzip" });
    const restored = await decompressLogChunk(compressed.data, "gzip");
    expect(restored.equals(Buffer.from(raw, "utf8"))).toBe(true);
  });

  it("rejects corrupted gzip payloads with LogChunkCompressionError", async () => {
    const corrupted = Buffer.from("definitely-not-gzip-data-0123456789");
    await expect(decompressLogChunk(corrupted, "gzip")).rejects.toBeInstanceOf(
      LogChunkCompressionError,
    );
  });

  it("rejects truncated gzip payloads", async () => {
    const compressed = await compressLogChunk(makeChunk(50));
    const truncated = compressed.data.subarray(0, Math.floor(compressed.data.length / 2));
    await expect(decompressLogChunk(truncated, "gzip")).rejects.toBeInstanceOf(
      LogChunkCompressionError,
    );
  });

  it("rejects non-Buffer data with a TypeError", async () => {
    await expect(decompressLogChunk("nope" as never, "gzip")).rejects.toBeInstanceOf(TypeError);
  });

  it("rejects unsupported algorithms", async () => {
    await expect(decompressLogChunk(Buffer.from("x"), "lz4" as never)).rejects.toBeInstanceOf(
      UnsupportedLogChunkCompressionError,
    );
  });
});

describe("verifyLogChunkCompression", () => {
  it("verifies a valid gzip round trip", async () => {
    const raw = makeChunk(80);
    const verification = await verifyLogChunkCompression(raw);
    expect(verification.valid).toBe(true);
    expect(verification.roundTripBytesMatch).toBe(true);
    expect(verification.algorithm).toBe("gzip");
    expect(verification.rawSizeBytes).toBe(Buffer.byteLength(raw));
    expect(verification.compressedSizeBytes).toBeLessThan(verification.rawSizeBytes);
    expect(verification.compressionTimeMs).toBeGreaterThanOrEqual(0);
    expect(verification.decompressionTimeMs).toBeGreaterThanOrEqual(0);
  });

  it("verifies zstd round trips when supported", async () => {
    if (!isZstdCompressionSupported()) return;
    const verification = await verifyLogChunkCompression(makeChunk(80), {
      algorithm: "zstd",
    });
    expect(verification.valid).toBe(true);
    expect(verification.algorithm).toBe("zstd");
  });
});

describe("buildLogChunkArchival", () => {
  it("builds the LogChunkArchival record from the issue's schema", async () => {
    const raw = makeChunk(100);
    const chunk = await compressLogChunk(raw);
    const archival = buildLogChunkArchival({
      chunkId: "chunk-2026-09-28-0001",
      chunk,
    });

    // Exactly the fields the issue's Data Types & Schemas declares.
    const expectedKeys: ReadonlyArray<keyof LogChunkArchival> = [
      "chunkId",
      "compressedSizeBytes",
      "rawSizeBytes",
    ];
    expect(Object.keys(archival)).toEqual(expect.arrayContaining(expectedKeys));
    expect(archival.chunkId).toBe("chunk-2026-09-28-0001");
    expect(archival.rawSizeBytes).toBe(chunk.rawSizeBytes);
    expect(archival.compressedSizeBytes).toBe(chunk.compressedSizeBytes);

    // Extended context fields.
    expect(archival.algorithm).toBe("gzip");
    expect(archival.compressionTimeMs).toBeGreaterThanOrEqual(0);
    expect(archival.ratio).toBeCloseTo(chunk.ratio, 6);
    expect(() => new Date(archival.createdAt).toISOString()).not.toThrow();
  });

  it("rejects empty chunkIds", () => {
    expect(() =>
      buildLogChunkArchival({
        chunkId: "   ",
        chunk: { rawSizeBytes: 1, compressedSizeBytes: 1, algorithm: "gzip", compressionTimeMs: 0, ratio: 1 },
      }),
    ).toThrow(TypeError);
  });

  it("rejects negative or non-integer sizes", () => {
    const base = { algorithm: "gzip" as const, compressionTimeMs: 0, ratio: 1 };
    expect(() =>
      buildLogChunkArchival({ chunkId: "c", chunk: { ...base, rawSizeBytes: -1, compressedSizeBytes: 1 } }),
    ).toThrow(TypeError);
    expect(() =>
      buildLogChunkArchival({ chunkId: "c", chunk: { ...base, rawSizeBytes: 1, compressedSizeBytes: 1.5 } }),
    ).toThrow(TypeError);
  });
});
