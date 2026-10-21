import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertSqlIdentifier,
  DEFAULT_ESCROW_ARCHIVER_CONFIG,
  EscrowArchiver,
  EscrowArchiverConfigError,
  InMemoryEscrowArchiveStore,
  msUntilNextRun,
  resolveEscrowArchiverConfig,
  startEscrowArchiveScheduler,
} from "../index.js";
import type {
  ArchiveRunResult,
  EscrowArchiveStore,
  SettledEscrow,
} from "../index.js";

vi.mock("@delegolabs/utils", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-09-27T12:00:00.000Z");

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * DAY_MS).toISOString();
}

function settledEscrow(escrowId: string, days: number, status = "released"): SettledEscrow {
  return {
    escrowId,
    finalStatus: status,
    settledAt: daysAgo(days),
    payload: { escrow_id: escrowId, status, closed_at: daysAgo(days) },
  };
}

function emptyResult(): ArchiveRunResult {
  return {
    pending: 0,
    archived: 0,
    batches: 0,
    skipped: false,
    startedAt: NOW.toISOString(),
    durationMs: 0,
    errors: [],
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("resolveEscrowArchiverConfig", () => {
  it("defaults to a 90 day retention window against escrows -> escrow_archives", () => {
    const config = resolveEscrowArchiverConfig({});

    expect(config.retentionDays).toBe(90);
    expect(config.batchSize).toBe(500);
    expect(config.maxBatches).toBe(20);
    expect(config.sourceTable).toBe("escrows");
    expect(config.archiveTable).toBe("escrow_archives");
    expect(config.sourceColumns).toEqual({
      id: "id",
      escrowId: "escrow_id",
      status: "status",
      closedAt: "closed_at",
    });
    expect(DEFAULT_ESCROW_ARCHIVER_CONFIG.retentionDays).toBe(90);
  });

  it("honours environment overrides", () => {
    const config = resolveEscrowArchiverConfig({
      ESCROW_ARCHIVE_RETENTION_DAYS: "30",
      ESCROW_ARCHIVE_BATCH_SIZE: "25",
      ESCROW_ARCHIVE_MAX_BATCHES: "3",
      ESCROW_ARCHIVE_SOURCE_TABLE: "escrow_state",
      ESCROW_ARCHIVE_CLOSED_AT_COLUMN: "settled_at",
    });

    expect(config.retentionDays).toBe(30);
    expect(config.batchSize).toBe(25);
    expect(config.maxBatches).toBe(3);
    expect(config.sourceTable).toBe("escrow_state");
    expect(config.sourceColumns.closedAt).toBe("settled_at");
  });

  it("rejects a non-numeric retention window", () => {
    expect(() =>
      resolveEscrowArchiverConfig({ ESCROW_ARCHIVE_RETENTION_DAYS: "ninety" })
    ).toThrow(EscrowArchiverConfigError);
  });
});

describe("assertSqlIdentifier", () => {
  it("accepts plain identifiers", () => {
    expect(assertSqlIdentifier("escrow_archives", "table")).toBe("escrow_archives");
  });

  it("rejects identifiers that could widen a statement", () => {
    for (const hostile of ["escrows; DROP TABLE orders", "public.escrows", '"escrows"', "1escrows"]) {
      expect(() => assertSqlIdentifier(hostile, "table")).toThrow(EscrowArchiverConfigError);
    }
  });
});

describe("EscrowArchiver.runOnce", () => {
  it("archives only escrows settled past the retention window", async () => {
    const store = new InMemoryEscrowArchiveStore([
      settledEscrow("E-old-1", 150),
      settledEscrow("E-old-2", 120, "refunded"),
      settledEscrow("E-edge", 91),
      settledEscrow("E-recent", 89),
      settledEscrow("E-live", 10),
    ]);
    const archiver = new EscrowArchiver(store, { retentionDays: 90, batchSize: 10 });

    const result = await archiver.runOnce(NOW);

    expect(result.pending).toBe(3);
    expect(result.archived).toBe(3);
    expect(result.errors).toEqual([]);
    expect(result.skipped).toBe(false);
    expect(store.getLiveEscrows().map((row) => row.escrowId).sort()).toEqual([
      "E-live",
      "E-recent",
    ]);
    expect(store.getArchivedEscrows().map((row) => row.escrowId)).toEqual([
      "E-old-1",
      "E-old-2",
      "E-edge",
    ]);
  });

  it("preserves the full row snapshot in the archive payload", async () => {
    const store = new InMemoryEscrowArchiveStore([settledEscrow("E-1", 200, "released")]);
    const archiver = new EscrowArchiver(store, { retentionDays: 90 });

    await archiver.runOnce(NOW);

    const [archived] = store.getArchivedEscrows();
    expect(archived.finalStatus).toBe("released");
    expect(archived.settledAt).toBe(daysAgo(200));
    expect(archived.archivePayload).toEqual({
      escrow_id: "E-1",
      status: "released",
      closed_at: daysAgo(200),
    });
  });

  it("moves a backlog in bounded batches, oldest first", async () => {
    const store = new InMemoryEscrowArchiveStore([
      settledEscrow("E-3", 120),
      settledEscrow("E-1", 200),
      settledEscrow("E-4", 100),
      settledEscrow("E-2", 150),
      settledEscrow("E-5", 95),
    ]);
    const archiver = new EscrowArchiver(store, { retentionDays: 90, batchSize: 2, maxBatches: 10 });

    const result = await archiver.runOnce(NOW);

    expect(result.pending).toBe(5);
    expect(result.archived).toBe(5);
    expect(result.batches).toBe(3);
    expect(store.getArchivedEscrows().map((row) => row.escrowId)).toEqual([
      "E-1",
      "E-2",
      "E-3",
      "E-4",
      "E-5",
    ]);
  });

  it("stops at maxBatches and defers the remaining backlog to the next run", async () => {
    const store = new InMemoryEscrowArchiveStore([
      settledEscrow("E-1", 200),
      settledEscrow("E-2", 190),
      settledEscrow("E-3", 180),
      settledEscrow("E-4", 170),
    ]);
    const archiver = new EscrowArchiver(store, { retentionDays: 90, batchSize: 1, maxBatches: 2 });

    const first = await archiver.runOnce(NOW);

    expect(first.pending).toBe(4);
    expect(first.archived).toBe(2);
    expect(first.batches).toBe(2);
    expect(store.getLiveEscrows().map((row) => row.escrowId)).toEqual(["E-3", "E-4"]);

    const second = await archiver.runOnce(NOW);

    expect(second.pending).toBe(2);
    expect(second.archived).toBe(2);
    expect(store.getLiveEscrows()).toEqual([]);
  });

  it("is idempotent: a second run finds nothing left to move", async () => {
    const store = new InMemoryEscrowArchiveStore([settledEscrow("E-1", 400)]);
    const archiver = new EscrowArchiver(store, { retentionDays: 90 });

    const first = await archiver.runOnce(NOW);
    const second = await archiver.runOnce(NOW);

    expect(first.archived).toBe(1);
    expect(second.pending).toBe(0);
    expect(second.archived).toBe(0);
    expect(second.batches).toBe(0);
    expect(store.getArchivedEscrows()).toHaveLength(1);
  });

  it("leaves already-archived escrow ids in the live table instead of overwriting them", async () => {
    const store = new InMemoryEscrowArchiveStore([
      settledEscrow("E-dup", 200),
      settledEscrow("E-dup", 180),
    ]);
    const archiver = new EscrowArchiver(store, { retentionDays: 90, batchSize: 10 });

    const result = await archiver.runOnce(NOW);

    expect(result.archived).toBe(1);
    expect(store.getArchivedEscrows()).toHaveLength(1);
    expect(store.getLiveEscrows()).toHaveLength(1);
  });

  it("reports a skipped run when another runner holds the exclusive lock", async () => {
    const store = {
      countSettledBefore: vi.fn().mockResolvedValue(0),
      moveSettledBatch: vi.fn().mockResolvedValue([]),
      runExclusive: vi.fn().mockResolvedValue(null),
    } as unknown as EscrowArchiveStore;
    const archiver = new EscrowArchiver(store);

    const result = await archiver.runOnce(NOW);

    expect(result.skipped).toBe(true);
    expect(result.archived).toBe(0);
    expect(store.countSettledBefore).not.toHaveBeenCalled();
  });

  it("records a batch failure instead of throwing", async () => {
    const store = {
      countSettledBefore: vi.fn().mockResolvedValue(5),
      moveSettledBatch: vi.fn().mockRejectedValue(new Error("deadlock detected")),
      runExclusive: async (run: () => Promise<unknown>) => run(),
    } as unknown as EscrowArchiveStore;
    const archiver = new EscrowArchiver(store);

    const result = await archiver.runOnce(NOW);

    expect(result.errors).toEqual(["deadlock detected"]);
    expect(result.archived).toBe(0);
    expect(result.batches).toBe(0);
  });

  it("rejects an invalid configuration", () => {
    const store = new InMemoryEscrowArchiveStore();
    expect(() => new EscrowArchiver(store, { retentionDays: 0 })).toThrow(
      EscrowArchiverConfigError
    );
    expect(() => new EscrowArchiver(store, { batchSize: -1 })).toThrow(EscrowArchiverConfigError);
  });
});

describe("msUntilNextRun", () => {
  it("returns the delay to the next UTC hour", () => {
    expect(msUntilNextRun(3, new Date("2026-09-27T02:00:00.000Z"))).toBe(60 * 60 * 1000);
    expect(msUntilNextRun(3, new Date("2026-09-27T04:00:00.000Z"))).toBe(23 * 60 * 60 * 1000);
  });

  it("waits a full day when the clock is already on the hour", () => {
    expect(msUntilNextRun(3, new Date("2026-09-27T03:00:00.000Z"))).toBe(24 * 60 * 60 * 1000);
  });

  it("rolls over month and year boundaries", () => {
    const from = new Date("2026-12-31T23:30:00.000Z");
    const delayMs = msUntilNextRun(0, from);
    expect(delayMs).toBe(30 * 60 * 1000);
    expect(new Date(from.getTime() + delayMs).toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });

  it("rejects an out-of-range hour", () => {
    expect(() => msUntilNextRun(24, NOW)).toThrow();
    expect(() => msUntilNextRun(-1, NOW)).toThrow();
  });
});

describe("startEscrowArchiveScheduler", () => {
  it("runs at the configured UTC hour and stops cleanly", async () => {
    vi.useFakeTimers();
    let current = new Date("2026-09-27T02:00:00.000Z");
    const runOnce = vi.fn().mockResolvedValue(emptyResult());
    const archiver = { runOnce } as unknown as EscrowArchiver;

    const stop = startEscrowArchiveScheduler(archiver, { hourUtc: 3, now: () => current });
    expect(runOnce).not.toHaveBeenCalled();

    current = new Date("2026-09-27T03:00:00.000Z");
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(runOnce).toHaveBeenCalledTimes(1);

    stop();
    current = new Date("2026-09-28T03:00:00.000Z");
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(runOnce).toHaveBeenCalledTimes(1);
  });

  it("skips a tick while a previous run is still in flight", async () => {
    vi.useFakeTimers();
    let current = new Date("2026-09-27T02:00:00.000Z");
    const pending = deferred<ArchiveRunResult>();
    const runOnce = vi.fn().mockReturnValue(pending.promise);
    const archiver = { runOnce } as unknown as EscrowArchiver;

    const stop = startEscrowArchiveScheduler(archiver, {
      hourUtc: 3,
      runOnStart: true,
      now: () => current,
    });
    expect(runOnce).toHaveBeenCalledTimes(1);

    current = new Date("2026-09-27T03:00:00.000Z");
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(runOnce).toHaveBeenCalledTimes(1);

    pending.resolve(emptyResult());
    await Promise.resolve();
    stop();
  });
});
