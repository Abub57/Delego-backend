import type { SpanAttributeValue, SpanData, SpanExporter } from "./types.js";
import { maskPii } from "../piiMasking.js";

/**
 * Scrub PII (emails, phone numbers, credit card / bank identifiers, Stellar
 * secret keys) out of a span's name, string attributes, and status message
 * before it is published to the collector — see #355. Non-string attribute
 * values are left untouched.
 */
function scrubSpan(span: SpanData): SpanData {
  const attributes: Record<string, SpanAttributeValue> = {};
  for (const [key, value] of Object.entries(span.attributes)) {
    attributes[key] = typeof value === "string" ? maskPii(value) : value;
  }

  return {
    ...span,
    name: maskPii(span.name),
    attributes,
    status: {
      ...span.status,
      ...(span.status.message ? { message: maskPii(span.status.message) } : {}),
    },
  };
}

/** Collects spans in memory — for tests and local debugging. */
export class InMemorySpanExporter implements SpanExporter {
  readonly spans: SpanData[] = [];
  async export(spans: SpanData[]): Promise<void> {
    this.spans.push(...spans);
  }
  reset(): void {
    this.spans.length = 0;
  }
}

export interface OtlpHttpExporterOptions {
  /**
   * Collector base URL (e.g. `http://otel-collector:4318`) or a full
   * `/v1/traces` URL. Jaeger accepts OTLP/HTTP on 4318 as well.
   */
  endpoint: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const KIND_MAP = { internal: 1, server: 2, client: 3, producer: 4, consumer: 5 } as const;
const STATUS_MAP = { unset: 0, ok: 1, error: 2 } as const;

function toAnyValue(value: SpanAttributeValue): Record<string, unknown> {
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number") {
    return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  }
  return { stringValue: value };
}

/** Build an OTLP/HTTP JSON `ExportTraceServiceRequest` body. */
export function buildOtlpPayload(spans: SpanData[]): Record<string, unknown> {
  const byService = new Map<string, SpanData[]>();
  for (const rawSpan of spans) {
    const span = scrubSpan(rawSpan);
    const list = byService.get(span.serviceName) ?? [];
    list.push(span);
    byService.set(span.serviceName, list);
  }

  return {
    resourceSpans: [...byService.entries()].map(([serviceName, list]) => ({
      resource: {
        attributes: [{ key: "service.name", value: { stringValue: serviceName } }],
      },
      scopeSpans: [
        {
          scope: { name: "@delegolabs/utils/telemetry" },
          spans: list.map((s) => ({
            traceId: s.context.traceId,
            spanId: s.context.spanId,
            ...(s.context.parentSpanId ? { parentSpanId: s.context.parentSpanId } : {}),
            name: s.name,
            kind: KIND_MAP[s.kind],
            flags: s.context.traceFlags,
            startTimeUnixNano: s.startTimeUnixNano,
            endTimeUnixNano: s.endTimeUnixNano,
            attributes: Object.entries(s.attributes).map(([key, value]) => ({
              key,
              value: toAnyValue(value),
            })),
            status: {
              code: STATUS_MAP[s.status.code],
              ...(s.status.message ? { message: s.status.message } : {}),
            },
          })),
        },
      ],
    })),
  };
}

/** Exports spans to an OpenTelemetry collector / Jaeger via OTLP/HTTP JSON. */
export class OtlpHttpSpanExporter implements SpanExporter {
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OtlpHttpExporterOptions) {
    const base = options.endpoint.replace(/\/+$/, "");
    this.url = base.endsWith("/v1/traces") ? base : `${base}/v1/traces`;
    this.headers = { "content-type": "application/json", ...options.headers };
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async export(spans: SpanData[]): Promise<void> {
    if (spans.length === 0) return;
    const res = await this.fetchImpl(this.url, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(buildOtlpPayload(spans)),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      throw new Error(`OTLP export failed with status ${res.status}`);
    }
  }
}
