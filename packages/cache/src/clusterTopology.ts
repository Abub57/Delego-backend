/**
 * Redis Cluster topology + `ioredis` `Cluster` option construction.
 *
 * Two independent mechanisms provide read-replica routing, and both are
 * configured here so they cannot drift apart:
 *
 * 1. `scaleReads` (this module). Passed straight through to ioredis, which
 *    then sends any command flagged `readonly` to a replica connection and
 *    forces everything else to the master. This is the mechanism named by
 *    the issue and is the one that applies to *all* traffic through the
 *    `Cluster` instance, including cache-aside helpers.
 * 2. `RedisClusterFailoverClient` (./clusterFailover.js). An explicit
 *    routing layer for callers that need to pin reads to a replica and
 *    writes to a master themselves (e.g. to avoid replica read-after-write
 *    staleness), and to observe routing counts.
 *
 * `scaleReads` is derived from `enableReadOnlyReplicas` rather than being
 * configured independently, because the two can disagree and a mismatch is
 * always a bug — e.g. `scaleReads: 'slave'` with no reachable replica makes
 * ioredis fall back to the master anyway, so the setting would silently lie
 * about where reads are going.
 */
import type { ClusterOptions } from "ioredis";
import type { RedisClusterConfig, RedisClusterTopology } from "./types.js";

/**
 * Parse a comma-separated `host:port` list into normalized `host:port`
 * strings.
 *
 * Entries are trimmed, defaulted to port 6379 when omitted, deduplicated,
 * and malformed/empty entries are dropped rather than producing a node the
 * client would fail to connect to.
 */
export function parseNodeList(raw: string | undefined | null): string[] {
  if (!raw) return [];

  const seen = new Set<string>();
  const nodes: string[] = [];

  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;

    const separator = trimmed.lastIndexOf(":");
    const host = separator === -1 ? trimmed : trimmed.slice(0, separator);
    const portRaw = separator === -1 ? "6379" : trimmed.slice(separator + 1);

    if (host.length === 0) continue;
    const port = Number(portRaw);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) continue;

    const id = `${host}:${port}`;
    if (seen.has(id)) continue;
    seen.add(id);
    nodes.push(id);
  }

  return nodes;
}

/**
 * Build the configured cluster topology from the environment.
 *
 * - `REDIS_CLUSTER_NODES` — comma-separated master/seed nodes.
 * - `REDIS_CLUSTER_REPLICA_NODES` — comma-separated read-replica nodes.
 * - `REDIS_ENABLE_READ_ONLY_REPLICAS` — `"false"` disables replica reads.
 */
export function clusterTopologyFromEnv(env: NodeJS.ProcessEnv = process.env): RedisClusterTopology {
  return {
    masters: parseNodeList(env.REDIS_CLUSTER_NODES),
    replicas: parseNodeList(env.REDIS_CLUSTER_REPLICA_NODES),
    enableReadOnlyReplicas: env.REDIS_ENABLE_READ_ONLY_REPLICAS !== "false",
  };
}

/**
 * Resolve ioredis's `scaleReads` role from `enableReadOnlyReplicas`.
 *
 * Returns the literal `"slave"` when replica reads are on — the value named
 * by the issue — and `"master"` when they are off, so writes and reads both
 * go to the master.
 */
export function resolveScaleReads(enableReadOnlyReplicas: boolean): "slave" | "master" {
  return enableReadOnlyReplicas ? "slave" : "master";
}

/**
 * Build the ioredis `ClusterOptions` for a `RedisClusterConfig`.
 *
 * Beyond the cluster-mode basics this wires the two pieces of failover
 * behaviour the issue asks for:
 *
 * - `clusterNodeRetryStrategy` — ioredis defaults this to `null`, meaning
 *   cluster nodes do **not** reconnect on their own and the client relies
 *   entirely on `MOVED` errors to notice a node returning. A replica that
 *   restarts without changing slot ownership (the common case) would stay
 *   unusable until a slot refresh happened to fix it. Setting this makes
 *   every node back off and reconnect like a standalone client.
 * - `enableReadyCheck` + `slotsRefreshInterval` — hold commands until
 *   `CLUSTER INFO` reports the cluster is ready, and keep the slot map fresh
 *   so post-failover role changes are picked up promptly.
 */
export function buildClusterOptions(config: RedisClusterConfig): ClusterOptions {
  const options: ClusterOptions = {
    scaleReads: resolveScaleReads(config.enableReadOnlyReplicas),
    maxRedirections: config.maxRedirections,
    enableOfflineQueue: config.enableOfflineQueue,
    enableReadyCheck: true,
    slotsRefreshInterval: config.slotsRefreshIntervalMs,
    redisOptions: {
      connectTimeout: config.connectTimeout,
      commandTimeout: config.commandTimeout,
      ...(config.password ? { password: config.password } : {}),
    },
  };

  // ioredis treats a `null` return as "stop retrying"; the config's retry
  // strategy always returns a number, so this never disables reconnection.
  options.clusterNodeRetryStrategy = config.retryStrategy;
  options.clusterRetryStrategy = config.retryStrategy;

  return options;
}