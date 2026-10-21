// Soroban event ingestion worker — closes #285, #366
export {
  SorobanEventIngestionWorker,
  SorobanRpcClient,
  CursorStore,
  createSorobanEventIngestionWorker,
  normalizeEvent,
} from "./ingestionWorker.js";

export type {
  ContractEventCursor,
  NormalizedContractEvent,
  RawSorobanEvent,
  SorobanRpcConfig,
  SorobanIngestionWorkerOptions,
  CreateSorobanWorkerOptions,
  // Issue #366 — re-exported from checkpointStore via ingestionWorker
  EventSyncCheckpoint,
  CheckpointStore,
  ProcessedEventStore,
} from "./ingestionWorker.js";

// Checkpoint + dedup store implementations — exported for consumers that need
// to wire them explicitly (e.g. integration tests or custom DI containers).
export {
  InMemoryCheckpointStore,
  PostgresCheckpointStore,
  InMemoryProcessedEventStore,
  PostgresProcessedEventStore,
} from "./checkpointStore.js";

// Resumable, ledger-windowed ingestion with atomic watermarks.
export {
  ResumableSorobanIngestionWorker,
  SorobanLedgerRpcClient,
  SorobanRpcError,
  LedgerRetentionGapError,
  toLedgerEvent,
} from "./resumableIngestion.js";
export type {
  RpcContractEvent,
  SorobanLedgerRpc,
  LedgerRange,
  GetEventsWindowParams,
  GetEventsWindowResult,
  ResumableIngestionConfig,
  ResumableIngestionDeps,
  ContractSyncStatus,
} from "./resumableIngestion.js";
export {
  PostgresIngestionCheckpointStore,
  InMemoryIngestionCheckpointStore,
  CheckpointConflictError,
  compareLedgerEvents,
} from "./ingestionCheckpointStore.js";
export type {
  IngestionCheckpoint,
  IngestionCheckpointStore,
  LedgerEvent,
  LedgerEventProcessor,
  CommitBatchInput,
  CommitBatchResult,
} from "./ingestionCheckpointStore.js";
