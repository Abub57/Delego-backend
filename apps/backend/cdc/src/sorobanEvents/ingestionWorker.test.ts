/**
 * Tests for Issue #366 — Soroban RPC Event Listener with Missed-Ledger Backfill
 *
 * Covers:
 *   - Startup backfill from PostgreSQL checkpoint
 *   - Deduplication prevents double-publishing
 *   - No events lost across restarts (checkpoint persistence)
 *   - Checkpoint advances after each batch
 *   - Redis cursor falls back to PostgreSQL checkpoint when missing
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Redis } from "ioredis";

import {
  SorobanEventIngestionWorker,
  SorobanRpcClient,
  CursorStore,
  normalizeEvent,
  type RawSorobanEvent,
  type SorobanRpcConfig,
} from "./ingestionWorker.js";
import {
  InMemoryCheckpointStore,
  InMemoryProcessedEventStore,
} from "./checkpointStore.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRawEvent(overrides: Partial<RawSorobanEvent> = {}): RawSorobanEvent {
  return {
    type: "contract",
    ledger: 100,
    ledgerClosedAt: "2024-01-01T00:00:00Z",
    contractId: "CABC123",
    id: "event-001",
    pagingToken: "token-001",
    topic: ['"deposit"'],
    value: { str: JSON.stringify({ amount: "1000" }) },
    inSuccessfulContractCall: true,
    txHash: "abc123",
    ...overrides,
  };
}

function makeRpcClient(
  pages: Array<{
    events: RawSorobanEvent[];
    cursor: string;
    latestLedger: number;
  }>
): SorobanRpcClient {
  let callCount = 0;
  const client = new SorobanRpcClient("http://fake-rpc");
  vi.spyOn(client, "getEvents").mockImplementation(async () => {
    const page = pages[callCount] ?? { events: [], cursor: "", latestLedger: 0 };
    callCount++;
    return page;
  });
  return client;
}

function makeFakeRedis(): Redis {
  const store = new Map<string, Record<string, string>>();
  const streams = new Map<string, Array<{ id: string; fields: Record<string, string> }>>();

  return {
    hset: vi.fn(async (key: string, fields: Record<string, string>) => {
      store.set(key, { ...(store.get(key) ?? {}), ...fields });
      return 1;
    }),
    hgetall: vi.fn(async (key: string) => store.get(key) ?? null),
    del: vi.fn(async (key: string) => {
      store.delete(key);
      return 1;
    }),
    xadd: vi.fn(async (streamKey: string, _id: string, ...fieldValues: string[]) => {
      const fields: Record<string, string> = {};
      for (let i = 0; i < fieldValues.length; i += 2) {
        fields[fieldValues[i]] = fieldValues[i + 1];
      }
      const entries = streams.get(streamKey) ?? [];
      const id = `${Date.now()}-${entries.length}`;
      entries.push({ id, fields });
      streams.set(streamKey, entries);
      return id;
    }),
    _getStream: (key: string) => streams.get(key) ?? [],
  } as unknown as Redis;
}

const BASE_CONFIG: SorobanRpcConfig = {
  rpcUrl: "http://fake-rpc",
  contractIds: ["CABC123"],
  pollIntervalMs: 99999, // prevent auto-polling in tests
  pageSize: 10,
};

// ---------------------------------------------------------------------------
// Unit tests: normalizeEvent
// ---------------------------------------------------------------------------

describe("normalizeEvent", () => {
  it("extracts topic from first XDR topic field", () => {
    const raw = makeRawEvent({ topic: ['"release"', '"extra"'] });
    const normalized = normalizeEvent(raw);
    expect(normalized.topic).toBe("release");
  });

  it("defaults topic to 'unknown' when topic array is empty", () => {
    const raw = makeRawEvent({ topic: [] });
    const normalized = normalizeEvent(raw);
    expect(normalized.topic).toBe("unknown");
  });

  it("parses JSON value from str field", () => {
    const raw = makeRawEvent({ value: { str: '{"amount":"500"}' } });
    const normalized = normalizeEvent(raw);
    expect(normalized.data).toEqual({ amount: "500" });
  });

  it("stores XDR value as-is", () => {
    const raw = makeRawEvent({ value: { xdr: "AAAAAQAAAA==" } });
    const normalized = normalizeEvent(raw);
    expect(normalized.data).toEqual({ xdr: "AAAAAQAAAA==" });
  });

  it("carries the Soroban event id (dedup key)", () => {
    const raw = makeRawEvent({ id: "ledger-0001-event-003" });
    const normalized = normalizeEvent(raw);
    expect(normalized.eventId).toBe("ledger-0001-event-003");
  });
});

// ---------------------------------------------------------------------------
// Unit tests: CheckpointStore (in-memory)
// ---------------------------------------------------------------------------

describe("InMemoryCheckpointStore", () => {
  it("returns null for unknown contract", async () => {
    const store = new InMemoryCheckpointStore();
    expect(await store.get("UNKNOWN")).toBeNull();
  });

  it("stores and retrieves a checkpoint", async () => {
    const store = new InMemoryCheckpointStore();
    const checkpoint = {
      lastLedgerSequence: 500,
      lastEventId: "evt-42",
      syncedAt: new Date("2024-01-01T00:00:00Z"),
    };
    await store.set("CONTRACT_A", checkpoint);
    const loaded = await store.get("CONTRACT_A");
    expect(loaded?.lastLedgerSequence).toBe(500);
    expect(loaded?.lastEventId).toBe("evt-42");
  });

  it("overwrites an existing checkpoint with a newer one", async () => {
    const store = new InMemoryCheckpointStore();
    await store.set("C1", { lastLedgerSequence: 100, lastEventId: "e1", syncedAt: new Date() });
    await store.set("C1", { lastLedgerSequence: 200, lastEventId: "e2", syncedAt: new Date() });
    const loaded = await store.get("C1");
    expect(loaded?.lastLedgerSequence).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Unit tests: InMemoryProcessedEventStore
// ---------------------------------------------------------------------------

describe("InMemoryProcessedEventStore", () => {
  it("returns false for an unpublished event id", async () => {
    const store = new InMemoryProcessedEventStore();
    expect(await store.has("evt-999")).toBe(false);
  });

  it("returns true after marking an event published", async () => {
    const store = new InMemoryProcessedEventStore();
    await store.markPublished("evt-001", "CONTRACT", 100);
    expect(await store.has("evt-001")).toBe(true);
  });

  it("is idempotent — marking twice keeps size at 1", async () => {
    const store = new InMemoryProcessedEventStore();
    await store.markPublished("evt-001", "CONTRACT", 100);
    await store.markPublished("evt-001", "CONTRACT", 100);
    expect(store.size()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Integration tests: deduplication (Issue #366 acceptance criterion)
// ---------------------------------------------------------------------------

describe("SorobanEventIngestionWorker — deduplication", () => {
  it("publishes a new event exactly once", async () => {
    const redis = makeFakeRedis();
    const event = makeRawEvent({ id: "evt-fresh" });
    const rpcClient = makeRpcClient([
      { events: [event], cursor: "cursor-1", latestLedger: 101 },
      { events: [], cursor: "", latestLedger: 101 },
    ]);

    const checkpointStore = new InMemoryCheckpointStore();
    const processedEventStore = new InMemoryProcessedEventStore();

    const worker = new SorobanEventIngestionWorker(redis, BASE_CONFIG, {
      rpcClient,
      checkpointStore,
      processedEventStore,
    });

    const published = await worker.ingestContract("CABC123");
    expect(published).toBe(1);
    expect(processedEventStore.size()).toBe(1);

    // Verify XADD was called with the event id field
    const xaddCalls = (redis.xadd as ReturnType<typeof vi.fn>).mock.calls;
    expect(xaddCalls.length).toBe(1);
    expect(xaddCalls[0]).toContain("evt-fresh");
  });

  it("skips an event that was already published (duplicate delivery)", async () => {
    const redis = makeFakeRedis();
    const event = makeRawEvent({ id: "evt-duplicate" });
    const rpcClient = makeRpcClient([
      { events: [event], cursor: "", latestLedger: 101 },
    ]);

    const checkpointStore = new InMemoryCheckpointStore();
    const processedEventStore = new InMemoryProcessedEventStore();
    // Pre-populate dedup store — simulates a previous run that published this event
    await processedEventStore.markPublished("evt-duplicate", "CABC123", 100);

    const worker = new SorobanEventIngestionWorker(redis, BASE_CONFIG, {
      rpcClient,
      checkpointStore,
      processedEventStore,
    });

    const published = await worker.ingestContract("CABC123");
    expect(published).toBe(0); // duplicate was skipped
    // XADD must not have been called
    expect((redis.xadd as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it("publishes only new events when a batch mixes new and duplicate ids", async () => {
    const redis = makeFakeRedis();
    const events = [
      makeRawEvent({ id: "evt-old", ledger: 98 }),
      makeRawEvent({ id: "evt-new", ledger: 99 }),
    ];
    const rpcClient = makeRpcClient([
      { events, cursor: "", latestLedger: 99 },
    ]);

    const processedEventStore = new InMemoryProcessedEventStore();
    await processedEventStore.markPublished("evt-old", "CABC123", 98);

    const worker = new SorobanEventIngestionWorker(redis, BASE_CONFIG, {
      rpcClient,
      checkpointStore: new InMemoryCheckpointStore(),
      processedEventStore,
    });

    const published = await worker.ingestContract("CABC123");
    expect(published).toBe(1); // only evt-new
    expect(processedEventStore.size()).toBe(2); // both now recorded
  });
});

// ---------------------------------------------------------------------------
// Integration tests: missed-ledger backfill (Issue #366 acceptance criterion)
// ---------------------------------------------------------------------------

describe("SorobanEventIngestionWorker — missed-ledger backfill", () => {
  it("skips backfill when no checkpoint exists (first run)", async () => {
    const redis = makeFakeRedis();
    const rpcClient = makeRpcClient([]);
    const getEventsSpy = vi.spyOn(rpcClient, "getEvents");

    const worker = new SorobanEventIngestionWorker(redis, BASE_CONFIG, {
      rpcClient,
      checkpointStore: new InMemoryCheckpointStore(),
      processedEventStore: new InMemoryProcessedEventStore(),
    });

    await worker.backfillContract("CABC123");
    // RPC should not have been called since there is no starting point
    expect(getEventsSpy).not.toHaveBeenCalled();
  });

  it("backfills events from the checkpoint ledger on restart", async () => {
    const redis = makeFakeRedis();

    // Simulate a checkpoint from the last run
    const checkpointStore = new InMemoryCheckpointStore();
    await checkpointStore.set("CABC123", {
      lastLedgerSequence: 500,
      lastEventId: "evt-500",
      syncedAt: new Date(),
    });

    // The RPC returns 2 missed events then an empty page
    const missedEvents = [
      makeRawEvent({ id: "evt-501", ledger: 501 }),
      makeRawEvent({ id: "evt-502", ledger: 502 }),
    ];
    const rpcClient = makeRpcClient([
      { events: missedEvents, cursor: "", latestLedger: 502 },
      // empty page → backfill terminates
    ]);

    const processedEventStore = new InMemoryProcessedEventStore();
    const worker = new SorobanEventIngestionWorker(redis, BASE_CONFIG, {
      rpcClient,
      checkpointStore,
      processedEventStore,
    });

    const count = await worker.backfillContract("CABC123");
    expect(count).toBe(2);
    expect(processedEventStore.size()).toBe(2);
    // Checkpoint should be advanced to the latest ledger
    const cp = await checkpointStore.get("CABC123");
    expect(cp?.lastLedgerSequence).toBe(502);
  });

  it("deduplicates events during backfill (event already published)", async () => {
    const redis = makeFakeRedis();

    const checkpointStore = new InMemoryCheckpointStore();
    await checkpointStore.set("CABC123", {
      lastLedgerSequence: 200,
      lastEventId: "evt-200",
      syncedAt: new Date(),
    });

    const processedEventStore = new InMemoryProcessedEventStore();
    // evt-201 was published in a previous partial run before the crash
    await processedEventStore.markPublished("evt-201", "CABC123", 201);

    const missedEvents = [
      makeRawEvent({ id: "evt-201", ledger: 201 }),
      makeRawEvent({ id: "evt-202", ledger: 202 }),
    ];
    const rpcClient = makeRpcClient([
      { events: missedEvents, cursor: "", latestLedger: 202 },
    ]);

    const worker = new SorobanEventIngestionWorker(redis, BASE_CONFIG, {
      rpcClient,
      checkpointStore,
      processedEventStore,
    });

    const count = await worker.backfillContract("CABC123");
    // Only evt-202 is new; evt-201 was skipped
    expect(count).toBe(1);
    expect((redis.xadd as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it("takes the higher of Postgres and Redis ledger sequences on restart", async () => {
    const redis = makeFakeRedis();

    // Redis cursor is higher (Redis was alive longer before crash)
    const cursorStore = new CursorStore(redis);
    await cursorStore.saveCursor({
      contractId: "CABC123",
      lastLedgerSequence: 800,
      cursorToken: "cursor-800",
    });

    // Postgres checkpoint is lower (less frequently flushed)
    const checkpointStore = new InMemoryCheckpointStore();
    await checkpointStore.set("CABC123", {
      lastLedgerSequence: 750,
      lastEventId: "evt-750",
      syncedAt: new Date(),
    });

    const rpcClient = makeRpcClient([
      { events: [], cursor: "", latestLedger: 801 },
    ]);
    const getEventsSpy = vi.spyOn(rpcClient, "getEvents");

    const worker = new SorobanEventIngestionWorker(redis, BASE_CONFIG, {
      rpcClient,
      cursorStore,
      checkpointStore,
      processedEventStore: new InMemoryProcessedEventStore(),
    });

    await worker.backfillContract("CABC123");

    // Should start from ledger 800 (the higher value), not 750
    const call = getEventsSpy.mock.calls[0];
    expect(call[0].startLedger).toBe(800);
  });

  it("pages through multiple RPC pages during backfill", async () => {
    const redis = makeFakeRedis();
    const checkpointStore = new InMemoryCheckpointStore();
    await checkpointStore.set("CABC123", {
      lastLedgerSequence: 100,
      lastEventId: "evt-100",
      syncedAt: new Date(),
    });

    // 3 full pages (10 events each) then an empty page
    const makePageEvents = (startId: number, count: number) =>
      Array.from({ length: count }, (_, i) =>
        makeRawEvent({ id: `evt-${startId + i}`, ledger: startId + i })
      );

    const rpcClient = makeRpcClient([
      { events: makePageEvents(101, 10), cursor: "cursor-110", latestLedger: 110 },
      { events: makePageEvents(111, 10), cursor: "cursor-120", latestLedger: 120 },
      { events: makePageEvents(121, 10), cursor: "cursor-130", latestLedger: 130 },
      { events: [], cursor: "", latestLedger: 130 },
    ]);

    const processedEventStore = new InMemoryProcessedEventStore();
    const worker = new SorobanEventIngestionWorker(redis, BASE_CONFIG, {
      rpcClient,
      checkpointStore,
      processedEventStore,
    });

    const count = await worker.backfillContract("CABC123");
    expect(count).toBe(30);
    expect(processedEventStore.size()).toBe(30);
  });

  it("advances checkpoint after each page so a crash mid-backfill resumes correctly", async () => {
    const redis = makeFakeRedis();
    const checkpointStore = new InMemoryCheckpointStore();
    await checkpointStore.set("CABC123", {
      lastLedgerSequence: 100,
      lastEventId: "evt-100",
      syncedAt: new Date(),
    });

    const page1 = Array.from({ length: 10 }, (_, i) =>
      makeRawEvent({ id: `evt-${101 + i}`, ledger: 101 + i })
    );
    const page2 = Array.from({ length: 5 }, (_, i) =>
      makeRawEvent({ id: `evt-${111 + i}`, ledger: 111 + i })
    );

    // page2 has fewer than pageSize events → terminates backfill
    const rpcClient = makeRpcClient([
      { events: page1, cursor: "cursor-110", latestLedger: 110 },
      { events: page2, cursor: "cursor-115", latestLedger: 115 },
    ]);

    const worker = new SorobanEventIngestionWorker(redis, BASE_CONFIG, {
      rpcClient,
      checkpointStore,
      processedEventStore: new InMemoryProcessedEventStore(),
    });

    await worker.backfillContract("CABC123");

    // Checkpoint must be at ledger 115 (the last page's latestLedger)
    const cp = await checkpointStore.get("CABC123");
    expect(cp?.lastLedgerSequence).toBe(115);
  });
});

// ---------------------------------------------------------------------------
// Integration tests: checkpoint persistence across ingestContract cycles
// ---------------------------------------------------------------------------

describe("SorobanEventIngestionWorker — checkpoint persistence", () => {
  it("advances the PostgreSQL checkpoint after a normal ingest cycle", async () => {
    const redis = makeFakeRedis();
    const checkpointStore = new InMemoryCheckpointStore();
    const event = makeRawEvent({ id: "evt-1000", ledger: 1000 });
    const rpcClient = makeRpcClient([
      { events: [event], cursor: "tok-1000", latestLedger: 1000 },
    ]);

    const worker = new SorobanEventIngestionWorker(redis, BASE_CONFIG, {
      rpcClient,
      checkpointStore,
      processedEventStore: new InMemoryProcessedEventStore(),
    });

    await worker.ingestContract("CABC123");

    const cp = await checkpointStore.get("CABC123");
    expect(cp?.lastLedgerSequence).toBe(1000);
    expect(cp?.lastEventId).toBe("evt-1000");
  });

  it("falls back to PostgreSQL checkpoint when Redis cursor is missing", async () => {
    const redis = makeFakeRedis();
    const checkpointStore = new InMemoryCheckpointStore();
    await checkpointStore.set("CABC123", {
      lastLedgerSequence: 300,
      lastEventId: "evt-300",
      syncedAt: new Date(),
    });

    // Redis has no cursor for this contract
    const rpcClient = makeRpcClient([
      { events: [], cursor: "", latestLedger: 300 },
    ]);
    const getEventsSpy = vi.spyOn(rpcClient, "getEvents");

    const worker = new SorobanEventIngestionWorker(redis, BASE_CONFIG, {
      rpcClient,
      checkpointStore,
      processedEventStore: new InMemoryProcessedEventStore(),
    });

    await worker.ingestContract("CABC123");

    // The RPC should have been called with startLedger = 300 (from Postgres)
    expect(getEventsSpy.mock.calls[0][0].startLedger).toBe(300);
  });
});

// ---------------------------------------------------------------------------
// Integration tests: getCheckpoint / getCursor helpers
// ---------------------------------------------------------------------------

describe("SorobanEventIngestionWorker — monitoring helpers", () => {
  it("getCheckpoint returns null for an unknown contract", async () => {
    const redis = makeFakeRedis();
    const worker = new SorobanEventIngestionWorker(redis, BASE_CONFIG, {
      rpcClient: makeRpcClient([]),
      checkpointStore: new InMemoryCheckpointStore(),
      processedEventStore: new InMemoryProcessedEventStore(),
    });

    expect(await worker.getCheckpoint("UNKNOWN")).toBeNull();
  });

  it("getCheckpoint returns the stored checkpoint", async () => {
    const redis = makeFakeRedis();
    const checkpointStore = new InMemoryCheckpointStore();
    await checkpointStore.set("CABC123", {
      lastLedgerSequence: 42,
      lastEventId: "evt-42",
      syncedAt: new Date(),
    });

    const worker = new SorobanEventIngestionWorker(redis, BASE_CONFIG, {
      rpcClient: makeRpcClient([]),
      checkpointStore,
      processedEventStore: new InMemoryProcessedEventStore(),
    });

    const cp = await worker.getCheckpoint("CABC123");
    expect(cp?.lastLedgerSequence).toBe(42);
  });
});
