/**
 * Stalled WebSocket detection — TCP keep-alive, read deadlines, ping/pong
 * monitoring, and reconnect-with-replay helpers (Issue #343).
 *
 * WebSocket connections streaming Horizon / Soroban RPC ledger/event data
 * (and, symmetrically, this service's own outbound push-notification
 * socket) can go silent on a network drop without ever emitting a `close`
 * event — the TCP connection is torn down somewhere in the middle (a NAT
 * timeout, a dead load balancer, a sleeping laptop) but neither side's
 * socket layer finds out, so nothing ever fires `close`/`error` and a
 * listener built only around those events just stops receiving data
 * forever.
 *
 * This module provides the provider-agnostic pieces needed to detect and
 * recover from that:
 *
 *   1. {@link enableSocketKeepAlive} — turns on OS-level TCP keep-alive
 *      probes on the underlying socket, so a genuinely dead peer is
 *      reported by the OS instead of hanging indefinitely.
 *   2. {@link WebSocketStallMonitor} — an application-level ping/pong
 *      heartbeat + read deadline on top of that: if no pong (or any other
 *      traffic) arrives within `readTimeoutMs`, or `maxConsecutiveMisses`
 *      heartbeats go unanswered, the connection is declared stalled and
 *      torn down proactively rather than waiting on the OS.
 *   3. {@link computeReconnectBackoffMs} / {@link resolveReplayStartLedger}
 *      — the reconnect-with-backoff and "resume from the last confirmed
 *      ledger" logic a streaming client runs after a stall is detected.
 *
 * Scoping note: this does not hard-wire a specific Horizon/Soroban RPC
 * client (which SDK, which endpoint, which auth) — that's a toolchain
 * decision for the specific listener wiring this in. What's here is the
 * pure, testable "is this connection still alive, and where do I resume
 * from" logic those listeners (and this service's own push-notification
 * WebSocket server) both need.
 */

export interface WebSocketMonitorConfig {
  heartbeatIntervalMs: number;
  readTimeoutMs: number;
  reconnectBackoffMs: number;
  maxConsecutiveMisses: number;
}

/** Detects stalls within ~30s, per the issue's acceptance criteria. */
export const DEFAULT_WEBSOCKET_MONITOR_CONFIG: WebSocketMonitorConfig = {
  heartbeatIntervalMs: 10_000,
  readTimeoutMs: 30_000,
  reconnectBackoffMs: 1_000,
  maxConsecutiveMisses: 3,
};

/** Minimal subset of the underlying `net.Socket` this module depends on. */
export interface KeepAliveSocket {
  setKeepAlive(enable: boolean, initialDelayMs?: number): unknown;
}

/**
 * Enable OS-level TCP keep-alive probing on the socket underneath a
 * WebSocket connection (e.g. `ws`'s `_socket`, or the `req.socket` handed
 * to an `upgrade`/`connection` handler). Safe to call on a socket that
 * doesn't support it (no-ops rather than throwing).
 */
export function enableSocketKeepAlive(
  socket: KeepAliveSocket | null | undefined,
  initialDelayMs = 30_000
): void {
  socket?.setKeepAlive?.(true, initialDelayMs);
}

/** Minimal subset of the `ws` WebSocket API this module depends on. */
export interface PingPongSocket {
  ping(data?: unknown): void;
  terminate(): void;
  on(event: "pong" | "message" | "close", listener: (...args: unknown[]) => void): unknown;
}

export interface WebSocketStallMonitorHooks {
  /** Called exactly once, the first time a stall is detected. */
  onStalled: (reason: "read_timeout" | "max_misses_exceeded") => void;
}

/**
 * Drives a ping/pong heartbeat against `socket` and declares it stalled —
 * via `hooks.onStalled` — if either:
 *   - no inbound traffic (pong or message) arrives within `readTimeoutMs`, or
 *   - `maxConsecutiveMisses` consecutive heartbeats go unanswered.
 *
 * Call {@link start} once the socket is open and {@link stop} when it
 * closes normally, to clear timers.
 */
