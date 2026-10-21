/**
 * LLM Tool Call Argument Sanitization & Type Coercion.
 * Issue #362.
 *
 * LLMs routinely emit tool arguments whose runtime types do not match the
 * declared schema: `"1050"` where an integer is required, `"10.50"` (dollars)
 * where integer stroops are required, `"yes"` where a boolean is required, or
 * an entire JSON payload delivered as a string. Feeding those values straight
 * into a tool invoker produces unhandled runtime errors deep inside business
 * logic.
 *
 * This module sits between the model and the invoker and guarantees three
 * things:
 *  1. Every tool call is validated against a Zod schema before execution.
 *  2. Lossless, explicitly-defined type coercions are applied first (never
 *     silent guesswork — a value is only converted when the conversion is
 *     provably exact).
 *  3. When arguments cannot be safely coerced, a structured self-correction
 *     prompt is produced so the LLM can fix its own call instead of the
 *     invoker panicking.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Result of sanitizing a single model tool call.
 *
 * `executionAllowed` is the only field an invoker should branch on: when it is
 * `false`, `sanitizationErrors` explains what to send back to the model.
 */
export interface ValidatedToolCall<T = unknown> {
  toolName: string;
  rawArguments: unknown;
  validatedArguments: T;
  executionAllowed: boolean;
  sanitizationErrors?: string[];
}

/** A tool call emitted by the model, before sanitization. */
export interface RawToolCall {
  /** Model-assigned id, preserved for the conversation transcript. */
  id?: string;
  name: string;
  /** Provider payloads may be a JSON string, an object, or anything else. */
  arguments: unknown;
}

/** A tool call that must not be executed, with feedback for the model. */
export interface RejectedToolCall {
  id?: string;
  toolName: string;
  errors: string[];
  /** Structured message to append to the conversation so the model retries. */
  selfCorrectionPrompt: string;
}

/** Outcome of a batch sanitization pass. */
export interface ToolCallSanitizationResult<T = unknown> {
  /** Calls that passed sanitization and may be executed, in input order. */
  allowed: Array<ValidatedToolCall<T> & { id?: string }>;
  /** Calls that must not be executed, each with a self-correction prompt. */
  rejected: RejectedToolCall[];
  /** True when every call was allowed. */
  ok: boolean;
}

export interface SanitizationOptions {
  /**
   * Number of fraction digits preserved when converting a dollar-style decimal
   * into integer stroops. Defaults to 7 (1 stroop = 1e-7 XLM).
   */
  stroopsPerUnit?: number;
  /**
   * When false, decimal values are never scaled for integer-typed fields and
   * are always reported as errors. Defaults to true.
   */
  coerceDecimalIntegers?: boolean;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Raised when tool arguments cannot be safely coerced. Carries the structured
 * prompt so callers can hand it straight back to the model.
 */
export class ToolArgumentSanitizationError extends Error {
  readonly toolName: string;
  readonly errors: string[];
  readonly selfCorrectionPrompt: string;

