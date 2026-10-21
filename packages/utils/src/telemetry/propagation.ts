import type { IncomingMessage, ServerResponse } from "node:http";
import {
  TRACEPARENT_HEADER,
  formatTraceparent,
  getActiveContext,
  parseTraceparent,
  runWithContext,
} from "./traceContext.js";
import { getGlobalTracer } from "./tracer.js";
import type { TracingSpanContext } from "./types.js";
import { CORRELATION_ID_HEADER } from "../correlation.js";
import { getLogContext } from "../logger.js";

type HeaderBag = Record<string, string | string[] | undefined>;

/** Add `traceparent` for the active span (no-op without an active context). */
export function injectTraceHeaders<T extends Record<string, string>>(headers: T = {} as T): T {
  const ctx = getActiveContext();
  if (!ctx) return headers;
  return { ...headers, [TRACEPARENT_HEADER]: formatTraceparent(ctx) };
}

/** Read a `traceparent` from HTTP headers or pub/sub message headers. */
export function extractTraceContext(headers: HeaderBag | undefined): TracingSpanContext | undefined {
  if (!headers) return undefined;
  const raw = headers[TRACEPARENT_HEADER] ?? headers["Traceparent"];
  return parseTraceparent(Array.isArray(raw) ? raw[0] : raw);
}

/** Inject `traceparent` into Redis pub/sub message headers. */
export function injectPubSubHeaders(headers: Record<string, string> = {}): Record<string, string> {
  return injectTraceHeaders(headers);
}

/**
 * `fetch` wrapper: creates a CLIENT span and sends `traceparent` downstream.
 * Behaves exactly like `fetch` when no global tracer is configured.
 */
export async function tracedFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  const tracer = getGlobalTracer();
  const correlationId = getLogContext().correlationId;
  if (!tracer && !correlationId) return fetch(input, init);

  const url = new URL(input.toString());
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  if (correlationId) headers.set(CORRELATION_ID_HEADER, correlationId);
  if (!tracer) return fetch(input, { ...init, headers });

  return tracer.withSpan(
    `HTTP ${method}`,
    async (span) => {
      const headers = new Headers(init.headers);
      if (correlationId) headers.set(CORRELATION_ID_HEADER, correlationId);
      headers.set(TRACEPARENT_HEADER, formatTraceparent(span.context));
      const res = await fetch(input, { ...init, headers });
      span.setAttribute("http.status_code", res.status);
      if (res.status >= 400) span.recordError(new Error(`HTTP ${res.status}`));
      return res;
    },
    {
      kind: "client",
      attributes: { "http.method": method, "http.url": `${url.origin}${url.pathname}` },
    },
  );
}

/**
 * Wrap the incoming HTTP request in a SERVER span that continues the caller's
 * trace (via `traceparent`) and is the active context for `handler`.
 */
export async function withServerSpan(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  handler: () => Promise<void>,
): Promise<void> {
  const tracer = getGlobalTracer();
  if (!tracer) return handler();

  const method = req.method ?? "GET";
  const span = tracer.startSpan(`${method} ${pathname}`, {
    kind: "server",
    parent: extractTraceContext(req.headers),
    attributes: { "http.method": method, "http.target": pathname },
  });
  res.once("finish", () => {
    span.setAttribute("http.status_code", res.statusCode);
    if (res.statusCode >= 500) span.recordError(new Error(`HTTP ${res.statusCode}`));
    else span.setStatus("ok");
    span.end();
  });
  res.once("close", () => span.end());
  res.setHeader(TRACEPARENT_HEADER, formatTraceparent(span.context));
  try {
    await runWithContext(span.context, handler);
  } catch (err) {
    span.recordError(err);
    throw err;
  }
}

/** Run a pub/sub handler inside a CONSUMER span continuing the publisher's trace. */
export async function withConsumerSpan<T>(
  headers: Record<string, string> | undefined,
  name: string,
  attributes: Record<string, string>,
  fn: () => Promise<T>,
): Promise<T> {
  const tracer = getGlobalTracer();
  if (!tracer) return fn();
  return tracer.withSpan(`consume ${name}`, fn, {
    kind: "consumer",
    parent: extractTraceContext(headers),
    attributes: { "messaging.system": "redis", ...attributes },
  });
}

/** Run `fn` in a child span of the active context (no-op without a tracer). */
export async function withSpan<T>(
  name: string,
  fn: () => Promise<T>,
  attributes: Record<string, string | number | boolean> = {},
): Promise<T> {
  const tracer = getGlobalTracer();
  if (!tracer) return fn();
  return tracer.withSpan(name, fn, { attributes });
}
