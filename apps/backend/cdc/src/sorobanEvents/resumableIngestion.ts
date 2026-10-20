/**
 * Resumable Soroban event ingestion — exact resume after downtime.
 *
 * When the worker is taken offline (maintenance, deploy, crash) it must pick
 * up from the exact last-processed ledger stored in
 * `soroban_event_sync_checkpoints`, without skipping or double-processing.
 *
 * How that is guaranteed:
 *
 *   - STARTUP: one query loads every configured contract's checkpoint. The
 *     next ledger to read is `lastProcessedLedger + 1` (or the configured
 *     initial ledger on first run).
 *
 *   - LEDGER WINDOWS: history is read in bounded windows
 *     `[resume, min(resume + windowSize - 1, tip)]` via `getEvents` with
 *     `startLedger` / `endLedger`, paging inside a window with the RPC cursor.
 *
 *   - STRICT ORDER + LEDGER-BOUNDARY COMMITS: events are sorted by
 *     (ledger, eventId). A full page may stop in the middle of a ledger, so
 *     the trailing ledger is carried into the next page and only *complete*
 *     ledgers are committed. The watermark therefore always means "every
 *     event at or below this ledger is in the database".
 *
 *   - ATOMIC WATERMARK: event upserts, exactly-once claims and the watermark
 *     update share one transaction (see ingestionCheckpointStore.ts). A crash
 *     before COMMIT leaves the old watermark, so the batch is simply re-read.
 *
 *   - RETENTION GAP: if the worker was down longer than the RPC node's event
 *     retention, the missing ledgers cannot be fetched. Rather than silently
 *     skipping them, the contract is halted with LedgerRetentionGapError.
 */

import { createLogger, type Logger } from "@delegolabs/utils";
import {
  CheckpointConflictError,
  compareLedgerEvents,
  type IngestionCheckpoint,
  type IngestionCheckpointStore,
  type LedgerEvent,
} from "./ingestionCheckpointStore.js";

// ---------------------------------------------------------------------------
// Soroban RPC (JSON-RPC 2.0) — ledger-windowed getEvents
// ---------------------------------------------------------------------------

/** Event as returned by Soroban RPC `getEvents` (old and new value encodings). */
export interface RpcContractEvent {
  type: string;
  ledger: number;
  ledgerClosedAt: string;
  contractId: string;
  id: string;
  topic: string[];
  /** base64 XDR ScVal (current RPC) or `{ xdr }` (older RPC versions). */
  value: string | { xdr?: string; str?: string };
  inSuccessfulContractCall?: boolean;
  txHash: string;
}

export interface GetEventsWindowParams {
  contractId: string;
  /** Inclusive. Omitted by the client when `cursor` is set (RPC requirement). */
  startLedger: number;
  /** Inclusive (converted to the RPC's exclusive `endLedger`). */
  endLedger: number;
  cursor?: string;
  limit: number;
}

export interface GetEventsWindowResult {
  events: RpcContractEvent[];
  cursor?: string;
}

export interface LedgerRange {
  oldestLedger: number;
  latestLedger: number;
}

export interface SorobanLedgerRpc {
  getLedgerRange(): Promise<LedgerRange>;
  getEventsWindow(params: GetEventsWindowParams): Promise<GetEventsWindowResult>;
}

export class SorobanRpcError extends Error {
  constructor(message: string, readonly code?: number) {
    super(message);
    this.name = "SorobanRpcError";
  }
}

export class SorobanLedgerRpcClient implements SorobanLedgerRpc {
  private requestId = 0;

