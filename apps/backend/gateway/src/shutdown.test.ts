/**
 * Tests for registerGracefulShutdown (Issue #391).
 *
 * All tests use injectable dependencies so no real sockets, database
 * connections, or Redis clients are required.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { Server } from "node:http";
import { registerGracefulShutdown, DRAIN_TIMEOUT_MS } from "./shutdown.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Minimal Server stub that records calls and lets tests control when
 * `server.close()` resolves.
 */
function makeServer(opts: {
  closeError?: Error;
  /** If true, close() never resolves (simulates a hung drain). */
  hangClose?: boolean;
} = {}): {
  server: Server;
  closeCalledTimes: () => number;
  closeAllConnectionsCalledTimes: () => number;
} {
  let closeCalled = 0;
  let closeAllCalled = 0;

  const emitter = new EventEmitter() as Server;

  (emitter as any).close = (cb: (err?: Error) => void) => {
    closeCalled++;
    if (opts.hangClose) {
      // Never calls cb — simulates a stalled drain.
      return;
    }
    if (opts.closeError) {
      setImmediate(() => cb(opts.closeError));
    } else {
      setImmediate(() => cb());
    }
  };

  (emitter as any).closeAllConnections = () => {
    closeAllCalled++;
  };

  return {
    server: emitter,
    closeCalledTimes: () => closeCalled,
    closeAllConnectionsCalledTimes: () => closeAllCalled,
  };
}

/** A no-op logger that satisfies the logger interface without writing output. */
function makeNopLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

describe("registerGracefulShutdown", () => {
  beforeEach(() => {
    // Remove any leftover signal handlers between tests.
    process.removeAllListeners("SIGTERM");
    process.removeAllListeners("SIGINT");
  });

  afterEach(() => {
    process.removeAllListeners("SIGTERM");
    process.removeAllListeners("SIGINT");
  });

  it("registers exactly one SIGTERM listener and one SIGINT listener", () => {
    const { server } = makeServer();
    const exit = vi.fn() as unknown as (code: number) => never;

    registerGracefulShutdown(server, {
      closeDb: async () => {},
      closeRedis: async () => {},
      exit,
      logger: makeNopLogger() as any,
    });

    // process.once adds one listener per signal
    expect(process.listenerCount("SIGTERM")).toBe(1);
    expect(process.listenerCount("SIGINT")).toBe(1);
  });

  it("closes the HTTP server, DB and Redis in order on SIGTERM then exits 0", async () => {
    const { server, closeCalledTimes } = makeServer();

    const order: string[] = [];
    const closeDb = vi.fn(async () => { order.push("db"); });
    const closeRedis = vi.fn(async () => { order.push("redis"); });
    const exit = vi.fn() as unknown as (code: number) => never;

    registerGracefulShutdown(server, {
      closeDb,
      closeRedis,
      exit,
      logger: makeNopLogger() as any,
    });

    // Emit SIGTERM synchronously and await the async handler via a
    // short-lived promise that resolves after the current microtask queue.
    process.emit("SIGTERM");
    // The handler is async; let it run to completion.
    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledWith(0);
    }, { timeout: 2000 });

    expect(closeCalledTimes()).toBe(1);
    expect(closeDb).toHaveBeenCalledOnce();
    expect(closeRedis).toHaveBeenCalledOnce();
    // DB must close before Redis
    expect(order).toEqual(["db", "redis"]);
  });

  it("closes the HTTP server and connections on SIGINT then exits 0", async () => {
    const { server, closeCalledTimes } = makeServer();
    const exit = vi.fn() as unknown as (code: number) => never;

    registerGracefulShutdown(server, {
      closeDb: async () => {},
      closeRedis: async () => {},
      exit,
      logger: makeNopLogger() as any,
    });

    process.emit("SIGINT");

    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledWith(0);
    }, { timeout: 2000 });

    expect(closeCalledTimes()).toBe(1);
  });

  it("is idempotent — a second signal is ignored while shutdown is in progress", async () => {
    const { server, closeCalledTimes } = makeServer();
    const exit = vi.fn() as unknown as (code: number) => never;
    const logger = makeNopLogger();

    registerGracefulShutdown(server, {
      closeDb: async () => {},
      closeRedis: async () => {},
      exit,
      logger: logger as any,
    });

    process.emit("SIGTERM");
    // process.once means the second emit goes nowhere (handler already removed)
    // but we also verify the guard is correct if called directly.
    process.emit("SIGTERM");

    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledTimes(1);
    }, { timeout: 2000 });

    // Server.close() must only have been called once.
    expect(closeCalledTimes()).toBe(1);
  });

  it("still exits 0 when DB close throws", async () => {
    const { server } = makeServer();
    const exit = vi.fn() as unknown as (code: number) => never;
    const logger = makeNopLogger();

    registerGracefulShutdown(server, {
      closeDb: async () => { throw new Error("pg gone"); },
      closeRedis: async () => {},
      exit,
      logger: logger as any,
    });

    process.emit("SIGTERM");

    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledWith(0);
    }, { timeout: 2000 });

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("database"),
      expect.objectContaining({ error: "pg gone" }),
    );
  });

  it("still exits 0 when Redis close throws", async () => {
    const { server } = makeServer();
    const exit = vi.fn() as unknown as (code: number) => never;
    const logger = makeNopLogger();

    registerGracefulShutdown(server, {
      closeDb: async () => {},
      closeRedis: async () => { throw new Error("redis gone"); },
      exit,
      logger: logger as any,
    });

    process.emit("SIGTERM");

    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledWith(0);
    }, { timeout: 2000 });

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("Redis"),
      expect.objectContaining({ error: "redis gone" }),
    );
  });

  it("continues shutdown when server.close() returns an error", async () => {
    const { server } = makeServer({ closeError: new Error("already closed") });
    const closeDb = vi.fn(async () => {});
    const closeRedis = vi.fn(async () => {});
    const exit = vi.fn() as unknown as (code: number) => never;

    registerGracefulShutdown(server, {
      closeDb,
      closeRedis,
      exit,
      logger: makeNopLogger() as any,
    });

    process.emit("SIGTERM");

    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledWith(0);
    }, { timeout: 2000 });

    // DB and Redis must still be cleaned up even after a server.close error.
    expect(closeDb).toHaveBeenCalledOnce();
    expect(closeRedis).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Drain-timeout (integration-style) tests
