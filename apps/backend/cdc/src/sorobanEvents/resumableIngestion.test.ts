import { describe, it, expect, vi } from "vitest";
import type { Pool } from "pg";
import type { Logger } from "@delegolabs/utils";

import {
  LedgerRetentionGapError,
  ResumableSorobanIngestionWorker,
  SorobanLedgerRpcClient,
  type GetEventsWindowParams,
  type GetEventsWindowResult,
  type LedgerRange,
  type RpcContractEvent,
  type SorobanLedgerRpc,
} from "./resumableIngestion.js";
import {
  InMemoryIngestionCheckpointStore,
  PostgresIngestionCheckpointStore,
  type IngestionCheckpoint,
  type LedgerEvent,
} from "./ingestionCheckpointStore.js";

const CONTRACT = "CESCROW";

const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Zero-padded id so lexicographic order == on-chain order, like real TOIDs. */
function eventId(ledger: number, index: number): string {
  return `${String(ledger).padStart(19, "0")}-${String(index).padStart(10, "0")}`;
}

function rpcEvent(ledger: number, index = 1, contractId = CONTRACT): RpcContractEvent {
  return {
    type: "contract",
    ledger,
    ledgerClosedAt: new Date(Date.UTC(2026, 0, 1) + ledger * 5_000).toISOString(),
    contractId,
    id: eventId(ledger, index),
    topic: ["AAAADwAAAAdyZWxlYXNl"],
    value: "AAAAAQ==",
    inSuccessfulContractCall: true,
    txHash: `tx-${ledger}-${index}`,
  };
}

/**
 * Faithful-enough Soroban RPC: inclusive start, inclusive end (the real
 * client converts to exclusive), cursor = id of the last returned event.
 */
class FakeRpc implements SorobanLedgerRpc {
  readonly calls: GetEventsWindowParams[] = [];
  reversePages = false;

  constructor(public events: RpcContractEvent[], public range: LedgerRange) {}

  async getLedgerRange(): Promise<LedgerRange> {
    return { ...this.range };
  }

  async getEventsWindow(params: GetEventsWindowParams): Promise<GetEventsWindowResult> {
    this.calls.push({ ...params });
    const matching = this.events
      .filter((e) => e.contractId === params.contractId)
      .filter((e) => e.ledger <= params.endLedger)
      .filter((e) => (params.cursor ? e.id > params.cursor : e.ledger >= params.startLedger))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    const page = matching.slice(0, params.limit);
    return {
      events: this.reversePages ? [...page].reverse() : page,
      cursor: page.length > 0 ? page[page.length - 1].id : params.cursor,
    };
  }
}

function makeEvents(spec: Record<number, number>): RpcContractEvent[] {
  return Object.entries(spec).flatMap(([ledger, count]) =>
    Array.from({ length: count }, (_, i) => rpcEvent(Number(ledger), i + 1))
  );
}

function checkpoint(lastProcessedLedger: number, lastEventId = ""): IngestionCheckpoint {
  return { contractId: CONTRACT, lastProcessedLedger, lastEventId, updatedAt: new Date().toISOString() };
}

/**
 * Wraps a store so that after EVERY commit we assert the core guarantee:
 * every event at or below the watermark has been stored.
 */
function assertWatermarkInvariant(store: InMemoryIngestionCheckpointStore, rpc: FakeRpc): void {
  const original = store.commitBatch.bind(store);
  store.commitBatch = async (input) => {
    const result = await original(input);
    const through = result.checkpoint.lastProcessedLedger;
    for (const e of rpc.events.filter((x) => x.contractId === input.contractId && x.ledger <= through)) {
      expect(store.events.has(e.id), `event ${e.id} missing below watermark ${through}`).toBe(true);
    }
    return result;
  };
}

function makeWorker(
  rpc: SorobanLedgerRpc,
  store: InMemoryIngestionCheckpointStore,
  config: { windowSize?: number; pageSize?: number; initialLedger?: number } = {},
  onCommitted?: (contractId: string, events: LedgerEvent[]) => Promise<void>
): ResumableSorobanIngestionWorker {
  return new ResumableSorobanIngestionWorker(
    { rpc, store, onCommitted, logger: silentLogger },
    { contractIds: [CONTRACT], windowSize: 10, pageSize: 3, ...config }
  );
}

// ---------------------------------------------------------------------------
// Resume semantics
// ---------------------------------------------------------------------------

