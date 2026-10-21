import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  InMemorySpanExporter,
  OtlpHttpSpanExporter,
  Tracer,
  buildOtlpPayload,
  extractTraceContext,
  formatTraceparent,
  getActiveContext,
  injectPubSubHeaders,
  injectTraceHeaders,
  parseTraceparent,
  setGlobalTracer,
  tracedFetch,
  withConsumerSpan,
  withSpan,
  type TracingSpanContext,
} from "./index.js";
import { RedisPubSubManager } from "../redis/pubsub.js";
import { startHttpServer, route, json } from "../http.js";

function setup(sampleRate = 1) {
  const exporter = new InMemorySpanExporter();
  const tracer = new Tracer({ serviceName: "test", exporter, sampleRate, flushIntervalMs: 0 });
  setGlobalTracer(tracer);
  return { exporter, tracer };
}

afterEach(() => setGlobalTracer(undefined));

describe("traceparent", () => {
  const ctx: TracingSpanContext = {
    traceId: "0af7651916cd43dd8448eb211c80319c",
    spanId: "b7ad6b7169203331",
    traceFlags: 1,
  };

  it("round-trips a W3C traceparent", () => {
    const header = formatTraceparent(ctx);
    expect(header).toBe("00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01");
    expect(parseTraceparent(header)).toEqual(ctx);
  });

  it.each([
    undefined,
    "",
    "garbage",
    "00-00000000000000000000000000000000-b7ad6b7169203331-01",
    "00-0af7651916cd43dd8448eb211c80319c-0000000000000000-01",
    "ff-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
  ])("rejects invalid value %s", (v) => {
    expect(parseTraceparent(v as string | undefined)).toBeUndefined();
  });
});

describe("Tracer", () => {
  it("links child spans to the parent and shares a trace id", async () => {
    const { exporter, tracer } = setup();
    await tracer.withSpan("root", async () => {
      await tracer.withSpan("child", async () => undefined);
    });
    await tracer.flush();
    const [child, root] = exporter.spans;
    expect(child.context.traceId).toBe(root.context.traceId);
    expect(child.context.parentSpanId).toBe(root.context.spanId);
    expect(root.context.parentSpanId).toBeUndefined();
  });

  it("marks failed spans as errors", async () => {
    const { exporter, tracer } = setup();
    await expect(tracer.withSpan("boom", async () => { throw new Error("x"); })).rejects.toThrow("x");
    await tracer.flush();
    expect(exporter.spans[0].status.code).toBe("error");
  });

  it("drops unsampled traces and propagates the decision to children", async () => {
    const { exporter, tracer } = setup(0);
    await tracer.withSpan("root", async () => {
      expect(getActiveContext()?.traceFlags).toBe(0);
      await tracer.withSpan("child", async () => undefined);
    });
    await tracer.flush();
    expect(exporter.spans).toHaveLength(0);
  });
});

