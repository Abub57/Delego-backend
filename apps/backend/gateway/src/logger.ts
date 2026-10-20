/**
 * Structured logging module using Pino
 *
 * Provides:
 * - JSON-structured logging with NDJSON output
 * - Request ID correlation via middleware
 * - Child loggers with contextual metadata
 * - Configurable log levels via LOG_LEVEL environment variable
 *
 * @module logger
 *
 * Issue #345 — memory leak fix:
 * Request logging previously relied on pino-http's default behavior of
 * calling `logger.child({ reqId, ... })` on every single request to build
 * `req.log`. Under sustained high-throughput traffic, each of those child
 * logger instances is a distinct object holding its own bound-context
 * closures, and anything downstream that captured a reference to `req.log`
 * (retry queues, async handlers, deferred callbacks) kept that whole child
 * alive well past the request's lifetime — a slow, steady heap leak.
 *
 * Fix: request context (reqId, method, path) now lives in an
 * AsyncLocalStorage store for the duration of the request instead of being
 * baked into a dedicated child logger object. The root logger's `mixin`
 * hook reads that store on every log call, so `req.log` can simply be the
 * *shared* root logger — no new bound instance is allocated per request,
 * and there is nothing per-request left for a stray reference to pin in
 * memory once the request completes.
 */

import pino from "pino";
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Per-request context (reqId, method, path) made available to every log
 * call made while handling that request, without allocating a child logger.
 * See the Issue #345 note above.
 */
const requestContextStorage = new AsyncLocalStorage<Record<string, unknown>>();

/**
 * Log levels supported by Pino
 */
export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

/**
 * Configure and create the root Pino logger instance
 */
function createRootLogger(): pino.Logger {
  const logLevel = (process.env.LOG_LEVEL || "info").toLowerCase() as LogLevel;
  
  // Determine if we're in development mode
  const isDevelopment = process.env.NODE_ENV === "development";
  
  return pino({
    level: logLevel,
    // Use ISO timestamps for better readability and compatibility
    timestamp: pino.stdTimeFunctions.isoTime,
    // Base metadata included in all logs
    base: {
      service: "gateway",
      env: process.env.NODE_ENV || "development",
      pid: process.pid,
    },
    // Issue #345: merge the current request's context (if any) into every
    // log line without allocating a child logger per request. `mixin` runs
    // on each log call and its return value is shallow-merged into that
    // call's fields, so request correlation stays accurate while the
    // underlying logger instance is reused across every request.
    mixin() {
      return requestContextStorage.getStore() ?? {};
    },
    // Pretty print in development for better readability
    transport: isDevelopment
      ? {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "SYS:standard",
            ignore: "pid,hostname",
          },
        }
      : undefined,
    // Format error objects properly
    serializers: {
      err: pino.stdSerializers.err,
      error: pino.stdSerializers.err,
      req: pino.stdSerializers.req,
      res: pino.stdSerializers.res,
    },
  });
}

/**
 * Root logger instance
 * Use this for application-level logging outside of request context
 */
export const logger = createRootLogger();

/**
 * Extract or generate request ID from incoming request
 * 
 * Checks for existing request ID in headers (supports common header names),
 * otherwise generates a new UUID v4.
 * 
 * @param req - Incoming HTTP request
 * @returns Request ID (existing or newly generated)
 */
function extractOrGenerateRequestId(req: IncomingMessage): string {
  // Check common request ID header names
  const headers = req.headers;
  const existingId =
    headers["x-request-id"] ||
    headers["x-correlation-id"] ||
    headers["x-trace-id"];
  
  if (existingId) {
    return Array.isArray(existingId) ? existingId[0] : existingId;
  }
  
  // Generate new UUID v4 for this request
  return randomUUID();
}

/**
 * Request logging middleware factory.
 *
 * Features:
 * - Extracts or generates request ID
 * - Attaches request ID to response headers for client tracing
 * - Makes request context (reqId, method, path) available to every log
 *   call made during the request via AsyncLocalStorage — without
 *   allocating a per-request child logger (see the Issue #345 note at the
 *   top of this file)
 * - Logs incoming requests and completed responses
 * - Includes response time and status code
 *
 * @returns Express-compatible middleware function
 */
export function createRequestLoggingMiddleware() {
  return (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void): void => {
    const reqId = extractOrGenerateRequestId(req);
    const path = req.url || "";
    const isHealthCheck =
      path === "/health" ||
      path === "/healthz" ||
      path === "/ready" ||
      path.startsWith("/health/");

    // `req.log` is the shared root logger, not a bound child instance — its
    // calls pick up { reqId, method, path } via the `mixin` hook reading
    // the AsyncLocalStorage store set up below. Nothing per-request is
    // allocated or retained here, so a stray reference to `req.log` can no
    // longer pin request-specific state in memory.
    (req as any).id = reqId;
    (req as any).log = logger;
    res.setHeader("x-request-id", reqId);

    const requestContext = { reqId, method: req.method, path };

    requestContextStorage.run(requestContext, () => {
      const startedAt = Date.now();

      if (!isHealthCheck) {
        logger.info(`Incoming ${req.method} ${req.url}`);
      }

      const originalEnd = res.end.bind(res);
      (res as any).end = function (this: ServerResponse, ...args: unknown[]) {
        if (!isHealthCheck) {
          const duration = Date.now() - startedAt;
          const message = `Completed ${req.method} ${req.url} - ${res.statusCode}`;
          if (res.statusCode >= 500) {
            logger.error({ duration }, message);
          } else if (res.statusCode >= 400) {
            logger.warn({ duration }, message);
          } else {
            logger.info({ duration }, message);
          }
        }
        return (originalEnd as (...a: unknown[]) => unknown).apply(this, args);
      };

      next();
    });
  };
}

/**
 * Middleware wrapper around {@link createRequestLoggingMiddleware}.
 * Kept as a separate export for backward compatibility with existing
 * call sites; the x-request-id header and req.log/req.id attachment now
 * happen inside the factory itself.
 */
export function requestLoggingMiddleware() {
  return createRequestLoggingMiddleware();
}

/**
 * Create a child logger with additional context
 * 
 * Useful for adding module-specific or operation-specific context
 * 
 * @param context - Additional context to include in all logs from this child logger
 * @returns Child logger instance
 * 
 * @example
 * const authLogger = createChildLogger({ module: 'auth' });
 * authLogger.info('User logged in', { userId: '123' });
 */
export function createChildLogger(context: Record<string, unknown>): pino.Logger {
  return logger.child(context);
}

/**
 * Log levels for manual level checking
 */
export const LOG_LEVELS = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
} as const;

/**
 * Check if a given log level is enabled
 * 
 * @param level - Log level to check
 * @returns true if the level is enabled, false otherwise
 */
export function isLogLevelEnabled(level: LogLevel): boolean {
  return logger.isLevelEnabled(level);
}

/**
 * Flush any pending log writes (useful for graceful shutdown)
 */
export async function flushLogs(): Promise<void> {
  return new Promise((resolve) => {
    // Pino uses async logging, give it time to flush
    setTimeout(() => {
      resolve();
    }, 100);
  });
}

/**
 * Type augmentation for Express Request with logger
 * Allows TypeScript to recognize req.log property
 */
declare module "http" {
  interface IncomingMessage {
    log: pino.Logger;
    id: string;
  }
}

// Log initialization
logger.info({
  level: logger.level,
  env: process.env.NODE_ENV,
}, "Logger initialized");