  constructor(
    private readonly rpcUrl: string,
    private readonly timeoutMs = 15_000,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async getLedgerRange(): Promise<LedgerRange> {
    const result = await this.call<{ latestLedger?: number; oldestLedger?: number }>("getHealth", undefined);
    const latestLedger = Number(result.latestLedger);
    const oldestLedger = Number(result.oldestLedger);
    if (!Number.isInteger(latestLedger) || !Number.isInteger(oldestLedger)) {
      throw new SorobanRpcError("getHealth response is missing latestLedger/oldestLedger");
    }
    return { latestLedger, oldestLedger };
  }

  async getEventsWindow(params: GetEventsWindowParams): Promise<GetEventsWindowResult> {
    const result = await this.call<{ events?: RpcContractEvent[]; cursor?: string }>("getEvents", {
      // `startLedger` and `cursor` are mutually exclusive in Soroban RPC.
      ...(params.cursor ? {} : { startLedger: params.startLedger }),
      // RPC `endLedger` is exclusive; our window bound is inclusive.
      endLedger: params.endLedger + 1,
      filters: [{ type: "contract", contractIds: [params.contractId] }],
      pagination: { limit: params.limit, ...(params.cursor ? { cursor: params.cursor } : {}) },
    });
    return { events: result.events ?? [], cursor: result.cursor || undefined };
  }

  private async call<T>(method: string, params: unknown): Promise<T> {
    const response = await this.fetchImpl(this.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++this.requestId, method, params }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new SorobanRpcError(`Soroban RPC ${method} failed: HTTP ${response.status}`);
    }
    const body = (await response.json()) as { result?: T; error?: { code?: number; message?: string } };
    if (body.error) {
      throw new SorobanRpcError(`Soroban RPC ${method} error: ${body.error.message ?? "unknown"}`, body.error.code);
    }
    if (body.result === undefined) {
      throw new SorobanRpcError(`Soroban RPC ${method} returned no result`);
    }
    return body.result;
  }
}