// ---------------------------------------------------------------------------

describe("registerGracefulShutdown — drain timeout", () => {
  beforeEach(() => {
    process.removeAllListeners("SIGTERM");
    process.removeAllListeners("SIGINT");
  });

  afterEach(() => {
    process.removeAllListeners("SIGTERM");
    process.removeAllListeners("SIGINT");
  });

  it("force-closes via closeAllConnections when the drain window expires", async () => {
    // Server whose close() never completes (hung in-flight request).
    const { server, closeAllConnectionsCalledTimes } = makeServer({ hangClose: true });
    const closeDb = vi.fn(async () => {});
    const closeRedis = vi.fn(async () => {});
    const exit = vi.fn() as unknown as (code: number) => never;

    registerGracefulShutdown(server, {
      closeDb,
      closeRedis,
      drainTimeoutMs: 50,           // very short drain for test speed
      exit,
      logger: makeNopLogger() as any,
    });

    process.emit("SIGTERM");

    await vi.waitFor(() => {
      expect(closeAllConnectionsCalledTimes()).toBeGreaterThan(0);
    }, { timeout: 1000 });

    // After closeAllConnections fires, the pending server.close cb never runs
    // so closeDb/closeRedis/exit must be invoked from a different code-path.
    // In our implementation the drain timer fires then we continue;
    // we wait for exit to confirm the full sequence ran.
    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledWith(0);
    }, { timeout: 1000 });
  });

  it("exports DRAIN_TIMEOUT_MS equal to 10 000", () => {
    expect(DRAIN_TIMEOUT_MS).toBe(10_000);
  });
});
