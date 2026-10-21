/**
 * Gateway Metrics & Prometheus Exposition (Issue #7)
 *
 * Tracks request count, error count, and response time (latency) per route
 * using in-memory counters with zero external dependencies.
 *
 * Exposes metrics at GET /metrics and GET /api/v1/metrics in Prometheus text format.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Route, RouteHandler } from "@delegolabs/utils";
import { route } from "@delegolabs/utils";
import { sseClientPool } from "./sse/clientPool.js";

export interface MetricSeries {
  labels: Record<string, string>;
  value: number;
}

export interface HistogramSeries {
  labels: Record<string, string>;
  count: number;
  sum: number;
}

function labelKey(labels?: Record<string, string>): string {
  if (!labels) return "";
  return Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join(",");
}

function parseLabelKey(key: string): Record<string, string> {
  if (!key) return {};
  const labels: Record<string, string> = {};
  for (const part of key.split(",")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    labels[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return labels;
}

function escapePromLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function formatPromLabels(labels: Record<string, string>): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return "";
  return `{${entries.map(([k, v]) => `${k}="${escapePromLabel(v)}"`).join(",")}}`;
}

export class InMemoryCounter {
  private values = new Map<string, number>();

  inc(value = 1, labels?: Record<string, string>): void {
    const key = labelKey(labels);
    this.values.set(key, (this.values.get(key) ?? 0) + value);
  }

  value(labels?: Record<string, string>): number {
    return this.values.get(labelKey(labels)) ?? 0;
  }

  entries(): MetricSeries[] {
    return [...this.values.entries()].map(([key, value]) => ({
      labels: parseLabelKey(key),
      value,
    }));
  }

  reset(): void {
    this.values.clear();
  }
}

export class InMemoryHistogram {
  private counts = new Map<string, number>();
  private sums = new Map<string, number>();

  observe(value: number, labels?: Record<string, string>): void {
    const key = labelKey(labels);
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
    this.sums.set(key, (this.sums.get(key) ?? 0) + value);
  }

  count(labels?: Record<string, string>): number {
    return this.counts.get(labelKey(labels)) ?? 0;
  }

  sum(labels?: Record<string, string>): number {
    return this.sums.get(labelKey(labels)) ?? 0;
  }

  entries(): HistogramSeries[] {
    const keys = new Set([...this.counts.keys(), ...this.sums.keys()]);
    return [...keys].map((key) => ({
      labels: parseLabelKey(key),
      count: this.counts.get(key) ?? 0,
      sum: this.sums.get(key) ?? 0,
    }));
  }

  reset(): void {
    this.counts.clear();
    this.sums.clear();
  }
}

/**
 * Normalizes dynamic path parameters (UUIDs, IDs, hashes) into route templates
 * so metric dimensions remain bounded.
 */
export function normalizeRoute(pathname: string): string {
  if (!pathname || pathname === "/") return "/";
  const clean = pathname.split("?")[0].replace(/\/+$/, "") || "/";
  return clean
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ":id")
    .replace(/\b(G[A-Z0-9]{55})\b/g, ":publicKey")
    .replace(/\b[0-9a-fA-F]{64}\b/g, ":hash")
    .replace(/\/[0-9]+(?=\/|$)/g, "/:id");
}

export class GatewayMetrics {
  readonly requestsTotal = new InMemoryCounter();
  readonly errorsTotal = new InMemoryCounter();
  readonly requestDurationSeconds = new InMemoryHistogram();

  recordRequest(
    method: string,
    routePath: string,
    statusCode: number,
    durationSeconds: number,
  ): void {
    const normalizedRoute = normalizeRoute(routePath);
    const upperMethod = method.toUpperCase();
    const statusStr = String(statusCode);

    const labels = {
      method: upperMethod,
      route: normalizedRoute,
      status: statusStr,
    };

    this.requestsTotal.inc(1, labels);
    this.requestDurationSeconds.observe(durationSeconds, labels);

    if (statusCode >= 400) {
      this.errorsTotal.inc(1, {
        method: upperMethod,
        route: normalizedRoute,
        status: statusStr,
        error_type: statusCode >= 500 ? "server_error" : "client_error",
      });
    }
  }

  getRequestCount(labels?: Record<string, string>): number {
    if (!labels) {
      return this.requestsTotal.entries().reduce((acc, curr) => acc + curr.value, 0);
    }
    return this.requestsTotal.value(labels);
  }

