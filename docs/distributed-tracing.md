# Distributed Tracing (Issue #307)

Traces flow Gateway → Orchestrator → Wallet using W3C Trace Context
(`traceparent`). Code lives in `packages/utils/src/telemetry/`.

## Enabling

Set on each service (tracing is a no-op when unset):

| Variable | Purpose |
| --- | --- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP/HTTP collector or Jaeger, e.g. `http://otel-collector:4318` |
| `OTEL_TRACES_SAMPLER_ARG` | Root-trace sample rate `0..1` (default `1`) |

Jaeger: run `jaegertracing/all-in-one` with `COLLECTOR_OTLP_ENABLED=true` and
point the endpoint at port `4318`.

## What is instrumented

- **Inbound HTTP** (`startHttpServer`): SERVER span continuing the caller's `traceparent`; the response echoes it.
- **Outbound HTTP** (`tracedFetch`): CLIENT span + `traceparent` header. Used by the Gateway service client and Orchestrator clients.
- **Redis pub/sub and streams**: `traceparent` is injected into message headers / stream metadata on publish; handlers run in a CONSUMER span that continues the publisher's trace.
- **Wallet**: `stellar.sendTransaction` span around on-chain submission.

## API

```ts
import { initTelemetry, tracedFetch, withSpan } from "@delegolabs/utils";
await initTelemetry("orchestrator");
await withSpan("my.operation", async () => { /* ... */ });
```
