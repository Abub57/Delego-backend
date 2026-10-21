/**
 * Agent Tool Registry & Secure Sandboxed Invoker.
 * Issue #262: type-safe registry with Zod validation, permission enforcement,
 * execution timeouts (10 s), and audit logging.
 * Issue #362: every model tool call is sanitized and type-coerced before it
 * reaches the invoker, so malformed LLM output can never panic the executor.
 */

import { z } from "zod";
import {
  buildSelfCorrectionPrompt,
  sanitizeToolCall,
  type RawToolCall,
  type SanitizationOptions,
  type ValidatedToolCall,
} from "./sanitization.js";

// ---------------------------------------------------------------------------
// Context & permissions
// ---------------------------------------------------------------------------

export type AgentPermissionScope =
  | "read_only"
  | "propose_order"
  | "execute_payment";

/** Runtime context injected into every tool execution. */
export interface AgentContext {
  userId: string;
  walletAddress: string;
  delegationId?: string;
  spendingLimitRemainingStroops: string;
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export interface AgentTool<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodSchema<TInput>;
  requiredPermission: AgentPermissionScope;
  execute: (input: TInput, context: AgentContext) => Promise<TOutput>;
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export interface ToolAuditEntry {
  toolName: string;
  userId: string;
  delegationId?: string;
  input: unknown;
  output: unknown;
  success: boolean;
  error?: string;
  durationMs: number;
  executedAt: string;
}

/** Persist-to-database callback. Implementations should write to the audit log table. */
export type AuditLogger = (entry: ToolAuditEntry) => Promise<void>;

/** In-memory no-op used when no persistent logger is configured. */
const noopAuditLogger: AuditLogger = async () => {};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ToolValidationError extends Error {
  readonly issues: z.ZodIssue[];
  /** Structured feedback to send back to the model (#362). */
  readonly selfCorrectionPrompt: string;
  constructor(toolName: string, issues: z.ZodIssue[]) {
    super(
      `Invalid input for tool "${toolName}": ${issues.map((i) => i.message).join("; ")}`
    );
    this.name = "ToolValidationError";
    this.issues = issues;
    this.selfCorrectionPrompt = buildSelfCorrectionPrompt(
      toolName,
      issues.map((i) => i.message)
    );
  }
}

export class ToolPermissionError extends Error {
  constructor(
    toolName: string,
    required: AgentPermissionScope,
    context: AgentContext
  ) {
    super(
      `Permission denied for tool "${toolName}": requires "${required}" scope (userId=${context.userId})`
    );
    this.name = "ToolPermissionError";
  }
}

export class ToolTimeoutError extends Error {
  constructor(toolName: string, timeoutMs: number) {
    super(`Tool "${toolName}" timed out after ${timeoutMs} ms`);
    this.name = "ToolTimeoutError";
  }
}

/**
 * Raised when a model tool call names a tool that is not registered.
 * Carries a self-correction prompt so the agent loop can ask the model to
 * re-issue the call against a real tool (#362).
 */
export class UnknownToolError extends Error {
  readonly toolName: string;
  readonly availableTools: string[];
  readonly selfCorrectionPrompt: string;
  constructor(toolName: string, availableTools: string[]) {
    const list = availableTools.length > 0 ? availableTools.join(", ") : "(none)";
    super(`Unknown tool: "${toolName}". Available tools: ${list}.`);
    this.name = "UnknownToolError";
    this.toolName = toolName;
    this.availableTools = availableTools;
    this.selfCorrectionPrompt = buildSelfCorrectionPrompt(toolName, [
      `Unknown tool "${toolName}". Available tools: ${list}.`,
    ]);
  }
}

// ---------------------------------------------------------------------------
// Permission hierarchy
// ---------------------------------------------------------------------------

/** Numeric rank — higher rank includes lower-rank permissions. */
const PERMISSION_RANK: Record<AgentPermissionScope, number> = {
  read_only: 0,
  propose_order: 1,
  execute_payment: 2,
};

function contextGrantsPermission(
  required: AgentPermissionScope,
  context: AgentContext
): boolean {
  const contextScope = deriveContextScope(context);
  return PERMISSION_RANK[contextScope] >= PERMISSION_RANK[required];
}

function deriveContextScope(context: AgentContext): AgentPermissionScope {
  if (!context.delegationId) return "read_only";
  const remaining = BigInt(context.spendingLimitRemainingStroops);
  if (remaining > 0n) return "execute_payment";
  return "propose_order";
}

// ---------------------------------------------------------------------------
// ToolRegistry
// ---------------------------------------------------------------------------

const TOOL_EXECUTION_TIMEOUT_MS = 10_000;

interface RegisteredEntry<TInput = unknown, TOutput = unknown> {
  tool: AgentTool<TInput, TOutput>;
}

/**
 * Central registry for all agent tools.
 *
 * Usage:
 * ```ts
 * const registry = new ToolRegistry();
 * registry.register(myTool);
 * const result = await registry.execute("myTool", rawInput, agentContext);
 * ```
 */
export class ToolRegistry {
  private readonly entries = new Map<string, RegisteredEntry>();
  private readonly inMemoryLog: ToolAuditEntry[] = [];
  private readonly auditLogger: AuditLogger;

  constructor(
    auditLogger: AuditLogger = noopAuditLogger,
    private readonly sanitizationOptions: SanitizationOptions = {}
  ) {
    this.auditLogger = auditLogger;
  }

  // ---- Registration -------------------------------------------------------

