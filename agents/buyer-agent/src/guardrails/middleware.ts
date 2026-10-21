/**
 * Guardrail Middleware — Issue #267
 *
 * Two responsibilities:
 *  1. sanitizeText()  — strips prompt-injection attempts from untrusted
 *                       merchant/product descriptions before they reach the LLM.
 *  2. validateToolParams() — sanitizes, type-coerces and validates all tool
 *                            call parameters against Zod schemas before
 *                            execution; rejects any call that doesn't conform.
 *
 * Issue #362: argument sanitization and explicit type coercion now run ahead of
 * validation, so an LLM that sends `"10.5"` (dollars) for an integer stroop
 * field is corrected rather than crashing the invoker, and rejections carry a
 * self-correction prompt the agent loop can hand back to the model.
 *
 * Security incidents are written to the `security_alerts` table so the ops
 * team can audit them after the fact.
 *
 * Issue #349: `buildSanitizedPromptInput()` separates trusted system
 * instructions from untrusted user/catalog data using explicit delimiter
 * tags before either is handed to the LLM, and `enforceToolCallPolicy()`
 * applies a `ToolCallGuardrailPolicy` (allowed tool allow-list, per-call
 * spending cap, mandatory human approval) on top of per-tool schema
 * validation so a call cannot spend funds purely because it is well-formed.
 */
import { createHash } from "node:crypto";
import { createLogger } from "@delegolabs/utils";
import type { Pool } from "pg";
import {
  buildSelfCorrectionPrompt,
  sanitizeToolCall,
} from "../../../src/tools/sanitization.js";
import {
  DEFAULT_GUARDRAIL_POLICY,
  TOOL_SCHEMAS,
  type FlaggedCategory,
  type GuardrailCheckResult,
  type SanitizedPromptInput,
  type ToolCallGuardrailPolicy,
  type ToolName,
} from "./types.js";

const log = createLogger(
  "buyer-agent:guardrails",
  process.env.LOG_LEVEL ?? "info"
);

// ── Injection pattern catalogue ───────────────────────────────────────────────
// Each tuple is [category, regex].  Patterns are intentionally case-insensitive
// and use word-boundary anchors where appropriate to reduce false-positives.

const INJECTION_PATTERNS: Array<[FlaggedCategory, RegExp]> = [
  // instruction_override — attempts to hijack the system prompt or role
  ["instruction_override", /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?|context)/i],
  ["instruction_override", /\bsystem\s+override\b/i],
  ["instruction_override", /\byou\s+are\s+now\s+(a\s+)?(?!.*buyer)/i],
  ["instruction_override", /\bdisregard\s+(your|all)\s+(previous\s+)?(instructions?|rules?|guidelines?)/i],
  ["instruction_override", /\bact\s+as\s+(if\s+you\s+are|a)\s+(?!.*buyer)/i],
  ["instruction_override", /\bnew\s+(role|persona|instructions?)\b/i],
  ["instruction_override", /\bjailbreak\b/i],
  ["instruction_override", /\bdan\s+mode\b/i],

  // exfiltration — attempts to extract private data or bypass privacy controls
  ["exfiltration", /\bprint\s+(all\s+)?(user\s+)?(secrets?|keys?|tokens?|passwords?)\b/i],
  ["exfiltration", /\brepeat\s+.*system\s+prompt\b/i],
  ["exfiltration", /\bsend\s+.*to\s+(an?\s+)?(external|remote|different)\s+(url|endpoint|server)\b/i],
  ["exfiltration", /\bexfiltrat/i],
  ["exfiltration", /\bleaking?\s+(confidential|private|sensitive)\b/i],

  // budget_tampering — attempts to manipulate spending limits or prices
  ["budget_tampering", /set\s+(spending|budget|limit|total)\s+(to\s+)?\$?0/i],
  ["budget_tampering", /\bbypass\s+(spend|budget|limit|approval)\b/i],
  ["budget_tampering", /\bapprove\s+(automatically|without\s+(limit|check|approval))\b/i],
  ["budget_tampering", /\bchange\s+(the\s+)?(price|amount|total)\s+to\b/i],
  ["budget_tampering", /\bunlimited\s+(spending|budget|funds?)\b/i],
];

// ── Scoring weights per category ──────────────────────────────────────────────
const CATEGORY_WEIGHTS: Record<FlaggedCategory, number> = {
  instruction_override: 0.5,
  exfiltration: 0.4,
  budget_tampering: 0.35,
};