export class WebSocketStallMonitor {
  private readonly config: WebSocketMonitorConfig;
  private readonly socket: PingPongSocket;
  private readonly hooks: WebSocketStallMonitorHooks;

  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private readDeadlineTimer: ReturnType<typeof setTimeout> | null = null;
  private consecutiveMisses = 0;
  private stopped = false;

  constructor(
    socket: PingPongSocket,
    hooks: WebSocketStallMonitorHooks,
    config: WebSocketMonitorConfig = DEFAULT_WEBSOCKET_MONITOR_CONFIG
  ) {
    this.socket = socket;
    this.hooks = hooks;
    this.config = config;
  }

  start(): void {
    this.socket.on("pong", () => this.noteActivity());
    this.socket.on("message", () => this.noteActivity());
    this.socket.on("close", () => this.stop());

    this.armReadDeadline();
    this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), this.config.heartbeatIntervalMs);
    (this.heartbeatTimer as { unref?: () => void }).unref?.();
  }

  /** Call on any inbound traffic to reset the read deadline / miss counter. */
  noteActivity(): void {
    if (this.stopped) return;
    this.consecutiveMisses = 0;
    this.armReadDeadline();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.readDeadlineTimer) clearTimeout(this.readDeadlineTimer);
    this.heartbeatTimer = null;
    this.readDeadlineTimer = null;
  }

  private armReadDeadline(): void {
    if (this.readDeadlineTimer) clearTimeout(this.readDeadlineTimer);
    this.readDeadlineTimer = setTimeout(() => this.declareStalled("read_timeout"), this.config.readTimeoutMs);
    (this.readDeadlineTimer as { unref?: () => void }).unref?.();
  }

  private sendHeartbeat(): void {
    if (this.stopped) return;

    // The heartbeat being sent is itself unanswered until traffic arrives
    // (noteActivity() clears the counter), so it counts as a miss. Counting it
    // — rather than only the heartbeats after the first — makes
    // `maxConsecutiveMisses` unanswered heartbeats trip the stall at exactly
    // maxConsecutiveMisses * heartbeatIntervalMs.
    this.consecutiveMisses += 1;

    try {
      this.socket.ping();
    } catch {
      // A throw here means the socket is already dead — the read deadline
      // (or the next missed-pong count) will catch it; nothing else to do.
    }

    if (this.consecutiveMisses >= this.config.maxConsecutiveMisses) {
      this.declareStalled("max_misses_exceeded");
    }
  }

  private declareStalled(reason: "read_timeout" | "max_misses_exceeded"): void {
    if (this.stopped) return;
    this.stop();
    try {
      this.socket.terminate();
    } finally {
      this.hooks.onStalled(reason);
    }
  }
}

/**
 * Exponential backoff with a cap, for reconnect attempts after a stall.
 * `attempt` is 1-based (the first retry).
 */
export function computeReconnectBackoffMs(
  attempt: number,
  baseMs: number = DEFAULT_WEBSOCKET_MONITOR_CONFIG.reconnectBackoffMs,
  maxMs = 30_000
): number {
  const safeAttempt = Math.max(1, Math.floor(attempt));
  return Math.min(baseMs * 2 ** (safeAttempt - 1), maxMs);
}

/**
 * Resume point for a reconnecting ledger/event stream: the ledger
 * immediately after the last one fully processed, so reconnecting neither
 * reprocesses the last confirmed ledger nor skips the one right after it
 * (the "zero missed ledgers" acceptance criterion).
 */
export function resolveReplayStartLedger(lastConfirmedLedgerSequence: number): number {
  if (!Number.isFinite(lastConfirmedLedgerSequence) || lastConfirmedLedgerSequence < 0) {
    return 0;
  }
  return Math.floor(lastConfirmedLedgerSequence) + 1;
}