describe("propagation", () => {
  it("injects nothing without an active span", () => {
    expect(injectTraceHeaders({ a: "b" })).toEqual({ a: "b" });
  });

  it("injects and extracts traceparent for the active span", async () => {
    const { tracer } = setup();
    await tracer.withSpan("root", async (span) => {
      const headers = injectPubSubHeaders({ x: "1" });
      expect(extractTraceContext(headers)).toEqual(span.context);
    });
  });

  it("tracedFetch sends traceparent and records a client span", async () => {
    const { exporter, tracer } = setup();
    const server = createServer((req, res) => {
      res.end(String(req.headers.traceparent));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    try {
      const body = await tracer.withSpan("root", async () => {
        const res = await tracedFetch(`http://127.0.0.1:${port}/x`);
        return res.text();
      });
      await tracer.flush();
      const client = exporter.spans.find((s) => s.kind === "client")!;
      expect(body).toBe(formatTraceparent(client.context));
      expect(client.attributes["http.status_code"]).toBe(200);
    } finally {
      server.close();
    }
  });

  it("tracedFetch is a plain fetch without a tracer", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
    await tracedFetch("http://example.test/", { method: "POST" });
    expect(spy).toHaveBeenCalledWith("http://example.test/", { method: "POST" });
    spy.mockRestore();
  });

  it("consumer span continues the publisher's trace", async () => {
    const { exporter, tracer } = setup();
    let headers: Record<string, string> = {};
    await tracer.withSpan("publish", async () => {
      headers = injectPubSubHeaders();
    });
    await withConsumerSpan(headers, "orders", {}, async () => undefined);
    await tracer.flush();
    const pub = exporter.spans.find((s) => s.name === "publish")!;
    const cons = exporter.spans.find((s) => s.kind === "consumer")!;
    expect(cons.context.traceId).toBe(pub.context.traceId);
    expect(cons.context.parentSpanId).toBe(pub.context.spanId);
  });
});

describe("end-to-end: gateway -> orchestrator -> (redis) -> wallet", () => {
  it("produces one connected trace", async () => {
    const { exporter, tracer } = setup();

    const wallet = startHttpServer({
      port: 0,
      host: "127.0.0.1",
      serviceName: "wallet",
      routes: [
        route("POST", "/submit", async (_req, res) => {
          await withSpan("stellar.sendTransaction", async () => undefined);
          json(res, 200, { data: { ok: true }, error: null });
        }),
      ],
    });
    await new Promise((r) => wallet.once("listening", r));
    const walletPort = (wallet.address() as AddressInfo).port;

    const orchestrator = startHttpServer({
      port: 0,
      host: "127.0.0.1",
      serviceName: "orchestrator",
      routes: [
        route("POST", "/purchase", async (_req, res) => {
          const r = await tracedFetch(`http://127.0.0.1:${walletPort}/submit`, { method: "POST" });
          json(res, r.status, { data: null, error: null });
        }),
      ],
    });
    await new Promise((r) => orchestrator.once("listening", r));
    const orchPort = (orchestrator.address() as AddressInfo).port;

    try {
      await tracer.withSpan("gateway.request", async () => {
        const res = await tracedFetch(`http://127.0.0.1:${orchPort}/purchase`, { method: "POST" });
        expect(res.status).toBe(200);
      }, { kind: "server" });
      await new Promise((r) => setTimeout(r, 20));
      await tracer.flush();

      const traceIds = new Set(exporter.spans.map((s) => s.context.traceId));
      expect(traceIds.size).toBe(1);
      const names = exporter.spans.map((s) => s.name);
      expect(names).toContain("stellar.sendTransaction");
      const byId = new Map(exporter.spans.map((s) => [s.context.spanId, s]));
      const submit = exporter.spans.find((s) => s.name === "stellar.sendTransaction")!;
      const chain: string[] = [];
      for (let s: typeof submit | undefined = submit; s; s = s.context.parentSpanId ? byId.get(s.context.parentSpanId) : undefined) {
        chain.push(s.name);
      }
      expect(chain[chain.length - 1]).toBe("gateway.request");
      expect(chain.length).toBeGreaterThanOrEqual(5);
    } finally {
      wallet.close();
      orchestrator.close();
    }
  });
});

describe("pub/sub trace propagation", () => {
  it("carries traceparent from publish to the subscriber", async () => {
    const { exporter, tracer } = setup();
    const manager = new RedisPubSubManager({ url: "memory://" } as never);
    // The in-memory mock uses separate publisher/subscriber instances; loop
    // published messages straight back into handleMessage (what ioredis would do).
    (manager as unknown as { publisher: { publish(c: string, m: string): Promise<number> } }).publisher.publish =
      async (c, m) => {
        await manager.handleMessage(c, m);
        return 1;
      };
    let seen: string | undefined;
    await manager.subscribe("orders", async (msg) => {
      seen = msg.headers.traceparent;
    });
    await tracer.withSpan("publisher", async () => {
      await manager.publish("orders", "order.created", { id: 1 });
    });
    await tracer.flush();
    expect(seen).toBeDefined();
    const pub = exporter.spans.find((s) => s.name === "publisher")!;
    const cons = exporter.spans.find((s) => s.kind === "consumer")!;
    expect(cons.context.traceId).toBe(pub.context.traceId);
    await manager.close();
  });
});

describe("OTLP exporter", () => {
  it("posts OTLP JSON to /v1/traces", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const exporter = new OtlpHttpSpanExporter({ endpoint: "http://collector:4318/", fetchImpl });
    const mem = new InMemorySpanExporter();
    const tracer = new Tracer({ serviceName: "gateway", exporter: mem, flushIntervalMs: 0 });
    const span = tracer.startSpan("op", { attributes: { n: 1, ok: true, s: "x" } });
    span.end();
    await tracer.flush();
    await exporter.export(mem.spans);

    expect(fetchImpl.mock.calls[0][0]).toBe("http://collector:4318/v1/traces");
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    const otlpSpan = body.resourceSpans[0].scopeSpans[0].spans[0];
    expect(otlpSpan.traceId).toBe(span.context.traceId);
    expect(body.resourceSpans[0].resource.attributes[0].value.stringValue).toBe("gateway");
    expect(buildOtlpPayload([])).toEqual({ resourceSpans: [] });
  });

  it("scrubs PII from span attributes before building the OTLP payload (#355)", () => {
    const secret = `S${"C".repeat(55)}`;
    const payload = buildOtlpPayload([
      {
        name: "op",
        kind: "internal",
        context: { traceId: "t1", spanId: "s1", traceFlags: 1 },
        startTimeUnixNano: "0",
        endTimeUnixNano: "1",
        attributes: {
          "customer.email": "buyer@example.com",
          "stellar.secret": secret,
          "http.status_code": 200,
        },
        status: { code: "error", message: `failed for buyer@example.com using ${secret}` },
        serviceName: "gateway",
      },
    ]);

    const otlpSpan = (payload as any).resourceSpans[0].scopeSpans[0].spans[0];
    const attrs = Object.fromEntries(
      otlpSpan.attributes.map((a: any) => [a.key, a.value.stringValue ?? a.value.intValue])
    );
    expect(attrs["customer.email"]).toBe("[REDACTED]");
    expect(attrs["stellar.secret"]).toBe("[REDACTED]");
    expect(attrs["http.status_code"]).toBe("200");
    expect(otlpSpan.status.message).not.toContain(secret);
    expect(otlpSpan.status.message).not.toContain("buyer@example.com");
  });

  it("throws on non-2xx so the tracer can report it", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("no", { status: 503 }));
    const exporter = new OtlpHttpSpanExporter({ endpoint: "http://c:4318", fetchImpl });
    const mem = new InMemorySpanExporter();
    const tracer = new Tracer({ serviceName: "s", exporter: mem, flushIntervalMs: 0 });
    tracer.startSpan("a").end();
    await tracer.flush();
    await expect(exporter.export(mem.spans)).rejects.toThrow("503");
  });
});
