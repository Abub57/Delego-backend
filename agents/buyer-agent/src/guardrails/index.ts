/**
 * guardrails/ — Issue #267
 *
 * Note: The stock alert rules migration/repository work described in the
 * issue is implemented under database/migrations and apps/backend/src/stock.
 * This barrel file is intentionally left unchanged in scope.
 */
export { GuardrailMiddleware, GuardrailValidationError } from "./middleware.js";
export type {
  GuardrailCheckResult,
  FlaggedCategory,
  ToolName,
  SanitizedPromptInput,
  ToolCallGuardrailPolicy,
} from "./types.js";
export {
  TOOL_SCHEMAS,
  SearchProductsParamsSchema,
  AddToCartParamsSchema,
  InitiateCheckoutParamsSchema,
  DEFAULT_GUARDRAIL_POLICY,
} from "./types.js";
