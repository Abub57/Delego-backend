import { describe, it, expect, beforeEach, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { 
  circuitBreakerMiddleware, 
  circuitBreakerHealthMiddleware,
  createCircuitBreakerTestMiddleware 
} from "./circuitBreaker.js";
import { 
  getCircuitBreaker, 
  resetAllCircuitBreakers, 
  setCircuitBreaker,
  CircuitBreaker,
  type DownstreamService 
} from "../circuitBreaker.js";

// Mock utilities
function createMockRequest(url: string, method: string = "GET"): IncomingMessage {
  return {
    url,
    method,
    headers: { host: "localhost:3000" },
    on: vi.fn(),
  } as unknown as IncomingMessage;
}

function createMockResponse(): ServerResponse {
  const headers: Record<string, string> = {};
  let statusCode = 200;
  let body = "";
  
  const res = {
    statusCode,
    setHeader: vi.fn((name: string, value: string) => {
      headers[name] = value;
    }),
    getHeader: vi.fn((name: string) => headers[name]),
    end: vi.fn((data?: string) => {
      if (data) body = data;
    }),
    write: vi.fn(),
    writeHead: vi.fn(),
  } as unknown as ServerResponse;
  
  Object.defineProperty(res, 'statusCode', {
    get: () => statusCode,
    set: (value: number) => { statusCode = value; }
  });
  
  // Add helper methods for testing
  (res as any).getTestHeaders = () => headers;
  (res as any).getTestBody = () => body;
  (res as any).getTestStatusCode = () => statusCode;
  
  return res;
}

describe("circuitBreakerMiddleware", () => {
  beforeEach(() => {
    resetAllCircuitBreakers();
    vi.clearAllMocks();
  });

  it("allows requests through when circuit is closed", async () => {
    const middleware = circuitBreakerMiddleware();
    const req = createMockRequest("/api/v1/orchestrator/orders");
    const res = createMockResponse();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledWith();
    expect((res as any).getTestStatusCode()).toBe(200);
  });

  it("blocks requests when circuit is open and returns 503", async () => {
    // Force circuit to open state
    const breaker = new CircuitBreaker("orchestrator", { failureThreshold: 1, cooldownMs: 30000 });
    await expect(breaker.execute(() => Promise.reject(new Error("service down")))).rejects.toThrow();
    setCircuitBreaker("orchestrator", breaker);

    const middleware = circuitBreakerMiddleware();
    const req = createMockRequest("/api/v1/orchestrator/orders", "POST");
    const res = createMockResponse();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect((res as any).getTestStatusCode()).toBe(503);
    
    const headers = (res as any).getTestHeaders();
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["Retry-After"]).toBe("30");
    expect(headers["X-Circuit-Breaker-Service"]).toBe("orchestrator");
    expect(headers["X-Circuit-Breaker-State"]).toBe("open");
    
    const responseBody = JSON.parse((res as any).getTestBody());
    expect(responseBody.error).toBe("Service Unavailable");
    expect(responseBody.service).toBe("orchestrator");
    expect(responseBody.retryAfter).toBe(30);
  });

  it("allows test requests through when circuit is half-open", async () => {
    vi.useFakeTimers();
    try {
      // Create circuit breaker and force it to open
      const breaker = new CircuitBreaker("wallet", { failureThreshold: 1, cooldownMs: 1000 });
      await expect(breaker.execute(() => Promise.reject(new Error("fail")))).rejects.toThrow();
      
      // Advance time to trigger half-open state
      vi.advanceTimersByTime(1001);
      setCircuitBreaker("wallet", breaker);

      const middleware = circuitBreakerMiddleware();
      const req = createMockRequest("/api/v1/wallet/balance");
      const res = createMockResponse();
      const next = vi.fn();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalledOnce();
      expect((res as any).getTestStatusCode()).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it("maps different paths to correct downstream services", async () => {
    const testCases = [
      { path: "/api/v1/orchestrator/orders", expectedService: "orchestrator" },
      { path: "/api/v1/orders/123", expectedService: "orchestrator" },
      { path: "/api/v1/delegations", expectedService: "orchestrator" },
      { path: "/api/v1/wallet/balance", expectedService: "wallet" },
      { path: "/api/v1/transactions/history", expectedService: "wallet" },
      { path: "/api/v1/payment/process", expectedService: "payments" },
      { path: "/api/v1/billing/invoice", expectedService: "payments" },
    ];

    for (const testCase of testCases) {
      // Force the expected service circuit to open
      const breaker = new CircuitBreaker(testCase.expectedService as DownstreamService, { 
        failureThreshold: 1, 
        cooldownMs: 30000 
      });
      await expect(breaker.execute(() => Promise.reject(new Error("down")))).rejects.toThrow();
      setCircuitBreaker(testCase.expectedService as DownstreamService, breaker);

      const middleware = circuitBreakerMiddleware();
      const req = createMockRequest(testCase.path);
      const res = createMockResponse();
      const next = vi.fn();

      await middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect((res as any).getTestStatusCode()).toBe(503);
      
      const headers = (res as any).getTestHeaders();
      expect(headers["X-Circuit-Breaker-Service"]).toBe(testCase.expectedService);

      resetAllCircuitBreakers();
    }
  });

  it("allows requests to unknown paths through without circuit breaking", async () => {
    const middleware = circuitBreakerMiddleware();
    const req = createMockRequest("/api/v1/unknown/endpoint");
    const res = createMockResponse();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect((res as any).getTestStatusCode()).toBe(200);
  });

  it("skips circuit breaking for health and internal routes", async () => {
    const testPaths = ["/health", "/metrics", "/internal/status"];
    
    for (const path of testPaths) {
      const middleware = circuitBreakerMiddleware();
      const req = createMockRequest(path);
      const res = createMockResponse();
      const next = vi.fn();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalledOnce();
      expect((res as any).getTestStatusCode()).toBe(200);
      
      vi.clearAllMocks();
    }
  });

  it("continues on middleware errors without blocking requests", async () => {
    // Create a request that will cause URL parsing to fail
    const invalidReq = {
      url: undefined,
      method: "GET",
      headers: {}
    } as unknown as IncomingMessage;

    const middleware = circuitBreakerMiddleware();
    const res = createMockResponse();
    const next = vi.fn();

    await middleware(invalidReq, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect((res as any).getTestStatusCode()).toBe(200);
  });
});

describe("circuitBreakerHealthMiddleware", () => {
  beforeEach(() => {
    resetAllCircuitBreakers();
  });

  it("exposes circuit breaker stats at /circuit-breakers endpoint", () => {
    const middleware = circuitBreakerHealthMiddleware();
    const req = createMockRequest("/circuit-breakers");
    const res = createMockResponse();
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect((res as any).getTestStatusCode()).toBe(200);
    
    const headers = (res as any).getTestHeaders();
    expect(headers["Content-Type"]).toBe("application/json");
    
    const responseBody = JSON.parse((res as any).getTestBody());
    expect(responseBody.timestamp).toBeDefined();
    expect(responseBody.circuitBreakers).toBeDefined();
    expect(responseBody.circuitBreakers.orchestrator).toBeDefined();
    expect(responseBody.circuitBreakers.wallet).toBeDefined();
    expect(responseBody.circuitBreakers.payments).toBeDefined();
  });

  it("passes through non-matching requests", () => {
    const middleware = circuitBreakerHealthMiddleware();
    const req = createMockRequest("/other-endpoint");
    const res = createMockResponse();
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect((res as any).getTestStatusCode()).toBe(200);
  });
});

describe("createCircuitBreakerTestMiddleware", () => {
  beforeEach(() => {
    resetAllCircuitBreakers();
    vi.clearAllMocks();
  });

  it("returns 404 in production environment", () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    
    try {
      const middleware = createCircuitBreakerTestMiddleware();
      const req = createMockRequest("/internal/circuit-breakers", "POST");
      const res = createMockResponse();
      const next = vi.fn();

      middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect((res as any).getTestStatusCode()).toBe(404);
    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });

  it("allows circuit breaker reset in non-production", async () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "test";
    
    try {
      const middleware = createCircuitBreakerTestMiddleware();
      
      // Mock request with body
      const req = {
        url: "/internal/circuit-breakers",
        method: "POST",
        headers: { host: "localhost" },
        on: vi.fn((event: string, callback: Function) => {
          if (event === "data") {
            callback(JSON.stringify({ service: "orchestrator", action: "reset" }));
          } else if (event === "end") {
            callback();
          }
        })
      } as unknown as IncomingMessage;
      
      const res = createMockResponse();
      const next = vi.fn();

      middleware(req, res, next);

      // Give async operations time to complete
      await new Promise(resolve => setTimeout(resolve, 50));
      
      expect(next).not.toHaveBeenCalled();
      expect((res as any).getTestStatusCode()).toBe(200);
      
      const responseBody = JSON.parse((res as any).getTestBody());
      expect(responseBody.service).toBe("orchestrator");
      expect(responseBody.action).toBe("reset");
      expect(responseBody.state).toBe("closed");
      
    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });

  it("passes through non-matching requests", () => {
    const middleware = createCircuitBreakerTestMiddleware();
    const req = createMockRequest("/other-endpoint");
    const res = createMockResponse();
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
  });
});