export function toLedgerEvent(raw: RpcContractEvent): LedgerEvent {
  return {
    eventId: raw.id,
    contractId: raw.contractId,
    ledger: Number(raw.ledger),
    ledgerClosedAt: raw.ledgerClosedAt,
    txHash: raw.txHash,
    topics: raw.topic ?? [],
    value: typeof raw.value === "string" ? { xdr: raw.value } : (raw.value ?? {}),
    inSuccessfulContractCall: raw.inSuccessfulContractCall ?? true,
  };
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

export class LedgerRetentionGapError extends Error {
  constructor(
    readonly contractId: string,
    readonly resumeLedger: number,
    readonly oldestLedger: number
  ) {
    super(
      `Cannot resume ${contractId} at ledger ${resumeLedger}: RPC only retains ledgers from ${oldestLedger}. ` +
        `Ledgers ${resumeLedger}-${oldestLedger - 1} must be backfilled from an archive before ingestion can continue.`
    );
    this.name = "LedgerRetentionGapError";
  }
}

export interface ResumableIngestionConfig {
  contractIds: string[];
  /**
   * Ledger to start from for a contract with no checkpoint (e.g. the
   * contract's deployment ledger). Defaults to the RPC's oldest retained
   * ledger.
   */
  initialLedger?: number;
  /** Ledgers per `getEvents` window. Default 1000. */
  windowSize?: number;
  /** Events per RPC page. Default 100. */
  pageSize?: number;
  /** Delay between sync cycles once caught up. Default 5s. */
  pollIntervalMs?: number;
  /** Upper bound for the error backoff. Default 60s. */
  maxBackoffMs?: number;
}

export interface ResumableIngestionDeps {
  rpc: SorobanLedgerRpc;
  store: IngestionCheckpointStore;
  /**
   * Called after a batch has COMMITTED with the events it newly processed.
   * Use for at-least-once side effects (e.g. Redis stream fan-out); consumers
   * must dedupe on `eventId`. Failures are logged, never rolled back.
   */
  onCommitted?: (contractId: string, events: LedgerEvent[]) => Promise<void>;
  logger?: Logger;
}

export type ContractSyncState = "idle" | "syncing" | "halted";

export interface ContractSyncStatus {
  contractId: string;
  state: ContractSyncState;
  checkpoint: IngestionCheckpoint | null;
  lastError?: string;
}

const DEFAULT_WINDOW_SIZE = 1_000;
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_MAX_BACKOFF_MS = 60_000;

export class ResumableSorobanIngestionWorker {
  private readonly config: Required<Omit<ResumableIngestionConfig, "initialLedger">> &
    Pick<ResumableIngestionConfig, "initialLedger">;
  private readonly log: Logger;
  private readonly checkpoints = new Map<string, IngestionCheckpoint | null>();
  private readonly status = new Map<string, ContractSyncStatus>();
  private running = false;
  private stopping = false;
  private loop: Promise<void> | null = null;
  private wake: (() => void) | null = null;

  constructor(private readonly deps: ResumableIngestionDeps, config: ResumableIngestionConfig) {
    const windowSize = config.windowSize ?? DEFAULT_WINDOW_SIZE;
    const pageSize = config.pageSize ?? DEFAULT_PAGE_SIZE;
    if (!Number.isInteger(windowSize) || windowSize < 1) throw new Error("windowSize must be a positive integer");
    if (!Number.isInteger(pageSize) || pageSize < 1) throw new Error("pageSize must be a positive integer");
    if (config.contractIds.length === 0) throw new Error("At least one contractId is required");

    this.config = {
      contractIds: [...new Set(config.contractIds)],
      initialLedger: config.initialLedger,
      windowSize,
      pageSize,
      pollIntervalMs: config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      maxBackoffMs: config.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS,
    };
    this.log = deps.logger ?? createLogger("cdc:soroban:resumable", process.env.LOG_LEVEL ?? "info");
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Loads checkpoints from PostgreSQL, then runs sync cycles until stopped. */
  async start(): Promise<void> {
    if (this.running) return;
    await this.loadCheckpoints();
    this.stopping = false;
    this.running = true;
    this.loop = this.runLoop();
  }

  /**
   * Stops after the in-flight batch finishes. Because every batch commits
   * atomically, stopping (or being killed) at any point is safe; awaiting
   * this simply avoids wasting a half-fetched window.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    this.running = false;
    this.wake?.();
    await this.loop;
    this.loop = null;
  }

  /** Startup step: read `soroban_event_sync_checkpoints` for every contract. */
  async loadCheckpoints(): Promise<void> {
    const loaded = await this.deps.store.loadAll(this.config.contractIds);
    for (const contractId of this.config.contractIds) {
      const checkpoint = loaded.get(contractId) ?? null;
      this.checkpoints.set(contractId, checkpoint);
      this.status.set(contractId, { contractId, state: "idle", checkpoint });
    }
    this.log.info("Loaded Soroban ingestion checkpoints", {
      checkpoints: this.config.contractIds.map((id) => ({
        contractId: id,
        lastProcessedLedger: loaded.get(id)?.lastProcessedLedger ?? null,
        lastEventId: loaded.get(id)?.lastEventId ?? null,
      })),
    });
  }

  getStatus(): ContractSyncStatus[] {
    return this.config.contractIds.map((id) => ({ ...this.status.get(id)! }));
  }

  private async runLoop(): Promise<void> {
    let consecutiveFailures = 0;
    while (this.running) {
      let failed = false;
      try {
        failed = !(await this.syncOnce());
      } catch (err) {
        failed = true;
        this.log.error("Soroban sync cycle failed", { error: errorMessage(err) });
      }
      consecutiveFailures = failed ? consecutiveFailures + 1 : 0;
      const delay = failed
        ? Math.min(this.config.pollIntervalMs * 2 ** consecutiveFailures, this.config.maxBackoffMs)
        : this.config.pollIntervalMs;
      await this.sleep(delay);
    }
  }

  private sleep(ms: number): Promise<void> {
    if (!this.running) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done(): void {
        clearTimeout(timer);
        resolve();
      }
      this.wake = done;
    });
  }

  // -------------------------------------------------------------------------
  // Sync
  // -------------------------------------------------------------------------

  /**
   * Runs one catch-up pass for every non-halted contract.
   * @returns `true` when every contract synced without error.
   */
  async syncOnce(): Promise<boolean> {
    if (this.checkpoints.size === 0) await this.loadCheckpoints();
    const range = await this.deps.rpc.getLedgerRange();
    let ok = true;
    for (const contractId of this.config.contractIds) {
      const status = this.status.get(contractId)!;
      if (status.state === "halted") continue;
      try {
        await this.syncContract(contractId, range);
      } catch (err) {
        ok = false;
        this.handleContractError(contractId, err);
      }
    }
    return ok;
  }

  /** Reads windows until the contract has caught up with `range.latestLedger`. */
  async syncContract(contractId: string, range: LedgerRange): Promise<number> {
    const status = this.status.get(contractId)!;
    status.state = "syncing";
    let processedTotal = 0;

    let resume = this.resumeLedger(contractId, range);
    if (resume < range.oldestLedger) {
      throw new LedgerRetentionGapError(contractId, resume, range.oldestLedger);
    }

    while (!this.stopping && resume <= range.latestLedger) {
      const windowEnd = Math.min(resume + this.config.windowSize - 1, range.latestLedger);
      processedTotal += await this.processWindow(contractId, resume, windowEnd);
      resume = windowEnd + 1;
    }

    status.state = "idle";
    status.lastError = undefined;
    return processedTotal;
  }

  /**
   * Ingests ledgers `[startLedger, endLedger]` (inclusive) in strict order,
   * committing only complete ledgers.
   */
  async processWindow(contractId: string, startLedger: number, endLedger: number): Promise<number> {
    let cursor: string | undefined;
    let carry: LedgerEvent[] = [];
    let processed = 0;

    for (;;) {
      const page = await this.deps.rpc.getEventsWindow({
        contractId,
        startLedger,
        endLedger,
        cursor,
        limit: this.config.pageSize,
      });

      const pageEvents = page.events
        .map(toLedgerEvent)
        .filter((e) => e.contractId === contractId && e.ledger >= startLedger);
      const inWindow = pageEvents.filter((e) => e.ledger <= endLedger).sort(compareLedgerEvents);
      const pending = mergeOrdered(carry, inWindow);

      const windowExhausted =
        page.events.length < this.config.pageSize ||
        !page.cursor ||
        page.cursor === cursor ||
        pageEvents.some((e) => e.ledger > endLedger);

      if (windowExhausted) {
        processed += await this.commit(contractId, endLedger, pending);
        return processed;
      }

      // Full page: the last ledger may continue on the next page. Commit only
      // ledgers strictly below it and carry the rest forward.
      const lastLedger = pending.length > 0 ? pending[pending.length - 1].ledger : startLedger;
      const complete = pending.filter((e) => e.ledger < lastLedger);
      carry = pending.filter((e) => e.ledger >= lastLedger);
      processed += await this.commit(contractId, lastLedger - 1, complete);
      cursor = page.cursor;
    }
  }

  private async commit(contractId: string, throughLedger: number, events: LedgerEvent[]): Promise<number> {
    const expected = this.checkpoints.get(contractId) ?? null;
    if (events.length === 0 && throughLedger <= (expected?.lastProcessedLedger ?? 0)) return 0;

    const { checkpoint, processed } = await this.deps.store.commitBatch({
      contractId,
      expected,
      throughLedger,
      events,
    });
    this.checkpoints.set(contractId, checkpoint);
    this.status.get(contractId)!.checkpoint = checkpoint;

    if (processed.length > 0) {
      this.log.info("Committed Soroban events", {
        contractId,
        count: processed.length,
        throughLedger,
        lastEventId: checkpoint.lastEventId,
      });
      if (this.deps.onCommitted) {
        try {
          await this.deps.onCommitted(contractId, processed);
        } catch (err) {
          this.log.error("Post-commit hook failed (events are durably stored)", {
            contractId,
            error: errorMessage(err),
          });
        }
      }
    }
    return processed.length;
  }

  private handleContractError(contractId: string, err: unknown): void {
    const status = this.status.get(contractId)!;
    status.lastError = errorMessage(err);

    if (err instanceof CheckpointConflictError) {
      // Another writer advanced the watermark; adopt it and continue from there.
      this.checkpoints.set(contractId, err.stored);
      status.checkpoint = err.stored;
      status.state = "idle";
      this.log.warn("Checkpoint changed underneath worker; reloaded", {
        contractId,
        storedLedger: err.stored?.lastProcessedLedger ?? null,
      });
      return;
    }
    if (err instanceof LedgerRetentionGapError) {
      status.state = "halted";
      this.log.error("Halting contract ingestion: ledgers fell out of RPC retention", {
        contractId,
        resumeLedger: err.resumeLedger,
        oldestLedger: err.oldestLedger,
      });
      return;
    }
    status.state = "idle";
    this.log.error("Contract sync failed; will retry from last committed ledger", {
      contractId,
      lastProcessedLedger: this.watermark(contractId),
      error: status.lastError,
    });
  }

  private watermark(contractId: string): number {
    return this.checkpoints.get(contractId)?.lastProcessedLedger ?? 0;
  }

  private resumeLedger(contractId: string, range: LedgerRange): number {
    const checkpoint = this.checkpoints.get(contractId);
    if (checkpoint) return checkpoint.lastProcessedLedger + 1;
    return this.config.initialLedger ?? range.oldestLedger;
  }
}

/** Merge two (ledger, eventId)-sorted lists, dropping duplicate ids. */
function mergeOrdered(a: LedgerEvent[], b: LedgerEvent[]): LedgerEvent[] {
  const out: LedgerEvent[] = [];
  const seen = new Set<string>();
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const next = j >= b.length || (i < a.length && compareLedgerEvents(a[i], b[j]) <= 0) ? a[i++] : b[j++];
    if (!seen.has(next.eventId)) {
      seen.add(next.eventId);
      out.push(next);
    }
  }
  return out;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
