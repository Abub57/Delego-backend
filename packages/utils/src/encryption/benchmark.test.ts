/**
 * Tests for #68 — encryption performance benchmark and the <2ms budget.
 */
import { describe, it, expect, vi } from "vitest";
import { runEncryptionBenchmark, printEncryptionBenchmark } from "./benchmark.js";

describe("runEncryptionBenchmark", () => {
  it("returns aggregate stats for the requested iterations", async () => {
    const result = await runEncryptionBenchmark({ iterations: 200, payloadLength: 64 });
    expect(result.iterations).toBe(200);
    expect(result.opsPerSec).toBeGreaterThan(0);
    expect(result.encrypt.avgMs).toBeGreaterThan(0);
    expect(result.decrypt.avgMs).toBeGreaterThan(0);
    expect(result.encrypt.maxMs).toBeGreaterThanOrEqual(result.encrypt.p95Ms);
    expect(result.decrypt.maxMs).toBeGreaterThanOrEqual(result.decrypt.p95Ms);
    // The <2ms per-field budget (#68) is a wall-clock measurement, so it is
    // asserted by the dedicated benchmark script — `pnpm --filter
    // @delegolabs/utils ts-benchmark:encryption` — rather than here: in the
    // workspace-wide `pnpm -r test` run this file competes for CPU with every
    // other package and p95 reflects scheduler contention, not the provider path.
  });

  it("always produces p50 <= p95 <= max ordering", async () => {
    const result = await runEncryptionBenchmark({ iterations: 150 });
    for (const group of [result.encrypt, result.decrypt]) {
      expect(group.p50Ms).toBeLessThanOrEqual(group.p95Ms);
      expect(group.p95Ms).toBeLessThanOrEqual(group.maxMs);
    }
  });
});

describe("printEncryptionBenchmark", () => {
  it("prints a human-readable summary", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await printEncryptionBenchmark({ iterations: 100 });
    expect(logSpy).toHaveBeenCalled();
    const rendered = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(rendered).toContain("Encryption benchmark");
    expect(rendered).toContain("encrypt");
    expect(rendered).toContain("decrypt");
    logSpy.mockRestore();
  });
});