/**
 * `RedisClusterFailoverClient` — explicit read/write command segregation on
 * top of a Redis Cluster connection pool.
 *
 * ioredis' `scaleReads: 'slave'` (configured in ./clusterTopology.js) already
 * splits traffic by command flag, and it is the right default. This class
 * exists for the cases that option cannot express:
 *
 * - **Read-after-write correctness.** A replica can lag behind the master by
 *   milliseconds. A session check or catalog lookup issued immediately after
 *   a write may read the pre-write value off a replica. Callers that must not
 *   tolerate that can pass `fallbackToMaster: false` and opt into master reads.
 * - **Health-aware selection.** `scaleReads` picks from every replica
 *   connection ioredis holds, including ones that are mid-reconnect. This
 *   class skips replicas the health monitor has marked unhealthy.
 * - **Observability.** Routing counts make segregation measurable, which is
 *   what the issue's acceptance criteria are stated in terms of.
 *
 * Writes never go to a replica under any option — `write()` only ever selects
 * from the master pool, and the routing counters make that auditable.
 */
import { createLogger } from "@delegolabs/utils";
import type { RedisNodeHealth, RedisNodeRole } from "./types.js";

const log = createLogger("cache:cluster-failover", process.env.LOG_LEVEL ?? "info");

/** The subset of an ioredis per-node connection this client requires. */
export interface ClusterNodeConnection {
  /** `host:port` identity of the node. */
  id: string;
  role: RedisNodeRole;
  /** ioredis connection status: `"ready"`, `"connecting"`, `"reconnecting"`, `"end"`, ... */
  readonly status: string;
  ping(): Promise<string>;
  connect?(): Promise<unknown>;
}

/** Routing counters — the observable proof of read/write segregation. */
export interface RedisRoutingStats {
  /** Reads served by a replica (replica read scaling working). */
  replicaReads: number;
  /** Reads that fell back to a master (no healthy replica, or staleness opted into). */
  masterReads: number;
  /** Writes sent to a master. */
  masterWrites: number;
  /**
   * Writes sent to a replica. Always 0 — this exists so a routing regression
   * is detectable rather than silently invisible.
   */
  replicaWrites: number;
}

export interface RedisClusterFailoverClientOptions<TNode extends ClusterNodeConnection> {
  masters: TNode[];
  replicas: TNode[];
  /** When false, all reads go to masters and the replica pool is ignored. */
  enableReadOnlyReplicas: boolean;
  /**
   * Allow a read to fall back to a master when no replica is usable.
   * Defaults to true (matching ioredis' own `scaleReads` behaviour). Set false
   * for read-after-write paths that must not observe replica lag.
   */
  fallbackToMaster?: boolean;
  /** Consult the health monitor so unhealthy replicas stop taking reads. */
  isHealthy?: (id: string) => boolean;
}

export class RedisClusterFailoverClient<TNode extends ClusterNodeConnection> {
  private readonly enableReadOnlyReplicas: boolean;
  private readonly fallbackToMaster: boolean;
  private readonly isHealthy: (id: string) => boolean;
  private masters: TNode[];
  private replicas: TNode[];
  private readonly stats: RedisRoutingStats = {
    replicaReads: 0,
    masterReads: 0,
    masterWrites: 0,
    replicaWrites: 0,
  };
  private readCursor = 0;
  private writeCursor = 0;
  /** Replica ids already tried during the current read, to avoid retry loops. */
  private attemptedReplicas = new Set<string>();

  constructor(options: RedisClusterFailoverClientOptions<TNode>) {
    this.masters = [...options.masters];
    this.replicas = [...options.replicas];
    this.enableReadOnlyReplicas = options.enableReadOnlyReplicas;
    this.fallbackToMaster = options.fallbackToMaster ?? true;
    this.isHealthy = options.isHealthy ?? (() => true);
  }

  /** Swap in a refreshed node list, e.g. after a `CLUSTER SLOTS` update. */
  refresh(nodes: TNode[]): void {
    this.masters = nodes.filter((n) => n.role === "master");
    this.replicas = nodes.filter((n) => n.role === "replica");
    this.readCursor = 0;
    this.writeCursor = 0;
  }

  /** Every node currently in the pool. */
  nodes(): TNode[] {
    return [...this.masters, ...this.replicas];
  }