// Per-pattern score contribution (additive, capped at 1.0)
const PER_PATTERN_INCREMENT = 0.15;

export class GuardrailMiddleware {
  constructor(private readonly db?: Pool) {}

  /**
   * Scan `text` for injection patterns, compute a risk score, and return a
   * sanitized copy with flagged content redacted.
   *
   * When `db` is provided, any unsafe input is logged to `security_alerts`.
   */
  async sanitizeText(
    text: string,
    context?: { userId?: string; source?: string }
  ): Promise<GuardrailCheckResult> {
    const flaggedCategories = new Set<FlaggedCategory>();
    let riskScore = 0;
    let sanitized = text;

    for (const [category, pattern] of INJECTION_PATTERNS) {
      if (pattern.test(text)) {
        flaggedCategories.add(category);
        riskScore = Math.min(
          1.0,
          riskScore + (CATEGORY_WEIGHTS[category] * PER_PATTERN_INCREMENT) / 0.15
        );
        // Redact the matched substring
        sanitized = sanitized.replace(pattern, "[REDACTED]");
      }
    }

    // Normalise risk score to [0, 1]
    riskScore = Math.min(1.0, riskScore);

    const isSafe = flaggedCategories.size === 0;

    if (!isSafe) {
      log.warn("Guardrail: prompt injection detected", {
        flaggedCategories: [...flaggedCategories],
        riskScore,
        userId: context?.userId,
        source: context?.source,
      });

      await this.logSecurityAlert({
        alertType: "prompt_injection",
        flaggedCategories: [...flaggedCategories],
        riskScore,
        userId: context?.userId,
        source: context?.source,
        rawTextSnippet: text.slice(0, 500),
      });
    }

    return {
      isSafe,
      flaggedCategories: [...flaggedCategories],
      sanitizedText: sanitized,
      riskScore,
    };
  }

  /**
   * Sanitize, type-coerce and validate tool call parameters against the
   * registered Zod schema for `toolName`. Returns the parsed (safe, coerced)
   * params on success.
   *
   * Throws a `GuardrailValidationError` on failure so callers can handle
   * tool-call rejections without a full process crash. The error carries a
   * self-correction prompt so the model can retry with valid arguments (#362).
   */
  validateToolParams<T = unknown>(
    toolName: string,
    rawParams: unknown
  ): T {
    const schema = TOOL_SCHEMAS[toolName as ToolName];
    if (!schema) {
      throw new GuardrailValidationError(
        toolName,
        `Unknown tool: ${toolName}`
      );
    }

    const result = sanitizeToolCall(toolName, rawParams, schema);

    if (!result.executionAllowed) {
      const issues = result.sanitizationErrors ?? ["unknown validation failure"];

      log.warn("Guardrail: tool parameter validation failed", {
        toolName,
        issues,
      });

      throw new GuardrailValidationError(toolName, issues.join("; "), {
        selfCorrectionPrompt: buildSelfCorrectionPrompt(toolName, issues),
      });
    }

    return result.validatedArguments as T;
  }

  /**
   * Build the delimiter-tagged, injection-scanned payload that is handed to
   * the LLM in place of the raw user instruction and raw catalog text.
   *
   * `userInstruction` and `catalogContext` are untrusted — they may contain
   * merchant-authored or user-authored text carrying injected instructions —
   * so both are wrapped in explicit `<user_data>` / `<catalog_data>` tags and
   * scanned for known injection patterns before being combined with the
   * (trusted, fixed) `systemPrompt`. `systemPolicyHash` binds the request to
   * that exact system prompt so a downstream tampering/truncation can be
   * detected by comparing hashes.
   */
  async buildSanitizedPromptInput(params: {
    userInstruction: string;
    catalogContext: string;
    systemPrompt: string;
    context?: { userId?: string; source?: string };
  }): Promise<SanitizedPromptInput> {
    const [userCheck, catalogCheck] = await Promise.all([
      this.sanitizeText(params.userInstruction, {
        ...params.context,
        source: params.context?.source ?? "user_instruction",
      }),
      this.sanitizeText(params.catalogContext, {
        ...params.context,
        source: "catalog_context",
      }),
    ]);

    const userInstruction = `<user_data>\n${userCheck.sanitizedText}\n</user_data>`;
    const catalogContext = `<catalog_data>\n${catalogCheck.sanitizedText}\n</catalog_data>`;
    const systemPolicyHash = createHash("sha256")
      .update(params.systemPrompt)
      .digest("hex");

    return {
      userInstruction,
      catalogContext,
      systemPolicyHash,
      isFlaggedForInjection: !userCheck.isSafe || !catalogCheck.isSafe,
    };
  }

