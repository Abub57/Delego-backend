/**
 * Automatic Redis Cluster health checking and reconnection.
 *
 * `ioredis` re-resolves a node's address only when it receives a `MOVED`
 * error. A node that dies and comes back on the same address — a restarted
 * replica, an OOM-killed pod rescheduled to the same IP — is therefore
 * invisible to the client until something happens to trigger a slot refresh,
 * and ioredis' own `clusterNodeRetryStrategy` handles the socket while this
 * monitor answers the separate question of "should we still send this node
 * traffic".
 *
 * `RedisClusterHealthMonitor` pings every node on an interval, flips a node
 * to unhealthy after N consecutive failures, and asks the caller to
 * reconnect it once on the healthy -> unhealthy transition. The resulting
 * per-node health state is what `RedisClusterFailoverClient` consults before
 * routing a read to a replica, so a replica that has failed its health check
 * stops attracting read traffic instead of accumulating timeouts.
 *
 * Scope note: this pings and reconnects; it does not perform failover. Master
 * promotion is Redis' own job and surfaces to the client as a changed
 * `CLUSTER SLOTS` map.
 */
import { createLogger } from "@delegolabs/utils";
import type { RedisNodeHealth, RedisNodeRole } from "./types.js";

const log = createLogger("cache:cluster-health", process.env.LOG_LEVEL ?? "info");

/** The subset of an ioredis node connection this monitor needs. */
export interface HealthCheckableNode {
  id: string;
  role: RedisNodeRole;
  ping(): Promise<string>;
  connect?(): Promise<unknown>;
}

export interface RedisClusterHealthMonitorOptions {
  nodes: HealthCheckableNode[];
  /** How often to run a ping sweep. */
  intervalMs: number;
  /** Per-ping timeout; a ping slower than this counts as a failure. */
  pingTimeoutMs: number;
  /** Consecutive failures required before a node is marked unhealthy. */
  failureThreshold: number;
  /**
   * Invoked once when a node transitions healthy -> unhealthy. ioredis'
   * `clusterNodeRetryStrategy` already re-dials the socket, so this defaults
   * to triggering an explicit reconnect; pass `undefined` to observe health
   * changes without reconnecting.
   */
  onUnhealthy?: (node: HealthCheckableNode, error: unknown) => void | Promise<void>;
  /** Invoked once when a node transitions unhealthy -> healthy. */
  onHealthy?: (node: HealthCheckableNode) => void | Promise<void>;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    // Never let a pending ping timer keep the process alive.
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

export class RedisClusterHealthMonitor {
  private readonly options: RedisClusterHealthMonitorOptions;
  private readonly health = new Map<string, RedisNodeHealth>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private sweepInFlight: Promise<void> | null = null;

  constructor(options: RedisClusterHealthMonitorOptions) {
    if (options.nodes.length === 0) {
      throw new Error("RedisClusterHealthMonitor requires at least one node");
    }
    if (options.failureThreshold < 1) {
      throw new Error("RedisClusterHealthMonitor failureThreshold must be >= 1");
    }

    this.options = options;

    // Nodes start out healthy: an unknown node has not been observed to be
    // broken, and treating it as unhealthy would mean refusing to route to
    // every replica until the first sweep completes.
    for (const node of options.nodes) {
      this.health.set(node.id, {
        id: node.id,
        role: node.role,
        healthy: true,
        consecutiveFailures: 0,
      });
    }
  }

  /** Replace the monitored node set, e.g. after a topology refresh. */
  setNodes(nodes: HealthCheckableNode[]): void {
    const nextIds = new Set(nodes.map((n) => n.id));
    for (const id of [...this.health.keys()]) {
      if (!nextIds.has(id)) this.health.delete(id);
    }
    for (const node of nodes) {
      const existing = this.health.get(node.id);
      if (existing) {
        existing.role = node.role;
      } else {
        this.health.set(node.id, {
          id: node.id,
          role: node.role,
          healthy: true,
          consecutiveFailures: 0,
        });
      }
    }
  }

