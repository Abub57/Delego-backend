/**
 * Guardrail types — Issue #267
 * Sanitize untrusted merchant text and tool outputs against prompt injection.
 */
import { z } from "zod";

export type FlaggedCategory =
  | "instruction_override"
  | "exfiltration"
  | "budget_tampering";

export interface GuardrailCheckResult {
  isSafe: boolean;
  flaggedCategories: FlaggedCategory[];
  sanitizedText: string;
  /** 0.0 (clean) – 1.0 (highly suspicious) */
  riskScore: number;
}

// ── Zod schemas for tool parameter validation ────────────────────────────────

export const SearchProductsParamsSchema = z.object({
  query: z.string().min(1).max(512),
  category: z.string().max(64).optional(),
  maxPriceStroops: z.string().regex(/^\d+$/).optional(),
  limit: z.number().int().min(1).max(100).default(10),
});

export const AddToCartParamsSchema = z.object({
  productId: z.string().uuid(),
  quantity: z.number().int().positive().max(999),
});

export const InitiateCheckoutParamsSchema = z.object({
  delegationId: z.string().uuid(),
  merchantAddress: z.string().min(1).max(64),
  totalAmountStroops: z.string().regex(/^\d+$/),
  assetCode: z.string().min(1).max(12),
  rationale: z.string().min(1).max(2048),
});

export type ToolName =
  | "search_products"
  | "add_to_cart"
  | "initiate_checkout";

export const TOOL_SCHEMAS: Record<ToolName, z.ZodTypeAny> = {
  search_products: SearchProductsParamsSchema,
  add_to_cart: AddToCartParamsSchema,
  initiate_checkout: InitiateCheckoutParamsSchema,
};

// ── Prompt injection defense — Issue #349 ────────────────────────────────────

/**
 * Untrusted input separated from the trusted system prompt before it is
 * assembled into a single LLM request. `userInstruction` and `catalogContext`
 * are both wrapped in delimiter tags (`<user_data>` / `<catalog_data>`) so the
 * model can distinguish "data to read" from "instructions to follow", and the
 * fixed system policy is bound to the request via `systemPolicyHash` so a
 * tampered or truncated policy can be detected downstream.
 */
export interface SanitizedPromptInput {
  userInstruction: string;
  catalogContext: string;
  systemPolicyHash: string;
  isFlaggedForInjection: boolean;
}

/**
 * Guardrail policy enforced on every tool call the buyer agent emits, on top
 * of per-tool Zod schema validation. `allowedToolNames` restricts which tools
 * may be invoked for a given run (e.g. a read-only session omits
 * `initiate_checkout`); `maxSpendingAmountPerCall` caps the stroop amount a
 * single `initiate_checkout` call may request; `requireHumanApproval` forces
 * every spending call to be queued for approval rather than executed
 * immediately.
 */
export interface ToolCallGuardrailPolicy {
  allowedToolNames: string[];
  maxSpendingAmountPerCall: bigint;
  requireHumanApproval: boolean;
}

export const DEFAULT_GUARDRAIL_POLICY: ToolCallGuardrailPolicy = {
  allowedToolNames: ["search_products", "add_to_cart", "initiate_checkout"],
  maxSpendingAmountPerCall: 1_000_000_000n, // 100 XLM, in stroops
  requireHumanApproval: true,
};
