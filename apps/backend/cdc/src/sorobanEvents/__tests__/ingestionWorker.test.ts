import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { normalizeEvent, CursorStore, SorobanEventIngestionWorker, RawSorobanEvent } from "../ingestionWorker.js";

vi.mock("@delegolabs/utils", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const mockRedis = {
  hset: vi.fn(),
  hgetall: vi.fn(),
  del: vi.fn(),
  xadd: vi.fn(),
};

describe("normalizeEvent", () => {
  it("should normalize a raw Soroban event", () => {
    const raw: RawSorobanEvent = {
      type: "contract",
      ledger: 12345,
      ledgerClosedAt: "2026-09-25T10:00:00Z",
      contractId: "CBXYZ...",
      id: "event-1",
      pagingToken: "tok-1",
      topic: ["deposit"],
      value: { xdr: "AAAAAAA" },
      inSuccessfulContractCall: true,
      txHash: "abc123",
    };

    const result = normalizeEvent(raw);

    expect(result.contractId).toBe("CBXYZ...");
    expect(result.topic).toBe("deposit");
    expect(result.ledger).toBe(12345);
    expect(result.txHash).toBe("abc123");
    expect(result.timestamp).toBe("2026-09-25T10:00:00Z");
    expect(result.data).toEqual({ xdr: "AAAAAAA" });
  });

  it("should handle string value as JSON", () => {
    const raw: RawSorobanEvent = {
      type: "contract",
      ledger: 100,
      ledgerClosedAt: "2026-09-25T10:00:00Z",
      contractId: "CB1",
      id: "e1",
      pagingToken: "t1",
      topic: ["release"],
      value: { str: '{"amount":"1000","asset":"USDC"}' },
      inSuccessfulContractCall: true,
      txHash: "hash1",
    };

    const result = normalizeEvent(raw);
    expect(result.data).toEqual({ amount: "1000", asset: "USDC" });
  });

  it("should handle non-JSON string value", () => {
    const raw: RawSorobanEvent = {
      type: "contract",
      ledger: 100,
      ledgerClosedAt: "2026-09-25T10:00:00Z",
      contractId: "CB1",
      id: "e1",
      pagingToken: "t1",
      topic: ["dispute"],
      value: { str: "raw text data" },
      inSuccessfulContractCall: true,
      txHash: "hash1",
    };

    const result = normalizeEvent(raw);
    expect(result.data).toEqual({ raw: "raw text data" });
  });

  it("should handle empty topics", () => {
    const raw: RawSorobanEvent = {
      type: "contract",
      ledger: 100,
      ledgerClosedAt: "2026-09-25T10:00:00Z",
      contractId: "CB1",
      id: "e1",
      pagingToken: "t1",
      topic: [],
      value: {},
      inSuccessfulContractCall: true,
      txHash: "hash1",
    };

    const result = normalizeEvent(raw);
    expect(result.topic).toBe("unknown");
  });
});

describe("CursorStore", () => {
  let store: CursorStore;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new CursorStore(mockRedis as any);
  });

  it("should save cursor to Redis", async () => {
    await store.saveCursor({
      contractId: "CB1",
      lastLedgerSequence: 5000,
      cursorToken: "tok-abc",
    });

    expect(mockRedis.hset).toHaveBeenCalledWith(
      "soroban:cursor:CB1",
      expect.objectContaining({
        lastLedgerSequence: "5000",
        cursorToken: "tok-abc",
      }),
    );
  });

  it("should load cursor from Redis", async () => {
    mockRedis.hgetall.mockResolvedValue({
      lastLedgerSequence: "5000",
      cursorToken: "tok-abc",
      updatedAt: "2026-09-25T10:00:00Z",
    });

    const cursor = await store.loadCursor("CB1");

    expect(cursor).not.toBeNull();
    expect(cursor!.contractId).toBe("CB1");
    expect(cursor!.lastLedgerSequence).toBe(5000);
    expect(cursor!.cursorToken).toBe("tok-abc");
  });

  it("should return null when no cursor exists", async () => {
    mockRedis.hgetall.mockResolvedValue({});

    const cursor = await store.loadCursor("CB1");
    expect(cursor).toBeNull();
  });

  it("should clear cursor", async () => {
    await store.clearCursor("CB1");
    expect(mockRedis.del).toHaveBeenCalledWith("soroban:cursor:CB1");
  });
});

describe("SorobanEventIngestionWorker", () => {
  let worker: SorobanEventIngestionWorker;
  const mockRpcClient = {
    getEvents: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    worker = new SorobanEventIngestionWorker(mockRedis as any, {
      rpcUrl: "https://rpc-testnet.stellar.org",
      contractIds: ["CB1", "CB2"],
    }, {
      rpcClient: mockRpcClient as any,
      cursorStore: new CursorStore(mockRedis as any),
    });
  });

  afterEach(() => {
    worker.stop();
  });

  it("should ingest events for a contract and publish to Redis stream", async () => {
    mockRedis.hgetall.mockResolvedValue({}); // No saved cursor
    mockRpcClient.getEvents.mockResolvedValue({
      events: [
        {
          type: "contract", ledger: 100, ledgerClosedAt: "2026-09-25T10:00:00Z",
          contractId: "CB1", id: "e1", pagingToken: "t1",
          topic: ["deposit"], value: { xdr: "AAAA" },
          inSuccessfulContractCall: true, txHash: "hash1",
        },
      ],
      cursor: "next-tok",
      latestLedger: 100,
    });

    const count = await worker.ingestContract("CB1");

    expect(count).toBe(1);
    expect(mockRedis.xadd).toHaveBeenCalledWith(
      "soroban:events", "*",
      "eventId", "e1",
      "contractId", "CB1",
      "topic", "deposit",
      "data", expect.any(String),
      "ledger", "100",
      "txHash", "hash1",
      "timestamp", "2026-09-25T10:00:00Z",
    );
    // Cursor should be saved
    expect(mockRedis.hset).toHaveBeenCalled();
  });

  it("should resume from saved cursor without reprocessing", async () => {
    mockRedis.hgetall.mockResolvedValue({
      lastLedgerSequence: "5000",
      cursorToken: "saved-tok",
    });
    mockRpcClient.getEvents.mockResolvedValue({
      events: [],
      cursor: "saved-tok",
      latestLedger: 5000,
    });

    const count = await worker.ingestContract("CB1");

    expect(count).toBe(0);
    // Verify the saved cursor was used
    expect(mockRpcClient.getEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        startLedger: 5000,
        cursor: "saved-tok",
      }),
    );
  });

  it("should ingest for all contracts", async () => {
    mockRedis.hgetall.mockResolvedValue({});
    mockRpcClient.getEvents.mockResolvedValue({
      events: [],
      cursor: "tok",
      latestLedger: 100,
    });

    const total = await worker.ingestAll();

    expect(total).toBe(0);
    expect(mockRpcClient.getEvents).toHaveBeenCalledTimes(2); // CB1 + CB2
  });

  it("should start and stop cleanly", () => {
    worker.start();
    worker.stop();
  });
});