  getErrorCount(labels?: Record<string, string>): number {
    if (!labels) {
      return this.errorsTotal.entries().reduce((acc, curr) => acc + curr.value, 0);
    }
    return this.errorsTotal.value(labels);
  }

  reset(): void {
    this.requestsTotal.reset();
    this.errorsTotal.reset();
    this.requestDurationSeconds.reset();
  }

  toPrometheusText(): string {
    const lines: string[] = [];

    // http_requests_total
    lines.push("# HELP http_requests_total Total number of HTTP requests processed by the gateway.");
    lines.push("# TYPE http_requests_total counter");
    const reqEntries = this.requestsTotal.entries();
    if (reqEntries.length === 0) {
      lines.push("http_requests_total 0");
    } else {
      for (const entry of reqEntries) {
        lines.push(`http_requests_total${formatPromLabels(entry.labels)} ${entry.value}`);
      }
    }

    // http_errors_total
    lines.push("# HELP http_errors_total Total number of HTTP error responses (4xx/5xx).");
    lines.push("# TYPE http_errors_total counter");
    const errEntries = this.errorsTotal.entries();
    if (errEntries.length === 0) {
      lines.push("http_errors_total 0");
    } else {
      for (const entry of errEntries) {
        lines.push(`http_errors_total${formatPromLabels(entry.labels)} ${entry.value}`);
      }
    }

    // http_request_duration_seconds
    lines.push("# HELP http_request_duration_seconds Latency of HTTP requests in seconds.");
    lines.push("# TYPE http_request_duration_seconds histogram");
    const durEntries = this.requestDurationSeconds.entries();
    if (durEntries.length === 0) {
      lines.push("http_request_duration_seconds_count 0");
      lines.push("http_request_duration_seconds_sum 0");
    } else {
      for (const entry of durEntries) {
        const labels = formatPromLabels(entry.labels);
        lines.push(`http_request_duration_seconds_count${labels} ${entry.count}`);
        lines.push(`http_request_duration_seconds_sum${labels} ${entry.sum}`);
      }
    }

    // sse_active_connections / process heap (#337) — tracked so a leaking
    // SSE client pool shows up in dashboards before it OOMs the process.
    const sseStats = sseClientPool.stats();
    lines.push("# HELP gateway_sse_active_connections Open SSE connections tracked by the client pool.");
    lines.push("# TYPE gateway_sse_active_connections gauge");
    lines.push(`gateway_sse_active_connections ${sseStats.activeConnections}`);

    lines.push("# HELP gateway_process_heap_used_bytes Node.js process heap used, in bytes.");
    lines.push("# TYPE gateway_process_heap_used_bytes gauge");
    lines.push(`gateway_process_heap_used_bytes ${sseStats.heapUsedBytes}`);

    lines.push("# HELP gateway_process_rss_bytes Node.js process resident set size, in bytes.");
    lines.push("# TYPE gateway_process_rss_bytes gauge");
    lines.push(`gateway_process_rss_bytes ${sseStats.rssBytes}`);

    return lines.join("\n") + "\n";
  }
}

export const gatewayMetrics = new GatewayMetrics();

/**
 * Middleware that measures response time and tracks request/error counts per route.
 */
export function metricsMiddleware(metrics: GatewayMetrics = gatewayMetrics) {
  return (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void): void => {
    const startedAt = process.hrtime.bigint();
    const originalEnd = res.end.bind(res);

    (res as any).end = function (this: ServerResponse, ...args: unknown[]) {
      const durationNs = Number(process.hrtime.bigint() - startedAt);
      const durationSeconds = durationNs / 1_000_000_000;
      const path = req.url ? new URL(req.url, `http://${req.headers.host ?? "localhost"}`).pathname : "/";
      const method = req.method ?? "GET";
      const statusCode = res.statusCode || 200;

      // Don't track /metrics or /health calls in request counters to avoid metric pollution
      if (path !== "/metrics" && path !== "/api/v1/metrics" && !path.startsWith("/health")) {
        metrics.recordRequest(method, path, statusCode, durationSeconds);
      }

      return originalEnd.apply(this, args as any);
    };

    next();
  };
}

/**
 * Route handler that serves Prometheus text metrics.
 */
export const metricsHandler: RouteHandler = (_req, res) => {
  const body = gatewayMetrics.toPrometheusText();
  res.writeHead(200, {
    "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
};

export function registerMetricsRoutes(): Route[] {
  return [
    route("GET", "/metrics", metricsHandler),
    route("GET", "/api/v1/metrics", metricsHandler),
  ];
}
