# SDK Telemetry Hooks

> **Issue #362**: Add opt-in telemetry hooks for error and performance monitoring
> **Issue #903**: Add SDK metrics export in Prometheus format
> **Issue #1179**: Add distributed tracing support

## Overview

The telemetry hooks system allows application developers to integrate their own monitoring solutions (Sentry, Datadog, custom telemetry) without the SDK having any direct dependencies on third-party monitoring libraries.

All hooks are **fire-and-forget** — exceptions within hooks do not propagate to SDK callers, ensuring your monitoring code never breaks your application.

## Features

- ✅ `onError` hook called before every SDK error is thrown
- ✅ `onCallStart` hook called before each RPC call
- ✅ `onCallEnd` hook called after each RPC call (success or failure)
- ✅ Fire-and-forget semantics (hook exceptions are logged but don't propagate)
- ✅ Full TypeScript type safety
- ✅ Zero dependencies
- ✅ Opt-in (no performance impact when not configured)
- ✅ Prometheus-format metrics export (see [Prometheus Metrics Export](#prometheus-metrics-export))
- ✅ Distributed tracing via W3C Trace Context (see [Distributed Tracing](#distributed-tracing))

## Installation

Telemetry hooks are included in the main SDK package:

```typescript
import { StellarSplitClient } from "@stellar-split/sdk";
import type {
  TelemetryHooks,
  TelemetryErrorContext,
  TelemetryCallStartParams,
  TelemetryCallEndParams,
} from "@stellar-split/sdk";
```

## Basic Usage

### Register Hooks

```typescript
const client = new StellarSplitClient({
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
  contractId: "CBQHNAXSI55GX2GN6D67GK7BHVPSLJUGZQEU7WJ5LKR5PNUCGLIMAO4K",
});

client.setTelemetryHooks({
  onError: (error, context) => {
    console.error(`[${context.method}] Error:`, error.message);
  },
  onCallStart: ({ method, timestamp }) => {
    console.log(`[${timestamp}] Starting ${method}`);
  },
  onCallEnd: ({ method, durationMs, success }) => {
    console.log(`[${method}] Completed in ${durationMs}ms (${success ? "✓" : "✗"})`);
  },
});
```

### Clear Hooks

```typescript
client.clearTelemetryHooks();
```

## Distributed Tracing

> **Issue #1179**: Add distributed tracing support

The SDK supports distributed tracing using the [W3C Trace Context](https://www.w3.org/TR/trace-context/)
specification. This is the same propagation format used by OpenTelemetry, so traces
flow seamlessly into any OTel-compatible backend (Jaeger, Tempo, Honeycomb, Datadog, etc.)
without adding a hard dependency on an OpenTelemetry SDK.

### How It Works

- **Trace propagation** — the SDK reads an incoming `traceparent` header (or an
explicit trace context) and continues that trace. Outgoing RPC calls carry the
`traceparent` header so downstream services join the same trace.
- **Span creation** — each tracked SDK operation (`onCallStart` → `onCallEnd`) is
wrapped in a span with the operation name, start/end timestamps, and status.
- **Sampling** — a configurable sampler decides which traces are recorded. The
sampling decision is encoded in the `traceparent` flags so it propagates.
- **Export** — completed spans are handed to your exporter (OTel, Jaeger, console,
  or a custom sink) via the `onSpanEnd` hook.

### Configuring Tracing

```typescript
import { createTracer } from "@stellar-split/sdk";

const tracer = createTracer({
  serviceName: "stellar-split-sdk",
  // Sample 10% of traces; always sample errors.
  sampler: { type: "ratio", ratio: 0.1 },
  // Export finished spans to your backend.
  exporter: (span) => {
    // e.g. forward to an OTel collector over OTLP/HTTP
    fetch("http://localhost:4318/v1/traces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(span),
    });
  },
});

client.setTelemetryHooks({
  onCallStart: tracer.onCallStart,
  onCallEnd: tracer.onCallEnd,
  onError: tracer.onError,
});
```

### Propagating an Incoming Trace

When the SDK is called from within an existing request (e.g. an HTTP handler),
pass the incoming `traceparent` so the SDK continues the same trace:

```typescript
app.post("/invoices", async (req, res) => {
  const client = new StellarSplitClient({
    /* ... */
    traceContext: req.headers["traceparent"],
  });
  const invoice = await client.createInvoice(/* ... */);
  res.json(invoice);
});
```

### Sampling Options

| Sampler | Description |
| --- | --- |
| `{ type: "always" }` | Record every trace (default in development) |
| `{ type: "never" }` | Record no traces |
| `{ type: "ratio", ratio: number }` | Record a fraction of traces (`0`–`1`) |
| `{ type: "parent" }` | Follow the sampling decision of the incoming trace |

### Visualizing Traces

Because spans are exported in W3C Trace Context / OTLP-compatible form, you can
point any OTel-compatible backend at your exporter to visualize traces:

- **Jaeger** — run `jaeger-all-in-one` and send spans to its OTLP endpoint (`:4318`).
- **Grafana Tempo** — scrape the OTLP endpoint and view traces in Grafana.
- **Honeycomb / Datadog** — configure their OTLP intake as the exporter target.

Each SDK call appears as a span nested under the incoming request span, giving a
full end-to-end view of the request across services.

## Prometheus Metrics Export

> **Issue #903**: Add SDK metrics export in Prometheus format

The SDK can export the metrics it collects through the telemetry hooks in the
[Prometheus text exposition format](https://prometheus.io/docs/instrumenting/exposition_formats/),
so they can be scraped by a Prometheus server or any compatible agent.

### Enabling Metrics Collection

Metrics are collected from the same `onCallStart` / `onCallEnd` / `onError`
events used by the telemetry hooks. Register the built-in metrics collector to
start recording them:

```typescript
import { createPrometheusMetrics } from "@stellar-split/sdk";

const metrics = createPrometheusMetrics();

client.setTelemetryHooks({
  onError: metrics.onError,
  onCallStart: metrics.onCallStart,
  onCallEnd: metrics.onCallEnd,
});
```

### Exposing the Metrics Endpoint

Call `metrics.export()` to obtain the current snapshot rendered in Prometheus
text format. Serve it from any HTTP handler (Express, Fastify, a serverless
function, etc.):

```typescript
import express from "express";

const app = express();

app.get("/metrics", (_req, res) => {
  res.set("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
  res.send(metrics.export());
});

app.listen(9464);
```

### Exported Metrics

| Metric | Type | Labels | Description |
| --- | --- | --- | --- |
| `stellar_split_sdk_calls_total` | counter | `method`, `success` | Total number of SDK calls, split by outcome |
| `stellar_split_sdk_call_duration_seconds` | histogram | `method` | Duration of SDK calls in seconds |
| `stellar_split_sdk_errors_total` | counter | `method` | Total number of SDK errors |
| `stellar_split_sdk_in_flight_calls` | gauge | `method` | SDK calls currently in progress |

Example output:

```
# HELP stellar_split_sdk_calls_total Total number of SDK calls.
# TYPE stellar_split_sdk_calls_total counter
stellar_split_sdk_calls_total{method="createInvoice",success="true"} 12
stellar_split_sdk_calls_total{method="createInvoice",success="false"} 1
# HELP stellar_split_sdk_call_duration_seconds Duration of SDK calls in seconds.
# TYPE stellar_split_sdk_call_duration_seconds histogram
stellar_split_sdk_call_duration_seconds_bucket{method="createInvoice",le="0.1"} 8
stellar_split_sdk_call_duration_seconds_bucket{method="createInvoice",le="0.5"} 12
stellar_split_sdk_call_duration_seconds_bucket{method="createInvoice",le="+Inf"} 13
stellar_split_sdk_call_duration_seconds_sum{method="createInvoice"} 1.842
stellar_split_sdk_call_duration_seconds_count{method="createInvoice"} 13
# HELP stellar_split_sdk_errors_total Total number of SDK errors.
# TYPE stellar_split_sdk_errors_total counter
stellar_split_sdk_errors_total{method="createInvoice"} 1
# HELP stellar_split_sdk_in_flight_calls SDK calls currently in progress.
# TYPE stellar_split_sdk_in_flight_calls gauge
stellar_split_sdk_in_flight_calls{method="createInvoice"} 0
```

### Resetting Metrics

```typescript
metrics.reset();
```

## Hook Signatures

### `onError`

Called whenever an SDK error is thrown, before it propagates to the caller.

```typescript
onError?: (error: StellarSplitError, context: TelemetryErrorContext) => void;
```

**Parameters:**
- `error`: The `StellarSplitError` instance that was thrown
- `context`: Object containing:
  - `method`: The SDK method name (e.g., "createInvoice", "pay")
  - `args`: Sanitized method arguments (no sensitive data)
  - `timestamp`: When the error occurred (milliseconds since epoch)

### `onCallStart`

Called before each SDK method invocation that makes an RPC call.

```typescript
onCallStart?: (params: TelemetryCallStartParams) => void;
```

**Parameters:**
- `params`: Object containing:
  - `method`: The SDK method name being invoked
  - `args`: Sanitized method arguments (optional)
  - `timestamp`: When the call started (milliseconds since epoch)

### `onCallEnd`

Called after each SDK method invocation completes (success or failure).

```typescript
onCallEnd?: (params: TelemetryCallEndParams) => void;
```

**Parameters:**
- `params`: Object containing:
  - `method`: The SDK method name that was invoked
  - `durationMs`: Duration of the call in milliseconds
  - `success`: `true` if the call succeeded, `false` if it threw an error
  - `error`: The error instance (only present when `success` is `false`)
  - `timestamp`: When the call ended (milliseconds since epoch)

## Integration Examples

### Sentry

```typescript
import * as Sentry from "@sentry/browser";

client.setTelemetryHooks({
  onError: (error, context) => {
    Sentry.captureException(error, {
      tags: {
        method: context.method,
        sdk: "@stellar-split/sdk",
      },
      extra: context,
    });
  },
  onCallEnd: ({ method, durationMs, success }) => {
    Sentry.addBreadcrumb({
      category: "sdk.rpc",
      message: `${method} ${success ? "succeeded" : "failed"}`,
      level: success ? "info" : "error",
      data: { durationMs },
    });
  },
});
```

### Datadog

```typescript
import { datadogRum } from "@datadog/browser-rum";

client.setTelemetryHooks({
  onError: (error, context) => {
    datadogRum.addError(error, {
      method: context.method,
      source: "stellar-split-sdk",
    });
  },
  onCallStart: ({ method, timestamp }) => {
    datadogRum.addTiming(`sdk.${method}.start`, timestamp);
  },
  onCallEnd: ({ method, durationMs, success }) => {
    datadogRum.addTiming(`sdk.${method}.duration`, durationMs);
    datadogRum.addAction(`sdk.${method}`, {
      success,
      durationMs,
    });
  },
});
```

### Custom Analytics

```typescript
class SDKAnalytics {
  private errors: Array<{ method: string; error: string; timestamp: number }> = [];
  private metrics: Map<string, { totalCalls: number; totalDuration: number; failures: number }> = new Map();

  trackError(method: string, error: Error, timestamp: number) {
    this.errors.push({ method, error: error.message, timestamp });
  }

  trackCall(method: string, durationMs: number, success: boolean) {
    const entry = this.metrics.get(method) ?? { totalCalls: 0, totalDuration: 0, failures: 0 };
    entry.totalCalls += 1;
    entry.totalDuration += durationMs;
    if (!success) entry.failures += 1;
    this.metrics.set(method, entry);
  }
}

const analytics = new SDKAnalytics();

client.setTelemetryHooks({
  onError: (error, context) => analytics.trackError(context.method, error, context.timestamp),
  onCallEnd: ({ method, durationMs, success }) => analytics.trackCall(method, durationMs, success),
});
```
