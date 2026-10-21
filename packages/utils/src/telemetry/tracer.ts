import {
  formatTraceparent,
  generateSpanId,
  generateTraceId,
  getActiveContext,
  isSampled,
  runWithContext,
} from "./traceContext.js";
import {
  TRACE_FLAG_SAMPLED,
  type SpanAttributeValue,
  type SpanData,
  type SpanExporter,
  type SpanKind,
  type SpanStatusCode,
  type TracingSpanContext,
} from "./types.js";

export interface TracerOptions {
  serviceName: string;
  exporter: SpanExporter;
  /** Probability [0,1] for new root traces. Child spans follow their parent. Default 1. */
  sampleRate?: number;
  maxBatchSize?: number;
  flushIntervalMs?: number;
  onExportError?: (err: Error) => void;
}

export interface StartSpanOptions {
  kind?: SpanKind;
  attributes?: Record<string, SpanAttributeValue>;
  /** Explicit parent (e.g. extracted from headers). Defaults to the active context. */
  parent?: TracingSpanContext;
}

export class Span {
  private ended = false;
  private status: { code: SpanStatusCode; message?: string } = { code: "unset" };
  private readonly attributes: Record<string, SpanAttributeValue>;
  private readonly startNs: bigint;

  constructor(
    readonly name: string,
    readonly kind: SpanKind,
    readonly context: TracingSpanContext,
    private readonly tracer: Tracer,
    attributes: Record<string, SpanAttributeValue> = {},
  ) {
    this.attributes = { ...attributes };
    this.startNs = BigInt(Date.now()) * 1_000_000n;
  }

  setAttribute(key: string, value: SpanAttributeValue): this {
    if (!this.ended) this.attributes[key] = value;
    return this;
  }

  setStatus(code: SpanStatusCode, message?: string): this {
    // An error status is never downgraded back to ok.
    if (!this.ended && this.status.code !== "error") this.status = { code, message };
    return this;
  }

  recordError(err: unknown): this {
    const message = err instanceof Error ? err.message : String(err);
    this.setAttribute("error", true);
    this.setAttribute("error.message", message);
    return this.setStatus("error", message);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.tracer.record({
      name: this.name,
      kind: this.kind,
      context: this.context,
      startTimeUnixNano: this.startNs.toString(),
      endTimeUnixNano: (BigInt(Date.now()) * 1_000_000n).toString(),
      attributes: this.attributes,
      status: this.status,
      serviceName: this.tracer.serviceName,
    });
  }
}

export class Tracer {
  readonly serviceName: string;
  private readonly exporter: SpanExporter;
  private readonly sampleRate: number;
  private readonly maxBatchSize: number;
  private readonly onExportError?: (err: Error) => void;
  private buffer: SpanData[] = [];
  private timer?: NodeJS.Timeout;

  constructor(options: TracerOptions) {
    this.serviceName = options.serviceName;
    this.exporter = options.exporter;
    this.sampleRate = options.sampleRate ?? 1;
    this.maxBatchSize = options.maxBatchSize ?? 64;
    this.onExportError = options.onExportError;
    const interval = options.flushIntervalMs ?? 5000;
    if (interval > 0) {
      this.timer = setInterval(() => void this.flush(), interval);
      this.timer.unref();
    }
  }

  startSpan(name: string, options: StartSpanOptions = {}): Span {
    const parent = options.parent ?? getActiveContext();
    let context: TracingSpanContext;
    if (parent) {
      context = {
        traceId: parent.traceId,
        spanId: generateSpanId(),
        parentSpanId: parent.spanId,
        traceFlags: parent.traceFlags,
      };
    } else {
      const sampled = Math.random() < this.sampleRate;
      context = {
        traceId: generateTraceId(),
        spanId: generateSpanId(),
        traceFlags: sampled ? TRACE_FLAG_SAMPLED : 0,
      };
    }
    return new Span(name, options.kind ?? "internal", context, this, options.attributes);
  }

  /** Run `fn` inside a new span that is the active context; ends the span afterwards. */
  async withSpan<T>(
    name: string,
    fn: (span: Span) => Promise<T> | T,
    options: StartSpanOptions = {},
  ): Promise<T> {
    const span = this.startSpan(name, options);
    try {
      const result = await runWithContext(span.context, () => fn(span));
      span.setStatus("ok");
      return result;
    } catch (err) {
      span.recordError(err);
      throw err;
    } finally {
      span.end();
    }
  }

  /** @internal called by Span.end() */
  record(data: SpanData): void {
    if (!isSampled(data.context)) return;
    this.buffer.push(data);
    if (this.buffer.length >= this.maxBatchSize) void this.flush();
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];
    try {
      await this.exporter.export(batch);
    } catch (err) {
      this.onExportError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }

  async shutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.flush();
    await this.exporter.shutdown?.();
  }

  /** Current `traceparent` header value for the active context, if any. */
  currentTraceparent(): string | undefined {
    const ctx = getActiveContext();
    return ctx ? formatTraceparent(ctx) : undefined;
  }
}

// ─── Global tracer (no-op until configured) ────────────────────────────────

let globalTracer: Tracer | undefined;

export function setGlobalTracer(tracer: Tracer | undefined): void {
  globalTracer = tracer;
}

export function getGlobalTracer(): Tracer | undefined {
  return globalTracer;
}

/**
 * Create and register a tracer from env vars:
 * `OTEL_EXPORTER_OTLP_ENDPOINT` (tracing disabled if unset),
 * `OTEL_TRACES_SAMPLER_ARG` (sample rate, default 1).
 */
export async function initTelemetry(
  serviceName: string,
  overrides: Partial<TracerOptions> = {},
): Promise<Tracer | undefined> {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint && !overrides.exporter) return undefined;
  const { OtlpHttpSpanExporter } = await import("./exporter.js");
  const rate = Number(process.env.OTEL_TRACES_SAMPLER_ARG ?? "1");
  const tracer = new Tracer({
    serviceName,
    exporter: overrides.exporter ?? new OtlpHttpSpanExporter({ endpoint: endpoint! }),
    sampleRate: Number.isFinite(rate) ? Math.min(1, Math.max(0, rate)) : 1,
    ...overrides,
  });
  setGlobalTracer(tracer);
  return tracer;
}
