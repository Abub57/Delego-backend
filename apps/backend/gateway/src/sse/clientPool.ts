/**
 * SSE client pool for the gateway (#337).
 *
 * `agentChat.ts` streams one response per connected client over
 * `text/event-stream`. Behind certain reverse proxies / load balancers the
 * TCP connection can go half-open on the client side without the server
 * ever observing `req.close` (some proxies buffer or swallow the FIN), so a
 * handler that only cleans up on `req.on('close')` leaks the `ServerResponse`
 * — and everything it closes over — for as long as the process runs.
 *
 * This pool fixes that by:
 *   - Registering every SSE connection in a tracked session map.
 *   - Wiring cleanup to req 'close', req 'end' AND res 'finish' (and
 *     res 'close'/'error') so removal happens exactly once no matter which
 *     event a given proxy actually delivers.
 *   - Sending a periodic 15s heartbeat comment frame to every open
 *     connection; a failed write (broken pipe) or a connection that has
 *     gone silent past the stale window is force-closed and evicted,
 *     surfacing half-open sockets the proxy never reported.
 *   - Exposing pool size + heap usage for telemetry (see metrics.ts).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { createLogger } from "@delegolabs/utils";

const log = createLogger("gateway:sse-pool", process.env.LOG_LEVEL ?? "info");

export interface SseClientSession {
  sessionId: string;
  userId: string;
  response: ServerResponse;
  connectedAt: number;
  lastHeartbeat: number;
}

export interface SseClientPoolOptions {
  /** How often to ping every open connection. */
  heartbeatIntervalMs?: number;
  /** Evict a connection that hasn't had a successful heartbeat in this long. */
  staleAfterMs?: number;
}

export interface SseClientPoolStats {
  activeConnections: number;
  heapUsedBytes: number;
  rssBytes: number;
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
// Three missed heartbeats before we consider the socket half-open.
const DEFAULT_STALE_AFTER_MS = DEFAULT_HEARTBEAT_INTERVAL_MS * 3;

export class SseClientPool {
  private readonly sessions = new Map<string, SseClientSession>();
  private readonly heartbeatIntervalMs: number;
  private readonly staleAfterMs: number;
  private timer: NodeJS.Timeout | null = null;

  constructor(options: SseClientPoolOptions = {}) {
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  }

  /** Starts the periodic heartbeat sweep. Idempotent. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.sweep(), this.heartbeatIntervalMs);
    // A pool with zero clients shouldn't keep the event loop (and process)
    // alive on its own.
    this.timer.unref?.();
  }

  /** Stops the heartbeat sweep (used on graceful shutdown / tests). */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  get size(): number {
    return this.sessions.size;
  }

  /**
   * Registers a new SSE client and wires every disconnect signal Node
   * exposes to a single idempotent cleanup, so the session is always
   * removed from the pool exactly once.
   */
  register(
    req: IncomingMessage,
    res: ServerResponse,
    init: { sessionId: string; userId: string }
  ): SseClientSession {
    const now = Date.now();
    const session: SseClientSession = {
      sessionId: init.sessionId,
      userId: init.userId,
      response: res,
      connectedAt: now,
      lastHeartbeat: now,
    };
    this.sessions.set(session.sessionId, session);
    this.start();

    log.info("SSE client registered", {
      sessionId: session.sessionId,
      userId: session.userId,
      poolSize: this.sessions.size,
    });

    let removed = false;
    const cleanup = (reason: string): void => {
      if (removed) return;
      removed = true;
      this.sessions.delete(session.sessionId);
      log.info("SSE client removed from pool", {
        sessionId: session.sessionId,
        reason,
        poolSize: this.sessions.size,
      });
    };

    // Register on every teardown signal available — some reverse proxies
    // never deliver 'close' on the request, but always deliver 'finish' (or
    // vice versa for long-lived streams that error out).
    req.on("close", () => cleanup("req:close"));
    req.on("end", () => cleanup("req:end"));
    res.on("finish", () => cleanup("res:finish"));
    res.on("close", () => cleanup("res:close"));
    res.on("error", (err: Error) => {
      log.warn("SSE client response error", { sessionId: session.sessionId, error: err.message });
      cleanup("res:error");
    });

    return session;
  }

  /** Explicit removal — safe to call even if teardown already ran. */
  remove(sessionId: string): void {
    if (this.sessions.delete(sessionId)) {
      log.info("SSE client removed from pool", { sessionId, reason: "explicit", poolSize: this.sessions.size });
    }
  }

  /** Marks a session as recently active (e.g. after a real data frame). */
  touch(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) session.lastHeartbeat = Date.now();
  }

  /** Point-in-time telemetry snapshot (#337 acceptance criterion). */
  stats(): SseClientPoolStats {
    const mem = process.memoryUsage();
    return {
      activeConnections: this.sessions.size,
      heapUsedBytes: mem.heapUsed,
      rssBytes: mem.rss,
    };
  }

  /**
   * Heartbeat sweep: pings every open connection and evicts anything that
   * is already closed, errors on write (broken pipe), or has gone silent
   * past `staleAfterMs` — the half-open-behind-a-proxy case this issue
   * exists to fix.
   */
  private sweep(): void {
    const now = Date.now();

    for (const session of [...this.sessions.values()]) {
      if (session.response.destroyed || session.response.writableEnded) {
        this.sessions.delete(session.sessionId);
        continue;
      }

      if (now - session.lastHeartbeat > this.staleAfterMs) {
        log.warn("Evicting stale SSE client (half-open connection)", {
          sessionId: session.sessionId,
          idleMs: now - session.lastHeartbeat,
        });
        this.sessions.delete(session.sessionId);
        try {
          session.response.end();
        } catch {
          // Socket already gone — nothing to clean up.
        }
        continue;
      }

      try {
        // Write with a callback so a broken pipe (ECONNRESET/EPIPE) on an
        // otherwise-undetected half-open socket surfaces as an error here
        // instead of silently buffering forever.
        session.response.write(`: heartbeat ${now}\n\n`, (err) => {
          if (err) {
            log.warn("SSE heartbeat write failed — evicting dead client", {
              sessionId: session.sessionId,
              error: err.message,
            });
            this.sessions.delete(session.sessionId);
          }
        });
        session.lastHeartbeat = now;
      } catch (err) {
        log.warn("SSE heartbeat threw synchronously — evicting client", {
          sessionId: session.sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
        this.sessions.delete(session.sessionId);
      }
    }
  }
}

/** Process-wide pool shared by every SSE route in the gateway. */
export const sseClientPool = new SseClientPool();