describe("ResumableSorobanIngestionWorker — startup resume", () => {
  it("loads all checkpoints in one query and resumes at lastProcessedLedger + 1", async () => {
    const store = new InMemoryIngestionCheckpointStore();
    store.checkpoints.set(CONTRACT, checkpoint(150, eventId(150, 1)));
    const loadAll = vi.spyOn(store, "loadAll");
    const rpc = new FakeRpc(makeEvents({ 150: 1, 151: 2, 155: 1 }), { oldestLedger: 100, latestLedger: 160 });

    const worker = makeWorker(rpc, store);
    await worker.loadCheckpoints();
    await worker.syncOnce();

    expect(loadAll).toHaveBeenCalledTimes(1);
    expect(loadAll).toHaveBeenCalledWith([CONTRACT]);
    expect(rpc.calls[0].startLedger).toBe(151);
    // The already-committed event at ledger 150 was never re-read.
    expect([...store.processedIds]).toEqual([eventId(151, 1), eventId(151, 2), eventId(155, 1)]);
    expect(store.checkpoints.get(CONTRACT)?.lastProcessedLedger).toBe(160);
  });

  it("starts from initialLedger when no checkpoint exists", async () => {
    const store = new InMemoryIngestionCheckpointStore();
    const rpc = new FakeRpc(makeEvents({ 120: 1, 125: 1 }), { oldestLedger: 100, latestLedger: 130 });

    await makeWorker(rpc, store, { initialLedger: 122 }).syncOnce();

    expect(rpc.calls[0].startLedger).toBe(122);
    expect([...store.processedIds]).toEqual([eventId(125, 1)]);
  });

  it("neither skips nor double-processes across a stop / restart", async () => {
    const store = new InMemoryIngestionCheckpointStore();
    const seen: string[] = [];
    const onCommitted = async (_c: string, events: LedgerEvent[]) => {
      seen.push(...events.map((e) => e.eventId));
    };
    const rpc = new FakeRpc(makeEvents({ 101: 2, 104: 4, 109: 1 }), { oldestLedger: 100, latestLedger: 110 });
    assertWatermarkInvariant(store, rpc);

    await makeWorker(rpc, store, { initialLedger: 100 }, onCommitted).syncOnce();
    expect(store.checkpoints.get(CONTRACT)?.lastProcessedLedger).toBe(110);

    // Worker offline while the chain moves on — including more events in a
    // ledger range the old worker never saw.
    rpc.events.push(...makeEvents({ 111: 3, 118: 2, 125: 5 }));
    rpc.range = { oldestLedger: 100, latestLedger: 126 };

    const restarted = makeWorker(rpc, store, { initialLedger: 100 }, onCommitted);
    await restarted.loadCheckpoints();
    await restarted.syncOnce();

    const expected = rpc.events.map((e) => e.id).sort();
    expect(seen).toEqual(expected);
    expect(new Set(seen).size).toBe(seen.length);
    expect(store.checkpoints.get(CONTRACT)?.lastProcessedLedger).toBe(126);
  });
});

// ---------------------------------------------------------------------------
// Windows, paging and ordering
// ---------------------------------------------------------------------------