  /**
   * Validate `rawParams` against the tool's Zod schema *and* the guardrail
   * policy in effect for this run. Execution is blocked — with no partial
   * side effects — if the tool is not in `policy.allowedToolNames`, if an
   * `initiate_checkout` call requests more than
   * `policy.maxSpendingAmountPerCall` stroops, or if the policy requires
   * human approval for spending calls.
   *
   * This is the entry point agent runtimes should call before invoking any
   * tool; `validateToolParams` alone only guarantees schema conformance, not
   * that the call is authorized to spend.
   */
  validateToolCall<T = unknown>(
    toolName: string,
    rawParams: unknown,
    policy: ToolCallGuardrailPolicy = DEFAULT_GUARDRAIL_POLICY
  ): T {
    if (!policy.allowedToolNames.includes(toolName)) {
      log.warn("Guardrail: tool call rejected by allow-list", { toolName });
      throw new GuardrailValidationError(
        toolName,
        `Tool "${toolName}" is not permitted by the current guardrail policy. ` +
          `Allowed tools: ${policy.allowedToolNames.join(", ") || "(none)"}.`
      );
    }

    const validated = this.validateToolParams<T>(toolName, rawParams);

    if (toolName === "initiate_checkout") {
      const params = validated as unknown as { totalAmountStroops: string };
      let amount: bigint;
      try {
        amount = BigInt(params.totalAmountStroops);
      } catch {
        throw new GuardrailValidationError(
          toolName,
          `totalAmountStroops "${params.totalAmountStroops}" is not a valid integer.`
        );
      }

      if (amount > policy.maxSpendingAmountPerCall) {
        log.warn("Guardrail: spending cap exceeded", {
          toolName,
          amount: amount.toString(),
          maxSpendingAmountPerCall: policy.maxSpendingAmountPerCall.toString(),
        });
        throw new GuardrailValidationError(
          toolName,
          `Requested amount ${amount.toString()} stroops exceeds the per-call ` +
            `limit of ${policy.maxSpendingAmountPerCall.toString()} stroops. ` +
            `Request human approval or split the purchase.`
        );
      }

      if (policy.requireHumanApproval) {
        throw new GuardrailValidationError(
          toolName,
          "This policy requires human approval before any spending tool call " +
            "may execute. Route this call through the approval workflow " +
            "instead of invoking it directly.",
          { selfCorrectionPrompt: buildSelfCorrectionPrompt(toolName, [
            "Spending requires human approval under the active policy; " +
              "do not retry this call — request approval instead.",
          ]) }
        );
      }
    }

    return validated;
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private async logSecurityAlert(payload: {
    alertType: string;
    flaggedCategories: FlaggedCategory[];
    riskScore: number;
    userId?: string;
    source?: string;
    rawTextSnippet: string;
  }): Promise<void> {
    if (!this.db) return;

    try {
      await this.db.query(
        `INSERT INTO security_alerts
           (id, alert_type, payload, user_id, created_at)
         VALUES (gen_random_uuid(), $1, $2::jsonb, $3, NOW())`,
        [
          payload.alertType,
          JSON.stringify({
            flaggedCategories: payload.flaggedCategories,
            riskScore: payload.riskScore,
            source: payload.source,
            rawTextSnippet: payload.rawTextSnippet,
          }),
          payload.userId ?? null,
        ]
      );
    } catch (err) {
      // Alert logging must never crash the agent pipeline — log and continue
      log.error("Failed to write security alert", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

export class GuardrailValidationError extends Error {
  /** Structured feedback to send back to the model so it can self-correct (#362). */
  readonly selfCorrectionPrompt: string;

  constructor(
    public readonly toolName: string,
    message: string,
    options: { selfCorrectionPrompt?: string } = {}
  ) {
    super(`Tool parameter validation failed for "${toolName}": ${message}`);
    this.name = "GuardrailValidationError";
    this.selfCorrectionPrompt =
      options.selfCorrectionPrompt ?? buildSelfCorrectionPrompt(toolName, [message]);
  }
}