  constructor(toolName: string, errors: string[]) {
    super(`Invalid arguments for tool "${toolName}": ${errors.join("; ")}`);
    this.name = "ToolArgumentSanitizationError";
    this.toolName = toolName;
    this.errors = errors;
    this.selfCorrectionPrompt = buildSelfCorrectionPrompt(toolName, errors);
  }
}

// ---------------------------------------------------------------------------
// Self-correction prompt
// ---------------------------------------------------------------------------

/**
 * Build a structured, model-readable error prompt.
 *
 * Deliberately terse and directive: the model has to emit a *new* tool call,
 * not prose, so the prompt states the problems and demands a retry rather
 * than inviting an apology or an explanation.
 */
export function buildSelfCorrectionPrompt(
  toolName: string,
  errors: string[]
): string {
  const numbered = errors.map((error, index) => "  " + (index + 1) + ". " + error);
  return [
    `Tool call "${toolName}" was rejected because its arguments failed validation.`,
    "",
    "Problems:",
    ...numbered,
    "",
    "Respond by calling the tool again with corrected arguments that satisfy the schema.",
    "Do not apologise, do not explain, and do not switch tools.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * Sanitize a single tool call.
 *
 * Never throws for malformed input — the returned `executionAllowed` flag is
 * the contract. Use {@link assertSanitizedToolCall} when a throwing API is
 * preferable.
 */
export function sanitizeToolCall<T>(
  toolName: string,
  rawArguments: unknown,
  schema: z.ZodType<T>,
  options: SanitizationOptions = {}
): ValidatedToolCall<T> {
  const errors: string[] = [];

  const normalized = normalizeRawArguments(rawArguments, errors);
  if (normalized === INVALID) {
    return {
      toolName,
      rawArguments,
      validatedArguments: undefined as T,
      executionAllowed: false,
      sanitizationErrors: errors,
    };
  }

  // Pass 1 — explicit, schema-aware coercion.
  const coerced = coerceValue(normalized, schema, "", errors, options);

  if (errors.length > 0) {
    return {
      toolName,
      rawArguments,
      validatedArguments: undefined as T,
      executionAllowed: false,
      sanitizationErrors: errors,
    };
  }

  // Pass 2 — authoritative validation with the tool's own schema.
  const parsed = schema.safeParse(coerced);
  if (!parsed.success) {
    return {
      toolName,
      rawArguments,
      validatedArguments: undefined as T,
      executionAllowed: false,
      sanitizationErrors: parsed.error.issues.map(formatIssue),
    };
  }

  return {
    toolName,
    rawArguments,
    validatedArguments: parsed.data,
    executionAllowed: true,
  };
}

/**
 * Sanitize a single tool call, throwing {@link ToolArgumentSanitizationError}
 * when execution is not allowed.
 */
export function assertSanitizedToolCall<T>(
  toolName: string,
  rawArguments: unknown,
  schema: z.ZodType<T>,
  options: SanitizationOptions = {}
): T {
  const result = sanitizeToolCall(toolName, rawArguments, schema, options);
  if (!result.executionAllowed) {
    throw new ToolArgumentSanitizationError(
      toolName,
      result.sanitizationErrors ?? ["unknown validation failure"]
    );
  }
  return result.validatedArguments;
}

/**
 * Sanitize a batch of model tool calls against a schema lookup.
 *
 * Unknown tools are rejected rather than thrown on, so a hallucinated tool
 * name cannot take down the agent loop.
 */
export function sanitizeToolCalls(
  calls: readonly RawToolCall[],
  schemas: Record<string, z.ZodTypeAny>,
  options: SanitizationOptions = {}
): ToolCallSanitizationResult {
  const allowed: Array<ValidatedToolCall & { id?: string }> = [];
  const rejected: RejectedToolCall[] = [];

  for (const call of Array.isArray(calls) ? calls : []) {
    const name = typeof call?.name === "string" ? call.name : "";
    const id = typeof call?.id === "string" ? call.id : undefined;

    if (!name || !Object.prototype.hasOwnProperty.call(schemas, name)) {
      const known = Object.keys(schemas);
      const error =
        `Unknown tool ${JSON.stringify(name || null)}. Available tools: ` +
        (known.length > 0 ? known.join(", ") : "(none)") +
        ".";
      rejected.push({
        ...(id ? { id } : {}),
        toolName: name,
        errors: [error],
        selfCorrectionPrompt: buildSelfCorrectionPrompt(name || "unknown", [error]),
      });
      continue;
    }

    const result = sanitizeToolCall(name, call?.arguments, schemas[name], options);
    if (result.executionAllowed) {
      allowed.push({ ...result, ...(id ? { id } : {}) });
    } else {
      const errors = result.sanitizationErrors ?? ["unknown validation failure"];
      rejected.push({
        ...(id ? { id } : {}),
        toolName: name,
        errors,
        selfCorrectionPrompt: buildSelfCorrectionPrompt(name, errors),
      });
    }
  }

  return { allowed, rejected, ok: rejected.length === 0 };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Sentinel meaning "the raw arguments were unusable". */
const INVALID = Symbol("invalid-raw-arguments");

/** Smallest currency unit ratio used by the Delego/Stellar codebase. */
const DEFAULT_STROOPS_PER_UNIT = 7;

/**
 * Provider clients (notably the OpenAI runtime) fall back to `{ _raw: <text> }`
 * when the arguments blob fails to JSON.parse. Unwrap it so the sanitizer can
 * see the real payload instead of an object that happens to have a string key.
 */
const RAW_PAYLOAD_KEYS = ["_raw", "__raw", "raw"] as const;

function normalizeRawArguments(raw: unknown, errors: string[]): unknown | typeof INVALID {
  let value = raw;

  // Providers may hand us a JSON string.
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) return {};
    try {
      value = JSON.parse(trimmed) as unknown;
    } catch {
      errors.push(
        `Arguments were a string but not valid JSON. Send a JSON object, not ${truncate(trimmed)}.`
      );
      return INVALID;
    }
  }

  if (value === null || value === undefined) return {};

  if (typeof value !== "object" || Array.isArray(value)) {
    errors.push(`Arguments must be a JSON object. Received ${describeType(value)}.`);
    return INVALID;
  }

  // Unwrap a provider fallback envelope if the payload never parsed upstream.
  const record = value as Record<string, unknown>;
  for (const key of RAW_PAYLOAD_KEYS) {
    if (typeof record[key] === "string" && Object.keys(record).length <= 2) {
      return normalizeRawArguments(record[key], errors);
    }
  }

  return record;
}

interface ZodDefLike {
  typeName?: string;
  innerType?: z.ZodTypeAny;
  schema?: z.ZodTypeAny;
  type?: z.ZodTypeAny;
  options?: z.ZodTypeAny[];
  checks?: Array<{ kind: string }>;
}

function defOf(schema: z.ZodTypeAny): ZodDefLike {
  return (schema as unknown as { _def?: ZodDefLike })._def ?? {};
}

/**
 * Recursively coerce `value` so it is more likely to satisfy `schema`.
 *
 * Coercion is intentionally conservative: each conversion is one a human
 * would call obvious. Anything ambiguous is left untouched and recorded as an
 * error rather than guessed at.
 */
function coerceValue(
  value: unknown,
  schema: z.ZodTypeAny,
  path: string,
  errors: string[],
  options: SanitizationOptions
): unknown {
  const def = defOf(schema);
  const at = path || "(root)";

  switch (def.typeName) {
    case z.ZodFirstPartyTypeKind.ZodNumber:
      return coerceNumber(value, schema, at, errors, options);

    case z.ZodFirstPartyTypeKind.ZodString:
      return coerceString(value, at, errors, options);

    case z.ZodFirstPartyTypeKind.ZodBoolean:
      return coerceBoolean(value, at, errors);

    case z.ZodFirstPartyTypeKind.ZodBigInt:
      return coerceBigInt(value, at, errors);

    case z.ZodFirstPartyTypeKind.ZodArray: {
      if (!Array.isArray(value)) {
        errors.push(`${at} must be an array. Received ${describeType(value)}.`);
        return value;
      }
      const element = def.type as z.ZodTypeAny;
      return value.map((item, i) =>
        coerceValue(item, element, `${path}[${i}]`, errors, options)
      );
    }

    case z.ZodFirstPartyTypeKind.ZodObject: {
      if (!isPlainObject(value)) {
        errors.push(`${at} must be an object. Received ${describeType(value)}.`);
        return value;
      }
      const shape = (schema as unknown as { shape: z.ZodRawShape }).shape;
      const out: Record<string, unknown> = {};
      for (const [key, childSchema] of Object.entries(shape)) {
        const childPath = path ? `${path}.${key}` : key;
        const childValue = (value as Record<string, unknown>)[key];
        if (childValue === undefined) {
          if (!childSchema.isOptional()) out[key] = undefined;
          continue;
        }
        out[key] = coerceValue(childValue, childSchema, childPath, errors, options);
      }
      return out;
    }

    case z.ZodFirstPartyTypeKind.ZodOptional:
    case z.ZodFirstPartyTypeKind.ZodNullable:
      return coerceValue(value, def.innerType as z.ZodTypeAny, path, errors, options);

    case z.ZodFirstPartyTypeKind.ZodDefault:
      if (value === undefined) return value;
      return coerceValue(value, def.innerType as z.ZodTypeAny, path, errors, options);

    case z.ZodFirstPartyTypeKind.ZodEffects:
      return coerceValue(value, def.schema as z.ZodTypeAny, path, errors, options);

    case z.ZodFirstPartyTypeKind.ZodUnion: {
      const members = def.options ?? [];
      // Prefer a member that already accepts the value untouched, so a union is
      // never corrupted by a speculative coercion toward the wrong member.
      for (const member of members) {
        if (member.safeParse(value).success) return value;
      }
      return members.length > 0
        ? coerceValue(value, members[0], path, errors, options)
        : value;
    }

    default:
      return value;
  }
}

function coerceNumber(
  value: unknown,
  schema: z.ZodTypeAny,
  at: string,
  errors: string[],
  options: SanitizationOptions
): unknown {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      errors.push(`${at} must be a finite number. Received ${String(value)}.`);
      return value;
    }
    if (isIntSchema(schema) && !Number.isInteger(value)) {
      return scaleDecimalToInteger(value, at, errors, options, true);
    }
    return value;
  }

