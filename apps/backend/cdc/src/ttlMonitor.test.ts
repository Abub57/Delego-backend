import { describe, expect, it, vi } from "vitest";
import {
  TTL_EXTENSION_THRESHOLD_LEDGERS,
  buildExtendFootprintTtlJob,
  monitorExpiringFootprints,
  normalizeContractTtlStatus,
} from "./ttlMonitor.js";

describe("ttlMonitor", () => {
  it("identifies entries approaching expiration", () => {
    const status = normalizeContractTtlStatus(
      "C123",
      "storage-key-1",
      250,
      { liveUntilLedgerSeq: 4_900 }
    );

    expect(status).toMatchObject({
      contractAddress: "C123",
      storageKey: "storage-key-1",
      liveUntilLedger: 4_900,
      currentLedger: 250,
      ledgersRemaining: 4_650,
      requiresExtension: true,
    });
    expect(status.requiresExtension).toBe(status.ledgersRemaining < TTL_EXTENSION_THRESHOLD_LEDGERS);
  });

  it("enqueues an extend_footprint_ttl job with a rent fee", () => {
    const status = normalizeContractTtlStatus(
      "C123",
      "storage-key-2",
      100,
      { liveUntilLedgerSeq: 4_100 }
    );

    const job = buildExtendFootprintTtlJob(status);

    expect(job.operation).toBe("extend_footprint_ttl");
    expect(job.ledgersRemaining).toBeLessThan(TTL_EXTENSION_THRESHOLD_LEDGERS);
    expect(job.rentFee).toBeGreaterThan(0);
    expect(job.source).toBe("ttlMonitor");
  });

  it("checks provided ledger entries and triggers an extension queue item", async () => {
    const enqueue = vi.fn().mockResolvedValue({ ok: true });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        result: {
          entries: [
            { key: "storage-key-3", liveUntilLedgerSeq: 3_500 },
          ],
        },
      }),
    });

    const statuses = await monitorExpiringFootprints("C456", ["storage-key-3"], {
      currentLedger: 1_000,
      enqueue,
      fetchImpl: fetchMock as typeof fetch,
      rpcUrl: "https://example.test",
    });

    expect(statuses).toHaveLength(1);
    expect(statuses[0].requiresExtension).toBe(true);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0][0]).toMatchObject({
      operation: "extend_footprint_ttl",
      contractAddress: "C456",
      storageKey: "storage-key-3",
    });
    expect(enqueue.mock.calls[0][0].rentFee).toBeGreaterThan(0);
  });
});