describe("ResumableSorobanIngestionWorker — ledger windows", () => {
  it("reads history in bounded windows and advances through empty ones", async () => {
    const store = new InMemoryIngestionCheckpointStore();
    const rpc = new FakeRpc(makeEvents({ 103: 1, 131: 1 }), { oldestLedger: 100, latestLedger: 135 });

    await makeWorker(rpc, store, { initialLedger: 100, windowSize: 10 }).syncOnce();

    const windows = rpc.calls.filter((c) => !c.cursor).map((c) => [c.startLedger, c.endLedger]);
    expect(windows).toEqual([
      [100, 109],
      [110, 119],
      [120, 129],
      [130, 135],
    ]);
    expect(store.checkpoints.get(CONTRACT)?.lastProcessedLedger).toBe(135);
  });

  it("never commits a ledger whose events straddle a page boundary", async () => {
    const store = new InMemoryIngestionCheckpointStore();
    // pageSize 3 and ledger 105 has 5 events → split across pages.
    const rpc = new FakeRpc(makeEvents({ 104: 2, 105: 5, 106: 1 }), { oldestLedger: 100, latestLedger: 108 });
    assertWatermarkInvariant(store, rpc);
    const commits = vi.spyOn(store, "commitBatch");

    await makeWorker(rpc, store, { initialLedger: 100, pageSize: 3 }).syncOnce();

    for (const [input] of commits.mock.calls) {
      const committedLedger105 = input.events.filter((e) => e.ledger === 105).length;
      expect([0, 5]).toContain(committedLedger105);
    }
    expect(store.processedIds.size).toBe(8);
  });

  it("processes events in strict (ledger, eventId) order even if a page arrives unordered", async () => {
    const store = new InMemoryIngestionCheckpointStore();
    const rpc = new FakeRpc(makeEvents({ 101: 3, 102: 2, 107: 3 }), { oldestLedger: 100, latestLedger: 110 });
    rpc.reversePages = true;
    const order: string[] = [];

    await makeWorker(rpc, store, { initialLedger: 100, pageSize: 4 }, async (_c, events) => {
      order.push(...events.map((e) => e.eventId));
    }).syncOnce();

    expect(order).toEqual(rpc.events.map((e) => e.id).sort());
  });

  it("ignores events for other contracts returned by the RPC", async () => {
    const store = new InMemoryIngestionCheckpointStore();
    const rpc = new FakeRpc([rpcEvent(101), rpcEvent(102, 1, "COTHER")], { oldestLedger: 100, latestLedger: 105 });
    rpc.getEventsWindow = async () => ({ events: [rpcEvent(101), rpcEvent(102, 1, "COTHER")] });

    await makeWorker(rpc, store, { initialLedger: 100 }).syncOnce();

    expect([...store.processedIds]).toEqual([eventId(101, 1)]);
  });
});

// ---------------------------------------------------------------------------
// Atomicity and failure handling
// ---------------------------------------------------------------------------

describe("ResumableSorobanIngestionWorker — atomic commits", () => {
  it("rolls back the watermark with the batch when processing fails, then reprocesses exactly once", async () => {
    let failNext = false;
    const processedCounts = new Map<string, number>();
    const store = new InMemoryIngestionCheckpointStore((events) => {
      if (failNext && events.some((e) => e.ledger === 115)) {
        failNext = false;
        throw new Error("simulated crash mid-transaction");
      }
      for (const e of events) processedCounts.set(e.eventId, (processedCounts.get(e.eventId) ?? 0) + 1);
    });
    const rpc = new FakeRpc(makeEvents({ 102: 1, 115: 2, 122: 1 }), { oldestLedger: 100, latestLedger: 125 });
    assertWatermarkInvariant(store, rpc);

    failNext = true;
    const ok = await makeWorker(rpc, store, { initialLedger: 100 }).syncOnce();

    expect(ok).toBe(false);
    // Window 110-119 failed: watermark stays at the end of the last good window.
    expect(store.checkpoints.get(CONTRACT)?.lastProcessedLedger).toBe(109);
    expect(store.events.has(eventId(115, 1))).toBe(false);

    const restarted = makeWorker(rpc, store, { initialLedger: 100 });
    await restarted.loadCheckpoints();
    expect(await restarted.syncOnce()).toBe(true);

    expect([...processedCounts.values()].every((n) => n === 1)).toBe(true);
    expect(processedCounts.size).toBe(4);
    expect(store.checkpoints.get(CONTRACT)?.lastProcessedLedger).toBe(125);
  });

  it("adopts a checkpoint advanced by another writer instead of reprocessing", async () => {
    const store = new InMemoryIngestionCheckpointStore();
    const rpc = new FakeRpc(makeEvents({ 101: 1, 112: 1 }), { oldestLedger: 100, latestLedger: 115 });
    const worker = makeWorker(rpc, store, { initialLedger: 100 });
    await worker.loadCheckpoints();

    // A second replica committed through ledger 113 after we loaded.
    store.checkpoints.set(CONTRACT, checkpoint(113, eventId(112, 1)));
    store.processedIds.add(eventId(101, 1)).add(eventId(112, 1));

    expect(await worker.syncOnce()).toBe(false);
    expect(worker.getStatus()[0].checkpoint?.lastProcessedLedger).toBe(113);

    rpc.calls.length = 0;
    expect(await worker.syncOnce()).toBe(true);
    expect(rpc.calls[0].startLedger).toBe(114);
  });

  it("halts a contract instead of skipping ledgers that fell out of RPC retention", async () => {
    const store = new InMemoryIngestionCheckpointStore();
    store.checkpoints.set(CONTRACT, checkpoint(50));
    const rpc = new FakeRpc(makeEvents({ 120: 1 }), { oldestLedger: 100, latestLedger: 130 });
    const worker = makeWorker(rpc, store);
    await worker.loadCheckpoints();

    await expect(worker.syncContract(CONTRACT, rpc.range)).rejects.toBeInstanceOf(LedgerRetentionGapError);
    expect(await worker.syncOnce()).toBe(false);

    expect(worker.getStatus()[0].state).toBe("halted");
    expect(rpc.calls).toHaveLength(0);
    expect(store.checkpoints.get(CONTRACT)?.lastProcessedLedger).toBe(50);
  });

  it("keeps the commit when the post-commit hook fails", async () => {
    const store = new InMemoryIngestionCheckpointStore();
    const rpc = new FakeRpc(makeEvents({ 101: 1 }), { oldestLedger: 100, latestLedger: 102 });

    const ok = await makeWorker(rpc, store, { initialLedger: 100 }, async () => {
      throw new Error("redis down");
    }).syncOnce();

    expect(ok).toBe(true);
    expect(store.checkpoints.get(CONTRACT)?.lastProcessedLedger).toBe(102);
  });

  it("stops cleanly and resumes from the committed watermark", async () => {
    const store = new InMemoryIngestionCheckpointStore();
    const rpc = new FakeRpc(makeEvents({ 101: 1 }), { oldestLedger: 100, latestLedger: 105 });
    const worker = makeWorker(rpc, store, { initialLedger: 100 });

    await worker.start();
    await vi.waitFor(() => expect(store.checkpoints.get(CONTRACT)?.lastProcessedLedger).toBe(105));
    await worker.stop();

    expect(worker.getStatus()[0].state).toBe("idle");
  });
});