  if (typeof value === "bigint") return Number(value);

  if (typeof value !== "string") {
    errors.push(`${at} must be a number. Received ${describeType(value)}.`);
    return value;
  }

  const literal = parseNumericLiteral(value, at, errors);
  if (literal === undefined) return value;

  if (isIntSchema(schema) && !Number.isInteger(literal)) {
    // A decimal *string* is the canonical "dollars instead of stroops" mistake
    // the issue calls out, and converting it is exact when the target field is
    // a stroop amount.
    return scaleDecimalToInteger(literal, at, errors, options, false);
  }

  return literal;
}

/**
 * Turn a decimal into an integer, but only when the field is a stroop amount
 * and the conversion is exact. Otherwise it is an error, because silently
 * rounding `"3.7"` to `4` in, say, a `quantity` field is a real bug.
 */
function scaleDecimalToInteger(
  value: number,
  at: string,
  errors: string[],
  options: SanitizationOptions,
  fromNumber: boolean
): unknown {
  // Already an integer — nothing to scale. A value that is *already* in stroops
  // must pass through untouched, so this guard runs before any conversion.
  if (Number.isInteger(value)) return value;

  if (options.coerceDecimalIntegers === false) {
    errors.push(`${at} must be an integer, received the decimal ${value}.`);
    return value;
  }

  if (!isStroopField(at)) {
    errors.push(
      `${at} must be an integer, received ${value}. Drop the decimal part rather than rounding it.`
    );
    return value;
  }

  const digits = options.stroopsPerUnit ?? DEFAULT_STROOPS_PER_UNIT;
  const scaled = Number((value * 10 ** digits).toFixed(0));
  if (!Number.isSafeInteger(scaled)) {
    errors.push(`${at} value ${value} is too large to convert to stroops safely.`);
    return value;
  }

  if (fromNumber) {
    // A JSON *number* is exactly what the schema rejects, so silently
    // converting it would hide a modelling mistake. Tell the model the precise
    // integer to send instead.
    errors.push(
      `${at} must be an integer number of stroops, received the decimal ${value}. ` +
        `Re-send it as the integer ${scaled}.`
    );
    return value;
  }

  return scaled;
}

