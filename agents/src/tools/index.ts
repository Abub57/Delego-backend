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
