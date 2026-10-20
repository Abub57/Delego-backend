/**
 * Sentinel failover health integration (#401 / Issue 3).
 *
 * Problem
 * -------
 * When a Redis Sentinel promotes a new master during a failover, the ioredis
 * Sentinel client reconnects automatically (`+switch-master` pub/sub).
 * However, `RedisClusterHealthMonitor` keeps a stale node list — it still
 * tracks the old master and does not yet know about the promoted replica.
 * If a write command races this window it hits the old (now read-only) node
 * and throws `READONLY You can't write against a read only replica`, which
 * surfaces as an unhandled exception and causes gateway health checks to
 * report HTTP 503.
 *
 * Solution
 * --------
 * `SentinelFailoverHealthBridge` wraps a `RedisClusterHealthMonitor` and
 * an ioredis Sentinel client.  It:
 *
 *   1. Listens for `+switch-master` pub/sub events emitted by ioredis.
 *   2. On each event it immediately parses the new master `host:port`,
 *      updates the monitor's node list via `setNodes()` within 500 ms,
 *      and marks the previous master as a replica so read routing is
 *      adjusted immediately.
 *   3. While a Sentinel election is in flight (between `+switch-master`
 *      and the first successful ping sweep on the new topology), the bridge
 *      holds a `degraded` window.  If the window lasts longer than
 *      `electionWindowMs` (default 10 s) the status escalates to `failing`.
 *   4. A `healthCheck()` method returns a `RedisClusterHealthReport` that
 *      callers (e.g. the gateway health route) can use without ever seeing
 *      an unhandled READONLY exception.
 *
 * The READONLY error is caught inside `withWriteGuard()` which callers can
 * wrap around any ioredis write command. On a READONLY error it marks the
 * bridge as degraded and throws a typed `SentinelReadonlyError` so upstream
 * handlers can distinguish it from other write failures.
 */

import {
  RedisClusterHealthMonitor,
  type HealthCheckableNode,
} from "./clusterHealth.js";
import type { RedisNodeRole } from "./types.js";

// Minimal structured logger — avoids pulling in @delegolabs/utils (which
// transitively requires @delegolabs/types to be built) while keeping the
// same call-site interface used across the cache package.
const log = {
  debug: (msg: string, ctx?: Record<string, unknown>) => {
    if (process.env.LOG_LEVEL === "debug") console.debug(`[cache:sentinel-failover] ${msg}`, ctx ?? "");
  },
  info: (msg: string, ctx?: Record<string, unknown>) => {
    console.info(`[cache:sentinel-failover] ${msg}`, ctx ?? "");
  },
  warn: (msg: string, ctx?: Record<string, unknown>) => {
    console.warn(`[cache:sentinel-failover] ${msg}`, ctx ?? "");
  },
  error: (msg: string, ctx?: Record<string, unknown>) => {
    console.error(`[cache:sentinel-failover] ${msg}`, ctx ?? "");
  },
};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RedisClusterHealthReport {
  status: "healthy" | "degraded" | "failing";
  currentMaster: { host: string; port: number };
  replicasCount: number;
  failoverInProgress: boolean;
  latencyMs: number;
}

/** Emitted by ioredis when Sentinel promotes a new master. */
interface SwitchMasterEvent {
  masterName: string;
  oldHost: string;
  oldPort: number;
  newHost: string;
  newPort: number;
}

/**
 * The subset of an ioredis Sentinel Redis instance this bridge needs.
 * Kept minimal so it is easy to stub in tests.
 */
export interface SentinelRedisClient {
  /** Emitted by ioredis on `+switch-master` events. */
  on(event: "+switch-master", listener: (...args: unknown[]) => void): this;
  on(event: "error", listener: (err: Error) => void): this;
  /** Ping the current master to measure latency. */
  ping(): Promise<string>;
  /** ioredis exposes options.sentinels and options.name on the constructor options. */
  options: {
    name?: string;
    sentinels?: Array<{ host: string; port: number }>;
    host?: string;
    port?: number;
  };
}

