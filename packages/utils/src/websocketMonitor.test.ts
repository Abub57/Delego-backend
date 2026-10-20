import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  WebSocketStallMonitor,
  computeReconnectBackoffMs,
  resolveReplayStartLedger,
  enableSocketKeepAlive,
  type PingPongSocket,
} from "./websocketMonitor.js";

// Issue #343 — stalled WebSocket detection: TCP keep-alive, read deadlines,
// ping/pong monitoring, reconnect backoff, and ledger replay resume.

function makeFakeSocket() {
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  const socket: PingPongSocket = {
    ping: vi.fn(),
    terminate: vi.fn(),
    on: (event, listener) => {
      (listeners[event] ??= []).push(listener);
      return socket;
    },
  };
  return {
    socket,
    emit: (event: string, ...args: unknown[]) => {
      for (const listener of listeners[event] ?? []) listener(...args);
    },
  };
}

describe("WebSocketStallMonitor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("declares a stall via the read deadline when no traffic arrives at all", () => {
    const { socket } = makeFakeSocket();
    const onStalled = vi.fn();
    const monitor = new WebSocketStallMonitor(socket, { onStalled }, {
      heartbeatIntervalMs: 10_000,
      readTimeoutMs: 30_000,
      reconnectBackoffMs: 1_000,
      maxConsecutiveMisses: 3,
    });

    monitor.start();
    vi.advanceTimersByTime(30_000);

    expect(onStalled).toHaveBeenCalledWith("read_timeout");
    expect(socket.terminate).toHaveBeenCalledTimes(1);
  });

  it("declares a stall after maxConsecutiveMisses unanswered pings, within 30s", () => {
    const { socket } = makeFakeSocket();
    const onStalled = vi.fn();
    const monitor = new WebSocketStallMonitor(socket, { onStalled }, {
      heartbeatIntervalMs: 10_000,
      // Deliberately longer than maxConsecutiveMisses * heartbeatIntervalMs so
      // the read deadline can't fire at the same instant: this test isolates
      // the unanswered-heartbeat path.
      readTimeoutMs: 60_000,
      reconnectBackoffMs: 1_000,
      maxConsecutiveMisses: 3,
    });

    monitor.start();
    // Three unanswered heartbeats at 10s apiece = 30s, within the acceptance
    // criterion's 30s stall-detection budget.
    vi.advanceTimersByTime(10_000);
    vi.advanceTimersByTime(10_000);
    vi.advanceTimersByTime(10_000);

    expect(onStalled).toHaveBeenCalledWith("max_misses_exceeded");
    expect(socket.ping).toHaveBeenCalledTimes(3);
  });

  it("does not declare a stall while pongs keep arriving", () => {
    const { socket, emit } = makeFakeSocket();
    const onStalled = vi.fn();
    const monitor = new WebSocketStallMonitor(socket, { onStalled }, {
      heartbeatIntervalMs: 10_000,
      readTimeoutMs: 30_000,
      reconnectBackoffMs: 1_000,
      maxConsecutiveMisses: 3,
    });

    monitor.start();
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(10_000);
      emit("pong");
    }

    expect(onStalled).not.toHaveBeenCalled();
  });

  it("resets the read deadline on any inbound message, not just pong", () => {
    const { socket, emit } = makeFakeSocket();
    const onStalled = vi.fn();
    const monitor = new WebSocketStallMonitor(socket, { onStalled }, {
      heartbeatIntervalMs: 10_000,
      readTimeoutMs: 30_000,
      reconnectBackoffMs: 1_000,
      maxConsecutiveMisses: 100,
    });

    monitor.start();
    vi.advanceTimersByTime(25_000);
    emit("message", "data");
    vi.advanceTimersByTime(25_000);

    expect(onStalled).not.toHaveBeenCalled();
  });

  it("stop() clears timers so no late callback fires", () => {
    const { socket } = makeFakeSocket();
    const onStalled = vi.fn();
    const monitor = new WebSocketStallMonitor(socket, { onStalled });

    monitor.start();
    monitor.stop();
    vi.advanceTimersByTime(60_000);

    expect(onStalled).not.toHaveBeenCalled();
  });
});

describe("computeReconnectBackoffMs", () => {
  it("doubles each attempt starting from the base", () => {
    expect(computeReconnectBackoffMs(1, 1000)).toBe(1000);
    expect(computeReconnectBackoffMs(2, 1000)).toBe(2000);
    expect(computeReconnectBackoffMs(3, 1000)).toBe(4000);
  });

  it("caps at maxMs", () => {
    expect(computeReconnectBackoffMs(10, 1000, 30_000)).toBe(30_000);
  });

  it("treats attempt 0 or negative as attempt 1", () => {
    expect(computeReconnectBackoffMs(0, 1000)).toBe(1000);
    expect(computeReconnectBackoffMs(-5, 1000)).toBe(1000);
  });
});

describe("resolveReplayStartLedger", () => {
  it("resumes from the ledger right after the last confirmed one", () => {
    expect(resolveReplayStartLedger(1000)).toBe(1001);
  });

  it("treats a missing/invalid last-confirmed ledger as starting from 0", () => {
    expect(resolveReplayStartLedger(Number.NaN)).toBe(0);
    expect(resolveReplayStartLedger(-1)).toBe(0);
  });
});

describe("enableSocketKeepAlive", () => {
  it("enables TCP keep-alive on the underlying socket", () => {
    const setKeepAlive = vi.fn();
    enableSocketKeepAlive({ setKeepAlive }, 15_000);
    expect(setKeepAlive).toHaveBeenCalledWith(true, 15_000);
  });

  it("does not throw when the socket is missing or doesn't support it", () => {
    expect(() => enableSocketKeepAlive(null)).not.toThrow();
    expect(() => enableSocketKeepAlive(undefined)).not.toThrow();
    expect(() => enableSocketKeepAlive({} as any)).not.toThrow();
  });
});
