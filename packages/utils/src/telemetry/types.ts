/**
 * Distributed tracing types (Issue #307).
 */

export interface TracingSpanContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  traceFlags: number;
}

export type SpanKind = "internal" | "server" | "client" | "producer" | "consumer";
export type SpanStatusCode = "unset" | "ok" | "error";
export type SpanAttributeValue = string | number | boolean;

export interface SpanData {
  name: string;
  kind: SpanKind;
  context: TracingSpanContext;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Record<string, SpanAttributeValue>;
  status: { code: SpanStatusCode; message?: string };
  serviceName: string;
}

export interface SpanExporter {
  export(spans: SpanData[]): Promise<void>;
  shutdown?(): Promise<void>;
}

export const TRACE_FLAG_SAMPLED = 0x01;