/**
 * Coerce a value destined for a string field.
 *
 * Deliberately narrow: `#262` established that a wrong-typed string argument
 * must be rejected, so numbers are *not* silently stringified in general. The
 * one exception is stroop amount fields, where the issue explicitly wants a
 * floating dollar value converted to the integer string the schema expects.
 */
function coerceString(
  value: unknown,
  at: string,
  errors: string[],
  options: SanitizationOptions
): unknown {
  if (typeof value === "string") {
    // A floating *dollar* string aimed at a stroop field ("10.5" for
    // `totalAmountStroops`) is the exact mistake the issue describes, so scale
    // it to the integer string the schema expects.
    if (isStroopField(at) && hasFractionalPart(value)) {
      const scaled = scaleDecimalToInteger(
        Number(value.trim()),
        at,
        errors,
        options,
        false
      );
      return typeof scaled === "number" ? String(scaled) : value;
    }
    return value;
  }

  if (typeof value === "number" && isStroopField(at) && Number.isFinite(value)) {
    const scaled = scaleDecimalToInteger(value, at, errors, options, false);
    return typeof scaled === "number" ? String(scaled) : value;
  }

  errors.push(`${at} must be a string. Received ${describeType(value)}.`);
  return value;
}

function coerceBoolean(value: unknown, at: string, errors: string[]): unknown {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (value === 0) return false;
    if (value === 1) return true;
    errors.push(`${at} must be true or false, received ${value}.`);
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "yes", "y", "1", "on"].includes(normalized)) return true;
    if (["false", "no", "n", "0", "off"].includes(normalized)) return false;
    errors.push(`${at} must be true or false, received ${JSON.stringify(truncate(value))}.`);
    return value;
  }
  errors.push(`${at} must be a boolean. Received ${describeType(value)}.`);
  return value;
}

