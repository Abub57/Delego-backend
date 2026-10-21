# Architecture

## Overview

This document describes the high-level architecture of the platform, including the
services that make up the backend, how they communicate, and the cross-cutting
concerns (observability, tracing, configuration) that apply to all of them.

## Backend Services

The backend is composed of several independently deployable applications that
communicate over HTTP and Redis streams:

- **API Gateway** — the public entry point. Terminates client requests and
  forwards them to the orchestrator.
- **Orchestrator** — coordinates workflows and fans out work to downstream
  services.
- **Payments** — handles payment processing and interacts with external
  providers.
- **Database** — persistent storage accessed by the services above.

A single request typically spans the gateway, orchestrator, payments, and the
database. Because these hops cross process and network boundaries, unified trace
context is required to debug cross-service latency.

## Distributed Tracing (OpenTelemetry)

End-to-end distributed tracing is implemented with OpenTelemetry. Every backend
application is instrumented so that a request can be followed from the API
gateway all the way down to database queries.

### SDK Configuration

Each backend app is configured with `@opentelemetry/sdk-node`. The SDK is
initialized at process startup, before any other application code, so that
auto-instrumentation can patch the relevant libraries. Configuration is driven
by a shared `TracedServiceConfig`:

```typescript
import { trace, context, SpanStatusCode } from "@opentelemetry/api";

export interface TracedServiceConfig {
  serviceName: string;
  collectorUrl: string;
  sampleRate: number;
}
```

- `serviceName` — the logical name of the service, attached to every span as the
  `service.name` resource attribute.
- `collectorUrl` — the OTLP endpoint of the OpenTelemetry collector (or Jaeger)
  that spans are exported to.
- `sampleRate` — the head sampling ratio applied to new traces.

### Context Propagation

Trace context is propagated across every hop so that spans from different
services are stitched into a single trace:

- **HTTP requests** — the W3C `traceparent` header is injected on outgoing
  requests and extracted on incoming requests. This covers gateway → orchestrator
  and orchestrator → payments calls.
- **Redis stream envelopes** — trace context is carried in the message envelope
  alongside the payload. Producers inject the current context when publishing;
  consumers extract it and start child spans, so asynchronous work remains part
  of the originating trace.

### Error Recording

Failed operations record their outcome on the span. When an operation fails, the
span status is set to `SpanStatusCode.ERROR` and the error is recorded on the
span (message and stack), ensuring failures are visible in the trace alongside
the latency data.

### Export

Spans are exported via OTLP to an OpenTelemetry collector. The collector can
forward traces to Jaeger or any other compatible backend, providing end-to-end
visibility from the API gateway to database queries.

## Observability Goals

- A single trace covers the full request path: gateway → orchestrator →
  payments → database.
- Cross-service latency can be attributed to a specific hop or query.
- Errors are captured with status codes and recorded on the relevant span.
- Traces are exportable to Jaeger / OpenTelemetry collectors.
