/** Shared LLM runtime message types. */

export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface LLMMessage {
  role: MessageRole;
  content: string;
  toolCallId?: string;
  name?: string;
}