function coerceBigInt(value: unknown, at: string, errors: string[]): unknown {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    return BigInt(value.trim());
  }
  errors.push(`${at} must be an integer, received ${describeType(value)}.`);
  return value;
}

/**
 * Parse a human/LLM-written numeric string: `"10"`, `"10.5"`, `"$10.50"`,
 * `"1,050"`, `"1_000"`, `"1e3"`.
 *
 * Only presentation noise is stripped — a leading currency symbol, digit
 * grouping and whitespace. Any *other* trailing content makes the literal
 * invalid, so `"12abc"` is an error rather than silently becoming `12`.
 */
function parseNumericLiteral(
  raw: string,
  at: string,
  errors: string[]
): number | undefined {
  const cleaned = raw.trim().replace(/^[$€£¥]/, "").replace(/[,\s_]/g, "");

  if (!/^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/.test(cleaned)) {
    errors.push(`${at} must be a number, received ${JSON.stringify(truncate(raw))}.`);
    return undefined;
  }

  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed)) {
    errors.push(
      `${at} must be a finite number, received ${JSON.stringify(truncate(raw))}.`
    );
    return undefined;
  }
  return parsed;
}

/** True for field names that denote an integer stroop amount. */
function isStroopField(at: string): boolean {
  const fieldName = at.split(".").pop() ?? at;
  return /stroops?$/i.test(fieldName);
}

/** True when a numeric string carries a fractional part. */
function hasFractionalPart(value: string): boolean {
  const cleaned = value.trim().replace(/^[$€£¥]/, "").replace(/[,\s_]/g, "");
  if (!/^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/.test(cleaned)) return false;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) && !Number.isInteger(parsed);
}

function isIntSchema(schema: z.ZodTypeAny): boolean {
  const checks = defOf(schema).checks;
  return Array.isArray(checks) && checks.some((check) => check.kind === "int");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") return "an object";
  if (typeof value === "undefined") return "undefined";
  return "a " + typeof value + " (" + JSON.stringify(truncate(String(value))) + ")";
}

function formatIssue(issue: z.ZodIssue): string {
  const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
  return `${path}: ${issue.message}`;
}

function truncate(value: string, max = 64): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
