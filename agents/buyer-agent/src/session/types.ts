/**
 * Session state types — Issue #268
 */
import type { ChatMessage } from "../../../src/llm/index.js";

export type LLMMessage = ChatMessage;

export interface AgentSessionState {
  sessionId: string;
  userId: string;
  agentId: string;
  messages: LLMMessage[];
  activeProposalId?: string;
  lastActiveAt: number;
  totalTokensConsumed: number;
}

export interface CreateSessionInput {
  userId: string;
  agentId: string;
  /** Optional system prompt to pin at the front of every session. */
  systemPrompt?: string;
}

export interface AppendMessageInput {
  sessionId: string;
  message: LLMMessage;
  /** Tokens consumed by this turn — added to totalTokensConsumed. */
  tokensConsumed?: number;
}
