/**
 * Graceful process teardown for the gateway service (Issue #391).
 *
 * Registers handlers for SIGTERM and SIGINT that:
 *   1. Stop accepting new connections via server.close().
 *   2. Allow up to DRAIN_TIMEOUT_MS for in-flight requests to complete.
 *   3. Force-close any connections that outlive the drain window.
 *   4. Close the database (Sequelize) and Redis connections cleanly.
 *   5. Exit with code 0 on success, code 1 on failure.
 *
 * The function is idempotent — if both SIGTERM and SIGINT arrive (e.g. in
 * a test harness), the shutdown sequence runs only once.
 */

import type { Server } from "node:http";
import { createLogger } from "@delegolabs/utils";
import { sequelize } from "./db.js";
import { disconnectRedis } from "./rateLimit/redisClient.js";
import { closeGlobalRateLimiter } from "./rateLimit/globalRedis.js";
import { sseClientPool } from "./sse/clientPool.js";

const log = createLogger("gateway:shutdown", process.env.LOG_LEVEL ?? "info");

/** Milliseconds to wait for in-flight requests before force-closing. */
export const DRAIN_TIMEOUT_MS = 10_000;

export interface ShutdownDeps {
  /** Sequelize instance with a `.close()` method. */
  closeDb?: () => Promise<void>;
  /** Redis disconnect function. */
  closeRedis?: () => Promise<void>;
  /** Drain timeout in milliseconds (override for tests). */
  drainTimeoutMs?: number;
  /** `process.exit` override for tests. */
  exit?: (code: number) => never | void;
  /** logger override for tests. */
  logger?: typeof log;
}

/**
 * Wraps `server.close()` in a Promise that resolves once the server stops
 * accepting new connections (all keep-alive connections have also closed, or
 * the server never had any).
 */
function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

/**
 * Returns a Promise that resolves after `ms` milliseconds (used as the drain
 * deadline race leg).
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Registers SIGTERM and SIGINT handlers for graceful shutdown.
 *
 * @param server - The HTTP server returned by `startHttpServer`.
 * @param deps   - Optional dependency overrides (for testing).
 */
export function registerGracefulShutdown(
  server: Server,
  deps: ShutdownDeps = {}
): void {
  const {
    closeDb = () => sequelize.close(),
    closeRedis = async () => { await Promise.all([disconnectRedis(), closeGlobalRateLimiter()]); },
    drainTimeoutMs = DRAIN_TIMEOUT_MS,
    exit = (code) => process.exit(code),
    logger = log,
  } = deps;

  let isShuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (isShuttingDown) {
      logger.warn("Shutdown already in progress, ignoring signal", { signal });
      return;
    }
    isShuttingDown = true;

    logger.info("Received shutdown signal — starting graceful teardown", { signal });

    sseClientPool.stop();

    try {
      // Race server.close() against the drain deadline.  Whichever settles
      // first wins: either all in-flight requests drained cleanly, or the
      // timeout expired and we force-close remaining keep-alive sockets.
      await Promise.race([
        closeServer(server),
        delay(drainTimeoutMs).then(() => {
          logger.warn("Drain timeout exceeded — forcing server close", { drainTimeoutMs });
          server.closeAllConnections?.();
        }),
      ]);
      logger.info("HTTP server closed — no longer accepting connections");
    } catch (err) {
      logger.warn("HTTP server close error (continuing shutdown)", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Close data-layer connections sequentially so each teardown is clean.
    try {
      await closeDb();
      logger.info("Database connection closed");
    } catch (err) {
      logger.error("Error closing database connection", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    try {
      await closeRedis();
      logger.info("Redis connection closed");
    } catch (err) {
      logger.error("Error closing Redis connection", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    logger.info("Graceful shutdown complete");
    exit(0);
  };

  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}
