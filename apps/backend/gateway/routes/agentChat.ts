import type { IncomingMessage, ServerResponse } from "node:http";
import type { Route } from "@delegolabs/utils";
import { route, createLogger, generateId } from "@delegolabs/utils";
import { extractAuth } from "../middleware/auth.js";
import { getRequestContext } from "../middleware/requestId.js";
import { validateSchema, AgentChatSchema } from "../src/validation.js";
import { readJsonBody, InvalidJsonError, BodyTooLargeError } from "../src/request.js";
import { badRequest, unauthorized, sendApiError } from "../src/errors.js";
import { sseClientPool } from "../src/sse/clientPool.js";
import type { LLMMessage } from "@delegolabs/types";

const log = createLogger("gateway:agent-chat", process.env.LOG_LEVEL ?? "info");

export type SSEEvent =
  | { event: "token"; data: { text: string } }
  | { event: "tool_start"; data: { tool: string; input: Record<string, unknown> } }
  | { event: "tool_end"; data: { tool: string; output: Record<string, unknown> } }
  | { event: "proposal"; data: { proposalId: string; orderId: string } }
  | { event: "done"; data: { runId: string } }
  | { event: "error"; data: { message: string } };

export interface TokenChunk {
  type: "token";
  text: string;
}

export interface ToolStartEvent {
  type: "tool_start";
  tool: string;
  input: Record<string, unknown>;
}

export interface ToolEndEvent {
  type: "tool_end";
  tool: string;
  output: Record<string, unknown>;
}

export interface ProposalEvent {
  type: "proposal";
  proposalId: string;
  orderId: string;
}

export interface DoneEvent {
  type: "done";
  runId: string;
}

export interface ErrorEvent {
  type: "error";
  message: string;
}

export type StreamEvent =
  | TokenChunk
  | ToolStartEvent
  | ToolEndEvent
  | ProposalEvent
  | DoneEvent
  | ErrorEvent;

export type LLMStreamGenerator = AsyncGenerator<StreamEvent, void, unknown>;

export interface ChatServiceConfig {
  streamProvider?: (
    agentId: string,
    messages: LLMMessage[],
    opts?: {
      delegationId?: string;
      tools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
      userId?: string;
      runId?: string;
    },
  ) => LLMStreamGenerator;
}

const defaultStreamProvider: ChatServiceConfig["streamProvider"] = async function* defaultStream() {
  return;
};

let configuredStreamProvider: NonNullable<ChatServiceConfig["streamProvider"]> =
  defaultStreamProvider as NonNullable<ChatServiceConfig["streamProvider"]>;

export function configureAgentChatService(config: ChatServiceConfig): void {
  if (config.streamProvider) {
    configuredStreamProvider = config.streamProvider;
  }
}

export function formatSSE(ev: SSEEvent): string {
  const dataJson = JSON.stringify(ev.data);
  return `event: ${ev.event}\ndata: ${dataJson}\n\n`;
}

export function streamEventToSSE(ev: StreamEvent): string | null {
  switch (ev.type) {
    case "token":
      return formatSSE({ event: "token", data: { text: ev.text } });
    case "tool_start":
      return formatSSE({ event: "tool_start", data: { tool: ev.tool, input: ev.input } });
    case "tool_end":
      return formatSSE({ event: "tool_end", data: { tool: ev.tool, output: ev.output } });
    case "proposal":
      return formatSSE({ event: "proposal", data: { proposalId: ev.proposalId, orderId: ev.orderId } });
    case "done":
      return formatSSE({ event: "done", data: { runId: ev.runId } });
    case "error":
      return formatSSE({ event: "error", data: { message: ev.message } });
    default:
      return null;
  }
}

export async function pipeLLMStreamToResponse(
  res: ServerResponse,
  generator: LLMStreamGenerator,
  runId: string,
  sessionId?: string,
): Promise<void> {
  let flushedDone = false;

  try {
    for await (const ev of generator) {
      if (res.destroyed) {
        log.info("Client disconnected, aborting stream", { runId });
        return;
      }

      const frame = streamEventToSSE(ev);
      if (!frame) continue;

      res.write(frame);
      if (sessionId) sseClientPool.touch(sessionId);

      if (ev.type === "done") {
        flushedDone = true;
      }
    }

    if (!flushedDone && !res.destroyed) {
      const finalFrame = formatSSE({ event: "done", data: { runId } });
      res.write(finalFrame);
    }
  } catch (err: any) {
    if (!res.destroyed) {
      const errorFrame = formatSSE({
        event: "error",
        data: { message: err instanceof Error ? err.message : String(err) },
      });
      res.write(errorFrame);
      const doneFrame = formatSSE({ event: "done", data: { runId } });
      res.write(doneFrame);
    }
    throw err;
  } finally {
    if (!res.destroyed) {
      res.end();
    }
  }
}

export async function agentChatHandler(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
): Promise<void> {
  const requestId = getRequestContext(req)?.requestId ?? generateId();
  const agentId = params.agentId;
  const runId = generateId();

  if (!agentId) {
    badRequest(res, "agentId path parameter is required", req);
    return;
  }

  try {
    const auth = extractAuth(req);
    if (!auth.userId) {
      unauthorized(res, "Authentication required", req);
      return;
    }

    const body = await readJsonBody(req);
    const validation = validateSchema(AgentChatSchema, body);
    if (!validation.valid) {
      badRequest(res, "Invalid request body", req, validation.errors);
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "X-Run-Id": runId,
      "X-Request-Id": requestId,
    });

    res.write(`: connected run=${runId}\n\n`);
    if ((res as any).flush) {
      (res as any).flush();
    }

    // Track this connection in the SSE client pool (#337) so it's heartbeat
    // -checked and reliably cleaned up even if the client disconnects
    // behind a proxy that never surfaces req 'close'.
    sseClientPool.register(req, res, { sessionId: runId, userId: auth.userId });

    const messages: LLMMessage[] = body.messages as LLMMessage[];

    const generator = configuredStreamProvider(agentId, messages, {
      delegationId: body.delegationId,
      tools: body.tools,
      userId: auth.userId,
      runId,
    });

    log.info("Starting agent chat stream", {
      runId,
      agentId,
      userId: auth.userId,
      messageCount: messages.length,
    });

    await pipeLLMStreamToResponse(res, generator, runId, runId);

    log.info("Agent chat stream completed", {
      runId,
      agentId,
      userId: auth.userId,
    });
    sseClientPool.remove(runId);
  } catch (err: any) {
    if (err instanceof InvalidJsonError || err instanceof BodyTooLargeError) {
      if (!res.headersSent) {
        badRequest(res, err.message, req);
      } else if (!res.destroyed) {
        res.write(formatSSE({ event: "error", data: { message: err.message } }));
        res.end();
      }
      return;
    }

    log.error("Agent chat stream failed", {
      runId,
      agentId,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });

    if (!res.headersSent) {
      sendApiError(res, 500, "AGENT_CHAT_FAILED",
        err instanceof Error ? err.message : "Agent chat stream failed", req);
      return;
    }

    if (!res.destroyed) {
      try {
        res.write(formatSSE({
          event: "error",
          data: { message: err instanceof Error ? err.message : "Agent chat stream failed" },
        }));
        res.write(formatSSE({ event: "done", data: { runId } }));
      } catch (_) {
        // ignore write errors during cleanup
      }
      res.end();
    }
  }
}

export function registerAgentChatRoutes(): Route[] {
  return [
    route("POST", "/api/v1/agents/:agentId/chat", agentChatHandler),
  ];
}