// ---------------------------------------------------------------------------
// PostgreSQL store
// ---------------------------------------------------------------------------

function makeFakePool(opts: {
  stored?: { last_ledger_sequence: number; last_event_id: string };
  alreadyClaimed?: string[];
}) {
  const queries: string[] = [];
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      const text = sql.replace(/\s+/g, " ").trim();
      queries.push(text.split(" ").slice(0, 3).join(" "));
      if (text.includes("FOR UPDATE")) {
        return {
          rows: [{ contract_id: CONTRACT, synced_at: new Date(), ...(opts.stored ?? { last_ledger_sequence: 0, last_event_id: "" }) }],
        };
      }
      if (text.includes("RETURNING event_id")) {
        const ids = (params?.[0] as string[]).filter((id) => !(opts.alreadyClaimed ?? []).includes(id));
        return { rows: ids.map((event_id) => ({ event_id })) };
      }
      return { rows: [] };
    }),
    release: vi.fn(),
  };
  const pool = { connect: vi.fn(async () => client), query: vi.fn() } as unknown as Pool;
  return { pool, client, queries };
}

function ledgerEvent(ledger: number, index = 1): LedgerEvent {
  const raw = rpcEvent(ledger, index);
  return {
    eventId: raw.id,
    contractId: CONTRACT,
    ledger,
    ledgerClosedAt: raw.ledgerClosedAt,
    txHash: raw.txHash,
    topics: raw.topic,
    value: { xdr: raw.value },
    inSuccessfulContractCall: true,
  };
}

