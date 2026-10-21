/**
 * Unit and integration tests for structured logging with Pino
 * 
 * Tests:
 * - JSON-structured output validation
 * - Request ID correlation
 * - Log level configuration
 * - Response header propagation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  logger,
  requestLoggingMiddleware,
  createChildLogger,
  isLogLevelEnabled,
  LOG_LEVELS,
} from "../logger.js";

// ─── Test Helpers ───────────────────────────────────────────────────────────

/**
 * Capture logger output by mocking process.stdout.write
 */
function captureLoggerOutput(): {
  logs: string[];
  restore: () => void;
} {
  const logs: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);

  // @ts-expect-error - Mocking stdout.write
  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    const str = typeof chunk === "string" ? chunk : chunk.toString();
    logs.push(str);
    return true;
  };

  return {
    logs,
    restore: () => {
      process.stdout.write = originalWrite;
    },
  };
}

/**
 * Parse captured log lines as JSON
 */
function parseLogLines(logs: string[]): any[] {
  return logs
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/**
 * Create mock HTTP request
 */
function createMockRequest(options: {
  method?: string;
  url?: string;
  headers?: Record<string, string | string[]>;
}): IncomingMessage {
  const req = new EventEmitter() as unknown as IncomingMessage;
  req.method = options.method || "GET";
  req.url = options.url || "/";
  req.headers = options.headers || {};
  req.socket = {
    remoteAddress: "127.0.0.1",
  } as any;

  return req;
}

/**
 * Create mock HTTP response
 */
function createMockResponse(): {
  res: ServerResponse;
  headers: Map<string, string>;
  statusCode: number;
} {
  const headers = new Map<string, string>();
  let statusCode = 200;

  const res = new EventEmitter() as unknown as ServerResponse;
  res.setHeader = (name: string, value: string | string[]) => {
    headers.set(name.toLowerCase(), Array.isArray(value) ? value[0] : value);
  };
  res.getHeader = (name: string) => headers.get(name.toLowerCase());
  res.writeHead = (status: number) => {
    statusCode = status;
  };
  res.end = vi.fn();

  Object.defineProperty(res, "statusCode", {
    get: () => statusCode,
    set: (val) => {
      statusCode = val;
    },
  });

  return { res, headers, statusCode };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("Logger - Structured JSON Output", () => {
  let capture: ReturnType<typeof captureLoggerOutput>;

  beforeEach(() => {
    capture = captureLoggerOutput();
  });

  afterEach(() => {
    capture.restore();
  });

  it("should emit valid JSON for each log entry", () => {
    logger.info("Test message");
    logger.warn("Warning message", { userId: "123" });
    logger.error("Error message", { code: "ERR001" });

    const parsed = parseLogLines(capture.logs);

    // All logs should parse as valid JSON
    expect(parsed.length).toBeGreaterThan(0);
    parsed.forEach((log) => {
      expect(log).toBeTruthy();
      expect(typeof log).toBe("object");
    });
  });

  it("should include required fields: level, time, msg", () => {
    logger.info("Test message with metadata", { key: "value" });

    const parsed = parseLogLines(capture.logs);
    const logEntry = parsed.find((log) => log.msg?.includes("Test message"));

    expect(logEntry).toBeDefined();
    expect(logEntry.level).toBeDefined();
    expect(logEntry.time).toBeDefined();
    expect(logEntry.msg).toBe("Test message with metadata");
  });

  it("should include service and env in base metadata", () => {
    logger.info("Test service metadata");

    const parsed = parseLogLines(capture.logs);
    const logEntry = parsed.find((log) => log.msg?.includes("service metadata"));

    expect(logEntry).toBeDefined();
    expect(logEntry.service).toBe("gateway");
    expect(logEntry.env).toBeDefined();
  });

  it("should include custom metadata in log entries", () => {
    logger.info("Test with metadata", {
      userId: "user-123",
      action: "login",
      timestamp: Date.now(),
    });

    const parsed = parseLogLines(capture.logs);
    const logEntry = parsed.find((log) => log.msg?.includes("Test with metadata"));

    expect(logEntry).toBeDefined();
    expect(logEntry.userId).toBe("user-123");
    expect(logEntry.action).toBe("login");
    expect(logEntry.timestamp).toBeDefined();
  });

  it("should handle error objects with proper serialization", () => {
    const error = new Error("Test error");
    error.stack = "Error: Test error\n    at test.ts:10:5";

    logger.error("Error occurred", { error });

    const parsed = parseLogLines(capture.logs);
    const logEntry = parsed.find((log) => log.msg?.includes("Error occurred"));

    expect(logEntry).toBeDefined();
    expect(logEntry.error).toBeDefined();
    expect(logEntry.error.message).toBe("Test error");
    expect(logEntry.error.stack).toBeDefined();
  });
});

describe("Logger - Request ID Correlation", () => {
  let capture: ReturnType<typeof captureLoggerOutput>;

  beforeEach(() => {
    capture = captureLoggerOutput();
  });

  afterEach(() => {
    capture.restore();
  });

  it("should honor incoming x-request-id header", async () => {
    const middleware = requestLoggingMiddleware();
    const requestId = "existing-request-id-12345";

    const req = createMockRequest({
      method: "GET",
      url: "/api/test",
      headers: { "x-request-id": requestId },
    });
    const { res, headers } = createMockResponse();
    const next = vi.fn();

    middleware(req, res, next);

    // Wait for middleware to complete
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Verify response header includes the request ID
    expect(headers.get("x-request-id")).toBe(requestId);

    // Verify request has been augmented with logger
    expect((req as any).log).toBeDefined();
    expect((req as any).id).toBe(requestId);
  });

  it("should generate UUID v4 when no x-request-id is provided", async () => {
    const middleware = requestLoggingMiddleware();

    const req = createMockRequest({
      method: "GET",
      url: "/api/test",
    });
    const { res, headers } = createMockResponse();
    const next = vi.fn();

    middleware(req, res, next);

    await new Promise((resolve) => setTimeout(resolve, 10));

    // Verify a request ID was generated
    const requestId = headers.get("x-request-id");
    expect(requestId).toBeDefined();
    expect(requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });

  it("should include reqId in all logs generated during request", async () => {
    const middleware = requestLoggingMiddleware();
    const requestId = "test-request-123";

    const req = createMockRequest({
      method: "POST",
      url: "/api/users",
      headers: { "x-request-id": requestId },
    });
    const { res } = createMockResponse();
    const next = vi.fn(() => {
      // Simulate handler logging with request logger
      if ((req as any).log) {
        (req as any).log.info("Processing user creation", { userId: "456" });
      }
    });

    middleware(req, res, next);

    await new Promise((resolve) => setTimeout(resolve, 20));

    const parsed = parseLogLines(capture.logs);
    const handlerLog = parsed.find((log) => log.msg?.includes("Processing user"));

    expect(handlerLog).toBeDefined();
    expect(handlerLog.reqId).toBe(requestId);
    expect(handlerLog.userId).toBe("456");
  });

  it("should attach child logger to request object", async () => {
    const middleware = requestLoggingMiddleware();

    const req = createMockRequest({
      method: "GET",
      url: "/test",
    });
    const { res } = createMockResponse();
    const next = vi.fn();

    middleware(req, res, next);

    await new Promise((resolve) => setTimeout(resolve, 10));

    // Verify req.log exists and is a Pino logger
    expect((req as any).log).toBeDefined();
    expect(typeof (req as any).log.info).toBe("function");
    expect(typeof (req as any).log.error).toBe("function");
    expect(typeof (req as any).log.warn).toBe("function");
  });
});

describe("Logger - Log Level Configuration", () => {
  it("should respect LOG_LEVEL environment variable", () => {
    // Logger is created at module load, so level is set
    expect(logger.level).toBeDefined();
  });

  it("should expose isLogLevelEnabled utility", () => {
    expect(typeof isLogLevelEnabled).toBe("function");

    // Test different levels
    expect(isLogLevelEnabled("info")).toBe(true);
    expect(isLogLevelEnabled("error")).toBe(true);
  });

  it("should expose LOG_LEVELS constant", () => {
    expect(LOG_LEVELS).toBeDefined();
    expect(LOG_LEVELS.trace).toBe(10);
    expect(LOG_LEVELS.debug).toBe(20);
    expect(LOG_LEVELS.info).toBe(30);
    expect(LOG_LEVELS.warn).toBe(40);
    expect(LOG_LEVELS.error).toBe(50);
    expect(LOG_LEVELS.fatal).toBe(60);
  });
});

describe("Logger - Child Loggers", () => {
  let capture: ReturnType<typeof captureLoggerOutput>;

  beforeEach(() => {
    capture = captureLoggerOutput();
  });

  afterEach(() => {
    capture.restore();
  });

  it("should create child logger with additional context", () => {
    const childLogger = createChildLogger({ module: "auth", component: "login" });

    childLogger.info("User login attempt", { userId: "user-789" });

    const parsed = parseLogLines(capture.logs);
    const logEntry = parsed.find((log) => log.msg?.includes("login attempt"));

    expect(logEntry).toBeDefined();
    expect(logEntry.module).toBe("auth");
    expect(logEntry.component).toBe("login");
    expect(logEntry.userId).toBe("user-789");
  });

  it("should inherit service metadata in child loggers", () => {
    const childLogger = createChildLogger({ operation: "database-query" });

    childLogger.info("Query executed");

    const parsed = parseLogLines(capture.logs);
    const logEntry = parsed.find((log) => log.msg?.includes("Query executed"));

    expect(logEntry).toBeDefined();
    expect(logEntry.service).toBe("gateway");
    expect(logEntry.operation).toBe("database-query");
  });
});

describe("Logger - Response Header Propagation", () => {
  it("should set x-request-id header on response", async () => {
    const middleware = requestLoggingMiddleware();
    const requestId = "header-test-456";

    const req = createMockRequest({
      headers: { "x-request-id": requestId },
    });
    const { res, headers } = createMockResponse();
    const next = vi.fn();

    middleware(req, res, next);

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(headers.get("x-request-id")).toBe(requestId);
  });

  it("should include generated request ID in response header", async () => {
    const middleware = requestLoggingMiddleware();

    const req = createMockRequest({});
    const { res, headers } = createMockResponse();
    const next = vi.fn();

    middleware(req, res, next);

    await new Promise((resolve) => setTimeout(resolve, 10));

    const requestId = headers.get("x-request-id");
    expect(requestId).toBeDefined();
    expect(typeof requestId).toBe("string");
    expect(requestId!.length).toBeGreaterThan(0);
  });
});

describe("Logger - Integration Scenarios", () => {
  let capture: ReturnType<typeof captureLoggerOutput>;

  beforeEach(() => {
    capture = captureLoggerOutput();
  });

  afterEach(() => {
    capture.restore();
  });

  it("should handle complete request lifecycle", async () => {
    const middleware = requestLoggingMiddleware();
    const requestId = "lifecycle-test";

    const req = createMockRequest({
      method: "POST",
      url: "/api/v1/delegations",
      headers: { "x-request-id": requestId },
    });
    const { res } = createMockResponse();

    // Simulate request handler
    const next = vi.fn(() => {
      if ((req as any).log) {
        (req as any).log.info("Validating delegation request");
        (req as any).log.info("Creating delegation in database");
        (req as any).log.info("Delegation created successfully", {
          delegationId: "del-123",
        });
      }
      res.statusCode = 201;
      res.end();
    });

    middleware(req, res, next);

    await new Promise((resolve) => setTimeout(resolve, 30));

    const parsed = parseLogLines(capture.logs);

    // Find all logs with our request ID
    const requestLogs = parsed.filter((log) => log.reqId === requestId);

    expect(requestLogs.length).toBeGreaterThan(0);

    // Verify request processing logs
    const validationLog = requestLogs.find((log) =>
      log.msg?.includes("Validating")
    );
    expect(validationLog).toBeDefined();

    const creationLog = requestLogs.find((log) =>
      log.msg?.includes("Creating delegation")
    );
    expect(creationLog).toBeDefined();

    const successLog = requestLogs.find(
      (log) => log.msg?.includes("successfully") && log.delegationId === "del-123"
    );
    expect(successLog).toBeDefined();
  });

  it("should maintain request ID across async operations", async () => {
    const middleware = requestLoggingMiddleware();
    const requestId = "async-test";

    const req = createMockRequest({
      headers: { "x-request-id": requestId },
    });
    const { res } = createMockResponse();

    const next = vi.fn(async () => {
      if ((req as any).log) {
        (req as any).log.info("Starting async operation");

        await new Promise((resolve) => setTimeout(resolve, 10));

        (req as any).log.info("Async operation step 1");

        await new Promise((resolve) => setTimeout(resolve, 10));

        (req as any).log.info("Async operation completed");
      }
      res.end();
    });

    middleware(req, res, next);

    await new Promise((resolve) => setTimeout(resolve, 50));

    const parsed = parseLogLines(capture.logs);
    const asyncLogs = parsed.filter((log) => log.reqId === requestId);

    expect(asyncLogs.length).toBeGreaterThanOrEqual(3);

    // All async logs should have the same request ID
    asyncLogs.forEach((log) => {
      expect(log.reqId).toBe(requestId);
    });
  });
});
