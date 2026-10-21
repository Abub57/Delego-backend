import { describe, expect, it, beforeEach } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  GatewayMetrics,
  normalizeRoute,
  metricsMiddleware,
  metricsHandler,
  registerMetricsRoutes,
  gatewayMetrics,
} from "./metrics.js";

function createMockResponse(): ServerResponse & {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
} {
  const res = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: "",
    writeHead(status: number, headers?: Record<string, string>) {
      this.statusCode = status;
      if (headers) Object.assign(this.headers, headers);
      return this;
    },
    setHeader(name: string, value: string) {
      this.headers[name.toLowerCase()] = value;
      return this;
    },
    end(data?: string | Buffer) {
      if (data) {
        this.body = typeof data === "string" ? data : data.toString("utf8");
      }
      return this;
    },
  } as unknown as ServerResponse & {
    statusCode: number;
    headers: Record<string, string>;
    body: string;
  };
  return res;
}

describe("Gateway Metrics (Issue #7)", () => {
  let metrics: GatewayMetrics;

  beforeEach(() => {
    metrics = new GatewayMetrics();
    gatewayMetrics.reset();
  });

  describe("normalizeRoute", () => {
    it("preserves static routes", () => {
      expect(normalizeRoute("/api/v1/delegations")).toBe("/api/v1/delegations");
      expect(normalizeRoute("/api/v1/orders")).toBe("/api/v1/orders");
      expect(normalizeRoute("/")).toBe("/");
    });

    it("normalizes UUID parameters", () => {
      expect(normalizeRoute("/api/v1/delegations/123e4567-e89b-12d3-a456-426614174000")).toBe(
        "/api/v1/delegations/:id",
      );
    });

    it("normalizes numeric parameters", () => {
      expect(normalizeRoute("/api/v1/orders/12345")).toBe("/api/v1/orders/:id");
    });

    it("normalizes Stellar public keys and hashes", () => {
      expect(
        normalizeRoute(
          "/api/v1/wallets/GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
        ),
      ).toBe("/api/v1/wallets/:publicKey");
    });
  });

  describe("GatewayMetrics Core", () => {
    it("starts empty and produces default Prometheus metrics", () => {
      const text = metrics.toPrometheusText();
      expect(text).toContain("# TYPE http_requests_total counter");
      expect(text).toContain("# TYPE http_errors_total counter");
      expect(text).toContain("# TYPE http_request_duration_seconds histogram");
      expect(text).toContain("http_requests_total 0");
    });

    it("records requests and updates Prometheus counters and histograms", () => {
      metrics.recordRequest("GET", "/api/v1/delegations", 200, 0.045);
      metrics.recordRequest("GET", "/api/v1/delegations", 200, 0.055);
      metrics.recordRequest("POST", "/api/v1/delegations", 201, 0.12);

      expect(metrics.getRequestCount()).toBe(3);
      expect(metrics.getErrorCount()).toBe(0);

      const text = metrics.toPrometheusText();
      expect(text).toContain(
        'http_requests_total{method="GET",route="/api/v1/delegations",status="200"} 2',
      );
      expect(text).toContain(
        'http_requests_total{method="POST",route="/api/v1/delegations",status="201"} 1',
      );
      expect(text).toContain(
        'http_request_duration_seconds_count{method="GET",route="/api/v1/delegations",status="200"} 2',
      );
      expect(text).toContain(
        'http_request_duration_seconds_sum{method="GET",route="/api/v1/delegations",status="200"} 0.1',
      );
    });

    it("records client (4xx) and server (5xx) errors separately in http_errors_total", () => {
      metrics.recordRequest("POST", "/api/v1/auth/login", 401, 0.01);
      metrics.recordRequest("GET", "/api/v1/delegations", 500, 0.25);

      expect(metrics.getRequestCount()).toBe(2);
      expect(metrics.getErrorCount()).toBe(2);

      const text = metrics.toPrometheusText();
      expect(text).toContain(
        'http_errors_total{error_type="client_error",method="POST",route="/api/v1/auth/login",status="401"} 1',
      );
      expect(text).toContain(
        'http_errors_total{error_type="server_error",method="GET",route="/api/v1/delegations",status="500"} 1',
      );
    });
  });

  describe("metricsMiddleware", () => {
    it("increments request counters and measures latency after request finishes", () => {
      const mw = metricsMiddleware(metrics);
      const req = {
        url: "/api/v1/delegations",
        method: "GET",
        headers: { host: "localhost:3000" },
      } as IncomingMessage;
      const res = createMockResponse();

      let nextCalled = false;
      mw(req, res, () => {
        nextCalled = true;
      });

      expect(nextCalled).toBe(true);
      expect(metrics.getRequestCount()).toBe(0);

      res.statusCode = 200;
      res.end("OK");

      expect(metrics.getRequestCount()).toBe(1);
      expect(metrics.getErrorCount()).toBe(0);
    });

    it("tracks errors when statusCode >= 400", () => {
      const mw = metricsMiddleware(metrics);
      const req = {
        url: "/api/v1/orders",
        method: "POST",
        headers: { host: "localhost:3000" },
      } as IncomingMessage;
      const res = createMockResponse();

      mw(req, res, () => {});
      res.statusCode = 400;
      res.end("Bad Request");

      expect(metrics.getRequestCount()).toBe(1);
      expect(metrics.getErrorCount()).toBe(1);
    });

    it("ignores /metrics and /health endpoints from request counting", () => {
      const mw = metricsMiddleware(metrics);
      const reqMetrics = {
        url: "/metrics",
        method: "GET",
        headers: { host: "localhost:3000" },
      } as IncomingMessage;
      const resMetrics = createMockResponse();

      mw(reqMetrics, resMetrics, () => {});
      resMetrics.end("Prometheus data");

      const reqHealth = {
        url: "/health/live",
        method: "GET",
        headers: { host: "localhost:3000" },
      } as IncomingMessage;
      const resHealth = createMockResponse();

      mw(reqHealth, resHealth, () => {});
      resHealth.end("ok");

      expect(metrics.getRequestCount()).toBe(0);
    });
  });

  describe("metricsHandler & routes", () => {
    it("serves Prometheus text exposition format on /metrics", async () => {
      gatewayMetrics.recordRequest("GET", "/api/v1/delegations", 200, 0.05);

      const req = { url: "/metrics" } as IncomingMessage;
      const res = createMockResponse();

      await metricsHandler(req, res, {});

      expect(res.statusCode).toBe(200);
      expect(res.headers["Content-Type"]).toContain("text/plain");
      expect(res.body).toContain("# TYPE http_requests_total counter");
      expect(res.body).toContain('http_requests_total{method="GET",route="/api/v1/delegations",status="200"} 1');
    });

    it("registers /metrics and /api/v1/metrics routes", () => {
      const routes = registerMetricsRoutes();
      expect(routes.some((r) => r.pattern.test("/metrics"))).toBe(true);
      expect(routes.some((r) => r.pattern.test("/api/v1/metrics"))).toBe(true);
    });
  });
});
