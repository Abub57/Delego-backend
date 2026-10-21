/**
 * Integration-ish unit tests for #405 — compressed JSON logging formatter
 * for high-volume ingestion: stream compression of archived log chunks
 * before they are streamed to S3 / CloudWatch.
 *
 * Runs against the public `@delegolabs/utils` surface (black-box), unlike
 * the white-box vitest suites in packages/utils/src.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import {
  compressLogChunk,
  decompressLogChunk,
  verifyLogChunkCompression,
  buildLogChunkArchival,
  isZstdCompressionSupported,
  UnsupportedLogChunkCompressionError,
  DEFAULT_LOG_CHUNK_COMPRESSION_ALGORITHM,
  runLogChunkBenchmark,
} from "@delegolabs/utils";

function makeChunk(lines) {
  const parts = [];
  for (let i = 0; i < lines; i += 1) {
    parts.push(
      JSON.stringify({
        timestamp: new Date(1_700_000_000_000 + i * 5).toISOString(),
        level: "info",
        service: "payments",
        traceId: `trc_${i}`,
        message: "escrow funded",
        fields: { requestId: `req_${i}`, amountStroops: i * 97 },
      }),
    );
  }
  return parts.join("\n");
}

describe("compressLogChunk", () => {
  it("defaults to gzip and emits an archive standard gunzip can read", async () => {
    const raw = makeChunk(100);
    const chunk = await compressLogChunk(raw);

    assert.equal(chunk.algorithm, "gzip");
    assert.equal(DEFAULT_LOG_CHUNK_COMPRESSION_ALGORITHM, "gzip");

    // Decompression validity, cross-checked against zlib itself — the
    // same decompressor S3/CloudWatch-side tooling would use.
    assert.equal(gunzipSync(chunk.data).toString("utf8"), raw);
  });

  it("reports archival sizes matching the buffers", async () => {
    const raw = makeChunk(100);
    const chunk = await compressLogChunk(raw);

    assert.equal(chunk.rawSizeBytes, Buffer.byteLength(raw, "utf8"));
    assert.equal(chunk.compressedSizeBytes, chunk.data.length);
    assert.ok(chunk.compressedSizeBytes < chunk.rawSizeBytes);
    assert.ok(chunk.compressionTimeMs >= 0);
  });

  it("rejects unsupported algorithms", async () => {
    await assert.rejects(
      () => compressLogChunk("x", { algorithm: "brotli" }),
      UnsupportedLogChunkCompressionError,
    );
  });

  it("rejects invalid gzip levels", async () => {
    await assert.rejects(() => compressLogChunk("x", { gzipLevel: 99 }), RangeError);
  });

  it("rejects non-buffer, non-string input", async () => {
    await assert.rejects(() => compressLogChunk(42), TypeError);
  });

  it("handles empty chunks", async () => {
    const chunk = await compressLogChunk("");
    assert.equal(chunk.rawSizeBytes, 0);
    const restored = await decompressLogChunk(chunk.data, chunk.algorithm);
    assert.equal(restored.toString("utf8"), "");
  });
});

describe("decompressLogChunk", () => {
  it("round trips byte-for-byte (decompression validity)", async () => {
    const raw = makeChunk(200);
    for (const algorithm of ["gzip", "zstd"]) {
      if (algorithm === "zstd" && !isZstdCompressionSupported()) continue;
      const compressed = await compressLogChunk(raw, { algorithm });
      const restored = await decompressLogChunk(compressed.data, algorithm);
      assert.ok(restored.equals(Buffer.from(raw, "utf8")), `${algorithm} round trip must match`);
    }
  });

  it("rejects corrupted archives", async () => {
    const corrupted = Buffer.from("this-is-not-a-valid-gzip-stream-000000");
    await assert.rejects(() => decompressLogChunk(corrupted, "gzip"));
  });

  it("rejects truncated archives", async () => {
    const compressed = await compressLogChunk(makeChunk(50));
    const truncated = compressed.data.subarray(0, Math.floor(compressed.data.length / 2));
    await assert.rejects(() => decompressLogChunk(truncated, "gzip"));
  });
});

describe("verifyLogChunkCompression", () => {
  it("reports valid when the round trip restores the exact bytes", async () => {
    const raw = makeChunk(80);
    const verification = await verifyLogChunkCompression(raw);

    assert.equal(verification.valid, true);
    assert.equal(verification.roundTripBytesMatch, true);
    assert.equal(verification.rawSizeBytes, Buffer.byteLength(raw, "utf8"));
    assert.ok(verification.compressedSizeBytes < verification.rawSizeBytes);
  });
});

describe("buildLogChunkArchival", () => {
  it("returns the LogChunkArchival record from the issue schema", async () => {
    const chunk = await compressLogChunk(makeChunk(100));
    const archival = buildLogChunkArchival({ chunkId: "chunk-0001", chunk });

    assert.equal(archival.chunkId, "chunk-0001");
    assert.equal(archival.rawSizeBytes, chunk.rawSizeBytes);
    assert.equal(archival.compressedSizeBytes, chunk.compressedSizeBytes);
    assert.ok(Number.isInteger(archival.rawSizeBytes));
    assert.ok(Number.isInteger(archival.compressedSizeBytes));
    assert.equal(typeof archival.createdAt, "string");
  });

  it("rejects invalid inputs", async () => {
    const chunk = await compressLogChunk(makeChunk(10));
    assert.throws(() => buildLogChunkArchival({ chunkId: "", chunk }), TypeError);
    assert.throws(
      () => buildLogChunkArchival({ chunkId: "c", chunk: { ...chunk, rawSizeBytes: -1 } }),
      TypeError,
    );
  });
});

describe("runLogChunkBenchmark (throughput gains)", () => {
  it("measures compression throughput and validates archives", async () => {
    const result = await runLogChunkBenchmark({
      lines: 500,
      gzipLevels: [1, 6],
      repetitions: 1,
    });

    assert.equal(result.lines, 500);
    assert.ok(result.entries.length >= 2);
    for (const entry of result.entries) {
      assert.ok(entry.compressedSizeBytes < entry.rawSizeBytes);
      assert.ok(entry.compressionThroughputMBps > 0);
      assert.ok(entry.decompressionThroughputMBps > 0);
      assert.ok(entry.spaceSaved > 0 && entry.spaceSaved < 1);
    }
    assert.ok(result.fastest);
    assert.ok(result.smallest);
  });
});