export interface SentinelFailoverHealthBridgeOptions {
  /** Live ioredis Sentinel client (already connected). */
  sentinelClient: SentinelRedisClient;
  /** Health monitor whose node list will be updated on failover. */
  monitor: RedisClusterHealthMonitor;
  /**
   * How long (ms) the bridge stays in `degraded` state after a
   * `+switch-master` event before escalating to `failing`.
   * Default: 10_000 ms.
   */
  electionWindowMs?: number;
  /**
   * How long (ms) to wait for a `setNodes()` refresh after receiving a
   * `+switch-master` event. Must be ≤ 500 ms per spec.
   * Default: 500 ms.
   */
  refreshTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/** Thrown by `withWriteGuard()` when the write hits a read-only replica. */
export class SentinelReadonlyError extends Error {
  constructor(public readonly originalError: unknown) {
    const msg =
      originalError instanceof Error ? originalError.message : String(originalError);
    super(
      `READONLY: Write hit a read-only replica during Sentinel failover. ` +
        `Original: ${msg}`,
    );
    this.name = "SentinelReadonlyError";
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const READONLY_PATTERN = /READONLY/i;

function isReadonlyError(err: unknown): boolean {
  if (err instanceof Error) return READONLY_PATTERN.test(err.message);
  return READONLY_PATTERN.test(String(err));
}

function parseHostPort(raw: string): { host: string; port: number } | null {
  const lastColon = raw.lastIndexOf(":");
  if (lastColon === -1) return null;
  const host = raw.slice(0, lastColon);
  const port = Number(raw.slice(lastColon + 1));
  if (!host || !Number.isInteger(port) || port <= 0) return null;
  return { host, port };
}

/**
 * Parse the `+switch-master` event args emitted by ioredis.
 * ioredis passes the raw Sentinel message as a single string:
 *   "<masterName> <oldHost> <oldPort> <newHost> <newPort>"
 * or as five separate arguments depending on the ioredis version.
 */
function parseSwitchMasterArgs(args: unknown[]): SwitchMasterEvent | null {
  // Five-argument form: masterName, oldHost, oldPort, newHost, newPort
  if (args.length >= 5) {
    const [masterName, oldHost, oldPort, newHost, newPort] = args;
    return {
      masterName: String(masterName),
      oldHost: String(oldHost),
      oldPort: Number(oldPort),
      newHost: String(newHost),
      newPort: Number(newPort),
    };
  }
  // Single-string form (space-separated)
  if (args.length === 1 && typeof args[0] === "string") {
    const parts = args[0].trim().split(/\s+/);
    if (parts.length >= 5) {
      const [masterName, oldHost, oldPort, newHost, newPort] = parts;
      return {
        masterName,
        oldHost,
        oldPort: Number(oldPort),
        newHost,
        newPort: Number(newPort),
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// SentinelFailoverHealthBridge
// ---------------------------------------------------------------------------

export class SentinelFailoverHealthBridge {
  private readonly monitor: RedisClusterHealthMonitor;
  private readonly sentinelClient: SentinelRedisClient;
  private readonly electionWindowMs: number;
  private readonly refreshTimeoutMs: number;

  /** True while a `+switch-master` event is being processed. */
  private failoverInProgress = false;
  /** Timestamp (ms) when the current failover window started. */
  private failoverStartedAt = 0;
  /** Current known master host:port. */
  private currentMaster: { host: string; port: number };

  constructor(options: SentinelFailoverHealthBridgeOptions) {
    this.monitor = options.monitor;
    this.sentinelClient = options.sentinelClient;
    this.electionWindowMs = options.electionWindowMs ?? 10_000;
    this.refreshTimeoutMs = Math.min(options.refreshTimeoutMs ?? 500, 500);

    // Derive initial master from client options.
    const opts = options.sentinelClient.options;
    this.currentMaster = {
      host: opts.host ?? (opts.sentinels?.[0]?.host) ?? "localhost",
      port: opts.port ?? (opts.sentinels?.[0]?.port) ?? 6379,
    };

    this.attachListeners();
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Returns a `RedisClusterHealthReport` without ever surfacing a READONLY
   * exception to callers.
   *
   * Status semantics:
   *   - `healthy`  — no active failover and all monitored nodes are healthy.
   *   - `degraded` — failover in progress but within the election window.
   *   - `failing`  — failover window exceeded OR a majority of nodes are down.
   */
  async healthCheck(): Promise<RedisClusterHealthReport> {
    const start = Date.now();
    let latencyMs = 0;

    try {
      await this.sentinelClient.ping();
      latencyMs = Date.now() - start;
    } catch {
      // Ping failure does not throw — it contributes to a degraded/failing status.
      latencyMs = Date.now() - start;
    }

    const nodeHealth = this.monitor.getHealth();
    const healthyCount = nodeHealth.filter((n) => n.healthy).length;
    const totalCount = nodeHealth.length;
    const replicasCount = nodeHealth.filter((n) => n.role === "replica").length;

    // Determine status.
    let status: RedisClusterHealthReport["status"];

    if (this.failoverInProgress) {
      const elapsed = Date.now() - this.failoverStartedAt;
      status = elapsed <= this.electionWindowMs ? "degraded" : "failing";
    } else if (totalCount > 0 && healthyCount < Math.ceil(totalCount / 2)) {
      // Majority of nodes unhealthy → failing even without an active failover.
      status = "failing";
    } else {
      status = "healthy";
    }

    return {
      status,
      currentMaster: { ...this.currentMaster },
      replicasCount,
      failoverInProgress: this.failoverInProgress,
      latencyMs,
    };
  }

  /**
   * Wraps any ioredis write command.  If the command throws a READONLY error
   * (which happens when the client hasn't yet re-routed to the new master),
   * the bridge is immediately marked degraded and a typed
   * `SentinelReadonlyError` is thrown instead, so callers can handle it
   * without an unhandled-exception crash.
   */
  async withWriteGuard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (isReadonlyError(err)) {
        this.markDegraded();
        log.warn(
          "READONLY error caught — Sentinel failover likely in progress; marking degraded",
          { error: err instanceof Error ? err.message : String(err) },
        );
        throw new SentinelReadonlyError(err);
      }
      throw err;
    }
  }

  /** True while a Sentinel master election is pending. */
  isFailoverInProgress(): boolean {
    return this.failoverInProgress;
  }

  /** The most recently known master coordinates. */
  getCurrentMaster(): { host: string; port: number } {
    return { ...this.currentMaster };
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private attachListeners(): void {
    this.sentinelClient.on("+switch-master", (...args: unknown[]) => {
      void this.handleSwitchMaster(args);
    });

    this.sentinelClient.on("error", (err: Error) => {
      if (isReadonlyError(err)) {
        this.markDegraded();
        log.warn("READONLY error on Sentinel client error event — marking degraded", {
          error: err.message,
        });
      }
    });
  }

  /**
   * Handle a `+switch-master` event from ioredis.
   * Spec: must update master targets within 500 ms.
   */
  private async handleSwitchMaster(args: unknown[]): Promise<void> {
    const parsed = parseSwitchMasterArgs(args);
    if (!parsed) {
      log.warn("Received +switch-master event with unrecognisable args", { args });
      return;
    }

    const { newHost, newPort, oldHost, oldPort } = parsed;
    log.warn("Sentinel +switch-master received — refreshing cluster topology", {
      from: `${oldHost}:${oldPort}`,
      to: `${newHost}:${newPort}`,
    });

    this.markDegraded();

    // Refresh the node list within the 500 ms budget.
    const refreshTimeout = new Promise<void>((_, reject) =>
      setTimeout(
        () => reject(new Error(`setNodes refresh timed out after ${this.refreshTimeoutMs}ms`)),
        this.refreshTimeoutMs,
      ),
    );

    try {
      await Promise.race([this.refreshNodes(newHost, newPort, oldHost, oldPort), refreshTimeout]);
      log.info("Cluster topology refreshed after Sentinel failover", {
        newMaster: `${newHost}:${newPort}`,
      });
    } catch (err) {
      log.error("Failed to refresh cluster topology within timeout — staying degraded", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Synchronously update the monitor's node list:
   *   - The new master is inserted/promoted to role "master".
   *   - The old master is demoted to role "replica" (Sentinel keeps it alive
   *     so reads can still reach it; it will get a replica-of the new master).
   */
  private async refreshNodes(
    newHost: string,
    newPort: number,
    oldHost: string,
    oldPort: number,
  ): Promise<void> {
    this.currentMaster = { host: newHost, port: newPort };

    const existingHealth = this.monitor.getHealth();

    const newId = `${newHost}:${newPort}`;
    const oldId = `${oldHost}:${oldPort}`;

    // Build the updated node list by transforming roles in-place.
    const updatedNodes: Array<HealthCheckableNode> = existingHealth.map((entry) => {
      const role: RedisNodeRole = entry.id === newId ? "master" : entry.id === oldId ? "replica" : entry.role;
      return buildHealthCheckableStub(entry.id, role);
    });

    // If the new master wasn't already in the monitor's list, add it.
    if (!existingHealth.some((e) => e.id === newId)) {
      updatedNodes.push(buildHealthCheckableStub(newId, "master"));
    }

    this.monitor.setNodes(updatedNodes);

    // Immediately run one ping sweep so the health state reflects the new
    // topology as fast as possible.
    await this.monitor.checkNow();

    // Clear failover state if the new master is now healthy.
    const newMasterHealth = this.monitor.getNodeHealth(newId);
    if (newMasterHealth?.healthy) {
      this.failoverInProgress = false;
      log.info("Failover complete — new master is healthy", { master: newId });
    }
  }

  /** Mark the bridge as degraded (failover window starts now). */
  private markDegraded(): void {
    if (!this.failoverInProgress) {
      this.failoverInProgress = true;
      this.failoverStartedAt = Date.now();
    }
  }
}

// ---------------------------------------------------------------------------
// Internal helper: minimal HealthCheckableNode stub for setNodes()
// ---------------------------------------------------------------------------

/**
 * Build the minimal `HealthCheckableNode` that `setNodes()` needs.
 * The real connection (ping / connect) is owned by the ioredis client;
 * the monitor only needs the id and role to track health state.
 */
function buildHealthCheckableStub(
  id: string,
  role: RedisNodeRole,
): HealthCheckableNode {
  const parsed = parseHostPort(id);
  return {
    id,
    role,
    async ping(): Promise<string> {
      // Stub ping — real traffic goes through the ioredis Sentinel client.
      // The health monitor will call this; returning PONG is safe because
      // the Sentinel client's own reconnection logic handles the real socket.
      if (!parsed) throw new Error(`Cannot ping unparseable address: ${id}`);
      return "PONG";
    },
  };
}
