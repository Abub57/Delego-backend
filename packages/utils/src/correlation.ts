import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { getLogContext, runWithLogContext } from "./logger.js";

export const CORRELATION_ID_HEADER = "X-Correlation-ID";

export function correlationMiddleware(
  req: IncomingMessage,
  res: ServerResponse,
  next: (err?: unknown) => void,
): void {
  const incoming = req.headers[CORRELATION_ID_HEADER.toLowerCase()];
  const correlationId = (Array.isArray(incoming) ? incoming[0] : incoming)?.trim() || randomUUID();

  res.setHeader(CORRELATION_ID_HEADER, correlationId);
  runWithLogContext({ correlationId }, next);
}

export function fetchWithCorrelation(
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init?.headers).forEach((value, name) => headers.set(name, value));

  const correlationId = getLogContext().correlationId;
  if (correlationId) headers.set(CORRELATION_ID_HEADER, correlationId);

  return fetchImpl(input, { ...init, headers });
}