/**
 * Shared types for LLM client runtimes.
 * Issues #9, #261: unified interface supporting streaming, function calling, and multi-provider.
 */

export type LLMProviderName = "openai" | "anthropic" | "gemini";
export type LlmProvider = LLMProviderName;

/** @deprecated Use LLMProviderName */
export type LLMProvider = LLMProviderName;

export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface LLMMessage {
  role: MessageRole;
  content: string;
  toolCallId?: string;
  name?: string;
}

/** @deprecated Use LLMMessage */
export type ChatMessage = LLMMessage;

/** JSON Schema–based tool definition passed to the LLM. */
export interface LLMToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the tool parameters. */
  parameters: Record<string, unknown>;
}

/** Represents a single tool-call decision emitted by the model. */
export interface LLMToolCallResponse {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** Options forwarded to the provider for a completion request. */
export interface LLMCompletionOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  /** Tool definitions exposed to the model for function calling. */
  tools?: LLMToolDefinition[];
  /** Enable server-sent-events streaming (provider must support it). */
  stream?: boolean;
}

/** Token usage counters returned with every completion. */
export interface LLMUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** Result of a non-streaming completion call. */
export interface LLMCompletionResult {
  content: string;
  toolCalls?: LLMToolCallResponse[];
  usage: LLMUsage;
  finishReason?: "stop" | "length" | "tool_calls" | "error";
}

// ---------------------------------------------------------------------------
// Legacy types kept for backward compatibility with existing clients
// ---------------------------------------------------------------------------

export interface LLMRequestOptions {
  model?: string;
  messages: LLMMessage[];
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  tokenBudget?: number;
  tools?: LLMToolDefinition[];
  stream?: boolean;
  preferredProvider?: LLMProviderName;
  fallbackChain?: LLMProviderName[];
}

export interface LlmRequestOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  preferredProvider?: LlmProvider;
  fallbackChain?: LlmProvider[];
}

export interface LLMResponse {
  provider: LLMProviderName;
  model: string;
  content: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  finishReason: "stop" | "length" | "tool_calls" | "error";
  toolCalls?: LLMToolCallResponse[];
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface LLMClientConfig {
  apiKey: string;
  /** Max attempts before giving up (default: 3). */
  maxRetries?: number;
  /** Base delay in ms for exponential back-off (default: 1000). */
  baseDelayMs?: number;
  /** Per-request timeout in ms (default: 30_000). */
  timeoutMs?: number;
}

export interface LLMProviderMetrics {
  provider: LLMProviderName;
  requests: number;
  failures: number;
  errors: number;
  totalLatencyMs: number;
  avgLatencyMs: number;
  errorRate: number;
}

export interface LLMClient {
  provider: LLMProviderName;
  chat(options: LLMRequestOptions): Promise<LLMResponse>;
  getMetrics?(): LLMProviderMetrics[];
}