  /** Routing counters. */
  getRoutingStats(): RedisRoutingStats {
    return { ...this.stats };
  }

  /** Reset routing counters. */
  resetRoutingStats(): void {
    this.stats.replicaReads = 0;
    this.stats.masterReads = 0;
    this.stats.masterWrites = 0;
    this.stats.replicaWrites = 0;
  }

  /**
   * Replicas eligible to serve a read: connected, not marked unhealthy, and
   * excluded when replica reads are switched off.
   */
  private availableReplicas(): TNode[] {
    if (!this.enableReadOnlyReplicas) return [];
    return this.replicas.filter((n) => n.status === "ready" && this.isHealthy(n.id));
  }

  /** Masters eligible to serve a write. */
  private availableMasters(): TNode[] {
    return this.masters.filter((n) => n.status === "ready" && this.isHealthy(n.id));
  }

  /**
   * Pick the next master, starting at `from` and wrapping. Returns `null` when
   * no master is usable.
   */
  private nextMaster(from: number): TNode | null {
    const candidates = this.availableMasters();
    if (candidates.length === 0) return null;
    return candidates[from % candidates.length];
  }

  /**
   * Pick the next replica, starting at `from` and wrapping, skipping any
   * already tried by the in-flight read. Returns `null` when no replica is
   * usable.
   */
  private nextReplica(from: number): TNode | null {
    const candidates = this.availableReplicas();
    if (candidates.length === 0) return null;

    for (let offset = 0; offset < candidates.length; offset += 1) {
      const candidate = candidates[(from + offset) % candidates.length];
      if (!this.attemptedReplicas.has(candidate.id)) return candidate;
    }
    return null;
  }

  /**
   * Execute a read-only command on a replica.
   *
   * Walks the replica pool round-robin so read traffic is spread across every
   * healthy replica. If a replica errors mid-command the next one is tried; if
   * all are exhausted, falls back to a master when `fallbackToMaster` is set
   * (the default) and otherwise rejects — which is the read-after-write
   * guarantee.
   */
  async read<T>(execute: (node: TNode) => Promise<T>): Promise<T> {
    this.attemptedReplicas = new Set<string>();

    if (this.enableReadOnlyReplicas) {
      let replica = this.nextReplica(this.readCursor);
      while (replica) {
        this.attemptedReplicas.add(replica.id);
        try {
          const result = await execute(replica);
          this.readCursor += 1;
          this.stats.replicaReads += 1;
          return result;
        } catch (error) {
          log.warn("Replica read failed, trying next replica", {
            node: replica.id,
            error: error instanceof Error ? error.message : String(error),
          });
          replica = this.nextReplica(this.readCursor);
        }
      }
    }

    if (!this.fallbackToMaster) {
      throw new Error("No healthy read replica available and fallbackToMaster is disabled");
    }

    const master = this.nextMaster(this.writeCursor);
    if (!master) {
      throw new Error("No healthy Redis master available for read fallback");
    }

    this.writeCursor += 1;
    this.stats.masterReads += 1;
    return execute(master);
  }

  /**
   * Execute a write command. Always targets a master — the replica pool is
   * never consulted — round-robining across the available masters so writes
   * spread over the shards.
   */
  async write<T>(execute: (node: TNode) => Promise<T>): Promise<T> {
    const master = this.nextMaster(this.writeCursor);
    if (!master) {
      throw new Error("No healthy Redis master available for write");
    }

    this.writeCursor += 1;
    this.stats.masterWrites += 1;
    return execute(master);
  }

  /**
   * Convenience `PING` over every node, reporting per-node health. Delegates
   * to the health monitor when one is attached, otherwise pings directly.
   */
  async pingAll(
    monitor?: { checkNow(): Promise<void>; getHealth(): RedisNodeHealth[] }
  ): Promise<RedisNodeHealth[]> {
    if (monitor) {
      await monitor.checkNow();
      return monitor.getHealth();
    }
    return Promise.all(
      this.nodes().map(async (node): Promise<RedisNodeHealth> => {
        try {
          await node.ping();
          return { id: node.id, role: node.role, healthy: true, consecutiveFailures: 0 };
        } catch (error) {
          return {
            id: node.id,
            role: node.role,
            healthy: false,
            consecutiveFailures: 1,
            lastError: error instanceof Error ? error.message : String(error),
          };
        }
      })
    );
  }
}