  register<TInput, TOutput>(tool: AgentTool<TInput, TOutput>): void {
    if (this.entries.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered`);
    }
    this.entries.set(tool.name, { tool: tool as AgentTool<unknown, unknown> });
  }

  listTools(): Array<{
    name: string;
    description: string;
    requiredPermission: AgentPermissionScope;
  }> {
    return Array.from(this.entries.values()).map(({ tool }) => ({
      name: tool.name,
      description: tool.description,
      requiredPermission: tool.requiredPermission,
    }));
  }

  // ---- Execution ----------------------------------------------------------

  /** Resolve a registered tool, or throw a self-correctable UnknownToolError. */
  private getTool(toolName: string): AgentTool<unknown, unknown> {
    const registered = this.entries.get(toolName);
    if (!registered) {
      throw new UnknownToolError(toolName, Array.from(this.entries.keys()));
    }
    return registered.tool;
  }

  /**
   * Sanitize a raw model tool call without executing it (#362).
   *
   * Exposed so the agent loop can validate a batch of tool calls and decide
   * which to run, collecting rejection prompts for the transcript.
   */
  validateToolCall(toolName: string, rawArguments: unknown): ValidatedToolCall {
    const tool = this.getTool(toolName);
    return sanitizeToolCall(
      toolName,
      rawArguments,
      tool.inputSchema as z.ZodType<unknown>,
      this.sanitizationOptions
    );
  }

  /**
   * Sanitize and execute a model tool call in one step.
   *
   * On a rejected call this resolves with `executionAllowed: false` and a
   * self-correction prompt rather than throwing, so a malformed model response
   * can never crash the executor (#362).
   */
  async executeToolCall(
    call: RawToolCall,
    context: AgentContext
  ): Promise<
    | { executionAllowed: true; toolName: string; output: unknown }
    | {
        executionAllowed: false;
        toolName: string;
        errors: string[];
        selfCorrectionPrompt: string;
      }
  > {
    const toolName = typeof call?.name === "string" ? call.name : "";

    let validated: ValidatedToolCall;
    try {
      validated = this.validateToolCall(toolName, call?.arguments);
    } catch (err) {
      // A hallucinated tool name is a model problem, not a server fault.
      if (err instanceof UnknownToolError) {
        return {
          executionAllowed: false,
          toolName,
          errors: [err.message],
          selfCorrectionPrompt: err.selfCorrectionPrompt,
        };
      }
      throw err;
    }

    if (!validated.executionAllowed) {
      const errors = validated.sanitizationErrors ?? ["unknown validation failure"];
      return {
        executionAllowed: false,
        toolName,
        errors,
        selfCorrectionPrompt: buildSelfCorrectionPrompt(toolName, errors),
      };
    }

    const output = await this.execute(toolName, validated.validatedArguments, context);
    return { executionAllowed: true, toolName, output };
  }

  async execute(
    toolName: string,
    rawInput: unknown,
    context: AgentContext
  ): Promise<unknown> {
    const { tool } = this.entries.get(toolName) ?? {};
    if (!tool) {
      throw new UnknownToolError(toolName, Array.from(this.entries.keys()));
    }

    // 1. Permission check — before audit so unauthorised requests don't log
    //    their raw input (potential data-leak concern).
    if (!contextGrantsPermission(tool.requiredPermission, context)) {
      throw new ToolPermissionError(toolName, tool.requiredPermission, context);
    }

    // 2. Validation + execution are both wrapped in the audit boundary so
    //    validation failures also produce an audit entry.
    const start = Date.now();
    let output: unknown = null;
    let success = false;
    let errorMessage: string | undefined;
    let parsedInput: unknown = rawInput;

    try {
      // 2a. Sanitize (explicit type coercion) then validate with Zod.
      //     Malformed model output becomes a ToolValidationError carrying a
      //     self-correction prompt instead of an unhandled crash (#362).
      const sanitized = sanitizeToolCall(
        toolName,
        rawInput,
        tool.inputSchema as z.ZodType<unknown>,
        this.sanitizationOptions
      );
      if (!sanitized.executionAllowed) {
        throw new ToolValidationError(
          toolName,
          (sanitized.sanitizationErrors ?? ["unknown validation failure"]).map(
            (message) => ({ code: "custom", message } as z.ZodIssue)
          )
        );
      }
      parsedInput = sanitized.validatedArguments;

      // 2b. Sandboxed execution with timeout
      output = await executeWithTimeout(
        () => tool.execute(parsedInput, context),
        TOOL_EXECUTION_TIMEOUT_MS,
        toolName
      );
      success = true;
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      const auditEntry: ToolAuditEntry = {
        toolName,
        userId: context.userId,
        delegationId: context.delegationId,
        input: parsedInput,
        output,
        success,
        durationMs: Date.now() - start,
        executedAt: new Date().toISOString(),
        ...(errorMessage ? { error: errorMessage } : {}),
      };
      this.inMemoryLog.push(auditEntry);
      // Fire-and-forget to database; errors here must not surface to callers.
      this.auditLogger(auditEntry).catch(() => {});
    }

    return output;
  }

  // ---- Audit log (in-memory, primarily for tests) -------------------------

  getAuditLog(): ToolAuditEntry[] {
    return [...this.inMemoryLog];
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function executeWithTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  toolName: string
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new ToolTimeoutError(toolName, timeoutMs)),
      timeoutMs
    );

    fn()
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((err: unknown) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}
