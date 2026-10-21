/**
 * Shared types for Redis Cluster caching (Issue #69).
 *
 * These mirror the data types specified in the issue so downstream
 * services can share one canonical shape for cache entries, invalidation
 * requests, cluster configuration, and metrics snapshots.
 */

/** Client-side configuration for connecting to a Redis Cluster. */
export interface RedisClusterConfig {
  nodes: Array<{ host: string; port: number }>;
  maxRedirections: number;
  retryStrategy: (times: number) => number;
  enableOfflineQueue: boolean;
  connectTimeout: number;
  commandTimeout: number;
  /**
   * When true, read-only commands are scaled across read replicas instead of
   * being served by the master. Drives `scaleReads` in the ioredis `Cluster`
   * options — see `resolveScaleReads` in ./clusterTopology.js.
   */
  enableReadOnlyReplicas: boolean;
  /** Interval between automatic per-node health-check pings. */
  healthCheckIntervalMs: number;
  /** Per-ping timeout before a node is considered unreachable. */
  healthCheckTimeoutMs: number;
  /** Consecutive failed pings before a node is marked unhealthy. */
  healthCheckFailureThreshold: number;
  /** How often ioredis refreshes its slot map via `CLUSTER SLOTS`. */
  slotsRefreshIntervalMs: number;
  /** Optional `AUTH` password applied to every node connection. */
  password?: string;
}

/**
 * The cluster topology a client is configured against, as declared by the
 * environment. ioredis discovers the *live* topology (and failover-driven
 * master/replica promotion) itself via `CLUSTER SLOTS`; these lists are the
 * configured seed points plus the replicas operators expect read traffic on.
 */
export interface RedisClusterTopology {
  /** Seed/primary nodes as `host:port`, comma-separated in the environment. */
  masters: string[];
  /** Read-replica seed nodes as `host:port`. */
  replicas: string[];
  /** Whether read-only commands should be routed to the replicas above. */
  enableReadOnlyReplicas: boolean;
}

/** Role of a single cluster node, as used for routing and health reporting. */
export type RedisNodeRole = "master" | "replica";

/** Health-check state tracked for one cluster node. */
export interface RedisNodeHealth {
  /** `host:port` identity of the node. */
  id: string;
  role: RedisNodeRole;
  healthy: boolean;
  consecutiveFailures: number;
  lastError?: string;
  lastCheckedAt?: string;
}

/**
 * Sentinel topology for HA Redis (#401).
 *
 * Mirrors the data type from the issue so downstream services share one
 * canonical shape for Sentinel auto-discovery configuration.
 */
export interface SentinelNodeConfig {
  sentinels: Array<{ host: string; port: number }>;
  masterName: string;
  role: "master" | "slave";
  /** Optional password applied to both Sentinel and data-node connections. */
  password?: string;
  /** Optional username for ACL-enabled Redis (Redis 6+). */
  username?: string;
  /** Sentinel connection timeout in ms. */
  sentinelTimeoutMs?: number;
  /** How long to wait for a master to be discovered before failing. */
  maxDiscoveryWaitMs?: number;
}

/** A single cached value plus the metadata needed for invalidation and observability. */
export interface CacheEntry<T> {
  key: string;
  value: T;
  tags: string[];
  ttlSeconds: number;
  createdAt: string;
  hits: number;
}

/** A request to invalidate one or more cache entries. */
export interface CacheInvalidation {
  tags: string[];
  pattern?: string;
  mode: "exact" | "prefix" | "tag";
}

/** A point-in-time snapshot of cluster health and cache effectiveness. */
export interface ClusterMetrics {
  nodes: Array<{
    id: string;
    role: "master" | "replica";
    memoryUsed: number;
    memoryTotal: number;
    connectedClients: number;
    keyspaceHits: number;
    keyspaceMisses: number;
    latencyP99Ms: number;
  }>;
  totalKeys: number;
  hitRatio: number;
}