describe("PostgresIngestionCheckpointStore", () => {
  it("upserts events, claims ids and advances the watermark inside one transaction", async () => {
    const { pool, client, queries } = makeFakePool({});
    const processor = { process: vi.fn(async () => undefined) };
    const store = new PostgresIngestionCheckpointStore(pool, [processor]);

    const result = await store.commitBatch({
      contractId: CONTRACT,
      expected: null,
      throughLedger: 105,
      events: [ledgerEvent(101), ledgerEvent(104)],
    });

    expect(queries).toEqual([
      "BEGIN",
      "INSERT INTO soroban_event_sync_checkpoints",
      "SELECT contract_id, last_ledger_sequence,",
      "INSERT INTO soroban_contract_events",
      "INSERT INTO soroban_processed_events",
      "UPDATE soroban_event_sync_checkpoints SET",
      "COMMIT",
    ]);
    expect(result.checkpoint).toMatchObject({ lastProcessedLedger: 105, lastEventId: eventId(104, 1) });
    expect(processor.process).toHaveBeenCalledWith(client, [ledgerEvent(101), ledgerEvent(104)]);
    expect(client.release).toHaveBeenCalled();
  });

  it("passes only newly claimed events to processors", async () => {
    const { pool } = makeFakePool({ alreadyClaimed: [eventId(101, 1)] });
    const processor = { process: vi.fn(async () => undefined) };
    const store = new PostgresIngestionCheckpointStore(pool, [processor]);

    const { processed } = await store.commitBatch({
      contractId: CONTRACT,
      expected: null,
      throughLedger: 104,
      events: [ledgerEvent(101), ledgerEvent(104)],
    });

    expect(processed.map((e) => e.eventId)).toEqual([eventId(104, 1)]);
    expect(processor.process).toHaveBeenCalledWith(expect.anything(), [ledgerEvent(104)]);
  });

  it("rolls back and leaves the watermark untouched when a processor throws", async () => {
    const { pool, client, queries } = makeFakePool({});
    const store = new PostgresIngestionCheckpointStore(pool, [
      { process: async () => Promise.reject(new Error("projection failed")) },
    ]);

    await expect(
      store.commitBatch({ contractId: CONTRACT, expected: null, throughLedger: 101, events: [ledgerEvent(101)] })
    ).rejects.toThrow("projection failed");

    expect(queries).toContain("ROLLBACK");
    expect(queries).not.toContain("COMMIT");
    expect(queries.some((q) => q.startsWith("UPDATE"))).toBe(false);
    expect(client.release).toHaveBeenCalled();
  });

  it("rejects the commit when the stored watermark moved (compare-and-set)", async () => {
    const { pool, queries } = makeFakePool({ stored: { last_ledger_sequence: 120, last_event_id: "x" } });
    const store = new PostgresIngestionCheckpointStore(pool);

    await expect(
      store.commitBatch({ contractId: CONTRACT, expected: checkpoint(100), throughLedger: 110, events: [] })
    ).rejects.toMatchObject({ name: "CheckpointConflictError" });
    expect(queries).toContain("ROLLBACK");
  });

  it("refuses out-of-order batches before touching the database", async () => {
    const { pool } = makeFakePool({});
    const store = new PostgresIngestionCheckpointStore(pool);

    await expect(
      store.commitBatch({
        contractId: CONTRACT,
        expected: null,
        throughLedger: 110,
        events: [ledgerEvent(104), ledgerEvent(101)],
      })
    ).rejects.toThrow("strict ledger order");
    expect(pool.connect).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// RPC client
// ---------------------------------------------------------------------------

describe("SorobanLedgerRpcClient", () => {
  function fakeFetch(result: unknown) {
    return vi.fn(async (_url: unknown, _init?: RequestInit) =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 })
    );
  }

  it("sends an inclusive window as startLedger + exclusive endLedger with pagination", async () => {
    const fetchImpl = fakeFetch({ events: [], cursor: "c1" });
    const client = new SorobanLedgerRpcClient("http://rpc", 1_000, fetchImpl as unknown as typeof fetch);

    await client.getEventsWindow({ contractId: CONTRACT, startLedger: 100, endLedger: 199, limit: 50 });

    const body = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
    expect(body.method).toBe("getEvents");
    expect(body.params).toEqual({
      startLedger: 100,
      endLedger: 200,
      filters: [{ type: "contract", contractIds: [CONTRACT] }],
      pagination: { limit: 50 },
    });
  });

  it("omits startLedger when continuing with a cursor", async () => {
    const fetchImpl = fakeFetch({ events: [] });
    const client = new SorobanLedgerRpcClient("http://rpc", 1_000, fetchImpl as unknown as typeof fetch);

    await client.getEventsWindow({ contractId: CONTRACT, startLedger: 100, endLedger: 199, limit: 50, cursor: "abc" });

    const body = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
    expect(body.params.startLedger).toBeUndefined();
    expect(body.params.pagination).toEqual({ limit: 50, cursor: "abc" });
  });

  it("reads the retained ledger range from getHealth", async () => {
    const client = new SorobanLedgerRpcClient(
      "http://rpc",
      1_000,
      fakeFetch({ status: "healthy", latestLedger: 900, oldestLedger: 400 }) as unknown as typeof fetch
    );
    expect(await client.getLedgerRange()).toEqual({ latestLedger: 900, oldestLedger: 400 });
  });

  it("surfaces JSON-RPC errors", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32600, message: "bad range" } }))
    );
    const client = new SorobanLedgerRpcClient("http://rpc", 1_000, fetchImpl as unknown as typeof fetch);
    await expect(client.getLedgerRange()).rejects.toThrow("bad range");
  });
});
