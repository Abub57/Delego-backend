/**
 * Agent tool registry exports.
 * Issue #262: type-safe registry with Zod validation, permissions, and timeouts.
 */

export type {
  AgentTool,
  AgentContext,
  AgentPermissionScope,
  ToolAuditEntry,
  AuditLogger,
  PreExecutionGuard,
} from "./registry.js";

export {
  ToolRegistry,
  ToolValidationError,
  ToolPermissionError,
  ToolTimeoutError,
  UnknownToolError,
} from "./registry.js";

// Issue #362: tool call argument sanitization and type coercion
export {
  sanitizeToolCall,
  assertSanitizedToolCall,
  sanitizeToolCalls,
  buildSelfCorrectionPrompt,
  ToolArgumentSanitizationError,
} from "./sanitization.js";
export type {
  ValidatedToolCall,
  RawToolCall,
  RejectedToolCall,
  ToolCallSanitizationResult,
  SanitizationOptions,
} from "./sanitization.js";

// Issue #533: spend-velocity guard for money-moving tool execution
export {
  SpendVelocityGuard,
  SpendVelocityExceededError,
  guardSpend,
} from "./spendVelocityGuard.js";
export type {
  SpendVelocityPolicy,
  SpendVelocityCheckResult,
  RecordedSpend,
  VelocityAlert,
} from "./spendVelocityGuard.js";