  /** Current health snapshot for every monitored node, in stable id order. */
  getHealth(): RedisNodeHealth[] {
    return [...this.health.values()]
      .map((entry) => ({ ...entry }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Health of one node, or `undefined` if it is not monitored. */
  getNodeHealth(id: string): RedisNodeHealth | undefined {
    const entry = this.health.get(id);
    return entry ? { ...entry } : undefined;
  }

  /** True when the node is monitored and has not exceeded the failure threshold. */
  isHealthy(id: string): boolean {
    return this.health.get(id)?.healthy ?? false;
  }

  /**
   * Run one ping sweep across all nodes.
   *
   * Overlapping calls collapse onto the in-flight sweep so a slow node cannot
   * stack up concurrent pings behind the interval.
   */
  async checkNow(): Promise<void> {
    if (this.sweepInFlight) return this.sweepInFlight;

    this.sweepInFlight = this.runSweep().finally(() => {
      this.sweepInFlight = null;
    });
    return this.sweepInFlight;
  }

  private async runSweep(): Promise<void> {
    await Promise.all(this.options.nodes.map((node) => this.checkNode(node)));
  }

  private async checkNode(node: HealthCheckableNode): Promise<void> {
    const entry = this.health.get(node.id);
    if (!entry) return;

    try {
      await withTimeout(node.ping(), this.options.pingTimeoutMs, `PING ${node.id}`);
      this.markSuccess(node, entry);
    } catch (error) {
      await this.markFailure(node, entry, error);
    }
  }

  private markSuccess(node: HealthCheckableNode, entry: RedisNodeHealth): void {
    entry.lastCheckedAt = new Date().toISOString();
    entry.consecutiveFailures = 0;
    delete entry.lastError;

    if (entry.healthy) return;

    entry.healthy = true;
    log.info("Redis node recovered", { node: node.id, role: node.role });
    void this.options.onHealthy?.(node);
  }

  private async markFailure(node: HealthCheckableNode, entry: RedisNodeHealth, error: unknown): Promise<void> {
    entry.lastCheckedAt = new Date().toISOString();
    entry.consecutiveFailures += 1;
    entry.lastError = error instanceof Error ? error.message : String(error);

    if (entry.consecutiveFailures < this.options.failureThreshold) {
      log.debug("Redis node ping failed, below failure threshold", {
        node: node.id,
        failures: entry.consecutiveFailures,
        threshold: this.options.failureThreshold,
      });
      return;
    }

    // Already unhealthy — do not re-announce or reconnect on every sweep.
    if (!entry.healthy) return;

    entry.healthy = false;
    log.warn("Redis node marked unhealthy", {
      node: node.id,
      role: node.role,
      error: entry.lastError,
    });

    if (!this.options.onUnhealthy) return;

    try {
      await this.options.onUnhealthy(node, error);
    } catch (reconnectError) {
      log.error("Redis node reconnect attempt failed", {
        node: node.id,
        error: reconnectError instanceof Error ? reconnectError.message : String(reconnectError),
      });
    }
  }

  /** Begin periodic pinging. Idempotent. */
  start(): void {
    if (this.timer) return;

    this.timer = setInterval(() => {
      void this.checkNow().catch((error) => {
        log.error("Redis cluster health sweep failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, this.options.intervalMs);
    // A health timer must never be the reason the process stays alive.
    this.timer.unref?.();
  }

  /** Stop periodic pinging and clear the interval. Idempotent. */
  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** True while the interval is scheduled. */
  isRunning(): boolean {
    return this.timer !== null;
  }

  /**
   * Default reconnect action: ask ioredis to re-dial the node's socket.
   *
   * `connect()` resolves once the connection is re-established and rejects if
   * it cannot be, which the monitor treats as a failed reconnect rather than
   * propagating — a node that stays down simply remains unhealthy.
   */
  static reconnectNode(node: HealthCheckableNode): Promise<void> {
    if (typeof node.connect !== "function") {
      return Promise.resolve();
    }
    return node.connect().then(() => undefined);
  }
}