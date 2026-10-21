export {
  AuditLogError,
  recordAuditEntry,
  queryAuditLog,
  getChainSegment,
} from "./auditLogStore.js";

export { computeEntryHash, verifyChain, type HashableAuditFields } from "./hashChain.js";
export {
  configureAuditLogTransport,
  createCefSyslogTransport,
  formatCef,
  type AuditLogTransport,
  type CefSyslogOptions,
} from "./cefExporter.js";

export {
  computeCurrentHash,
  buildEntry,
  verifyChain as verifyAuditChain,
  verifyChainOnStartup,
  computeMerkleRoot,
  verifyEntry,
} from "./auditChain.js";

export { StellarMerklePublisher, createStellarPublisherFromEnv } from "./stellarPublisher.js";

export {
  verifyStoredChain,
  formatChainVerificationReport,
  DEFAULT_VERIFY_PAGE_SIZE,
  type VerifyStoredChainOptions,
  type StoredChainVerificationResult,
} from "./verifyStoredChain.js";

export type {
  AuditOperation,
  AuditLogEntry,
  AuditLogEntryInput,
  AuditQuery,
  AuditQueryResult,
  RetentionPolicy,
  ChainVerificationResult,
} from "./types.js";

// Note: `Queryable` is intentionally not re-exported here — it's the same
// minimal pg-compatible interface as `../softDelete/types.js`'s `Queryable`
// (this module imports that one rather than redefining it), which is
// already re-exported once from the package root via softDelete/index.js.
