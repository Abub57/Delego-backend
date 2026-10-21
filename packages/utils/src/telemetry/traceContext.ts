import { randomBytes } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { TRACE_FLAG_SAMPLED, type TracingSpanContext } from "./types.js";

/** W3C Trace Context header name. */
export const TRACEPARENT_HEADER = "traceparent";
export const TRACESTATE_HEADER = "tracestate";

const TRACEPARENT_RE = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const ZERO_TRACE_ID = "0".repeat(32);
const ZERO_SPAN_ID = "0".repeat(16);

export function generateTraceId(): string {
  let id = randomBytes(16).toString("hex");
  while (id === ZERO_TRACE_ID) id = randomBytes(16).toString("hex");
  return id;
}

export function generateSpanId(): string {
  let id = randomBytes(8).toString("hex");
  while (id === ZERO_SPAN_ID) id = randomBytes(8).toString("hex");
  return id;
}

/** Serialize a span context as a W3C `traceparent` value (version 00). */
export function formatTraceparent(ctx: TracingSpanContext): string {
  const flags = (ctx.traceFlags & 0xff).toString(16).padStart(2, "0");
  return `00-${ctx.traceId}-${ctx.spanId}-${flags}`;
}

/**
 * Parse a W3C `traceparent` value. Returns `undefined` for malformed input
 * or all-zero ids. The parsed span id becomes the *parent* of any span
 * started from this context, so it is returned as `spanId`.
 */
export function parseTraceparent(value: string | undefined | null): TracingSpanContext | undefined {
  if (typeof value !== "string") return undefined;
  const match = TRACEPARENT_RE.exec(value.trim().toLowerCase());
  if (!match) return undefined;
  const [, version, traceId, spanId, flags] = match;
  if (version === "ff") return undefined;
  if (traceId === ZERO_TRACE_ID || spanId === ZERO_SPAN_ID) return undefined;
  return { traceId, spanId, traceFlags: parseInt(flags, 16) };
}

export function isSampled(ctx: TracingSpanContext): boolean {
  return (ctx.traceFlags & TRACE_FLAG_SAMPLED) === TRACE_FLAG_SAMPLED;
}

// ─── Active context (AsyncLocalStorage) ────────────────────────────────────

const storage = new AsyncLocalStorage<TracingSpanContext>();

export function getActiveContext(): TracingSpanContext | undefined {
  return storage.getStore();
}

export function runWithContext<T>(ctx: TracingSpanContext, fn: () => T): T {
  return storage.run(ctx, fn);
}
