/**
 * @delegolabs/cache — Redis Cluster client config with read-replica routing,
 * cache-aside helpers, tag-based invalidation, and metrics collection.
 *
 * Cluster mode provides automatic read-replica routing two ways: ioredis'
 * `scaleReads: 'slave'` on the `Cluster` instance, and an explicit
 * `RedisClusterFailoverClient` for callers needing read-after-write
 * guarantees or routing observability. See docs/deployment/redis-cluster.md
 * for the cluster topology, Sentinel failover, backup/DR, and load-testing
 * design this package's client config is built to work against — none of
 * which is deployed or verified from this repo.
 */
export type { CacheRedisClient } from "./client.js";
export {
  getCacheClient,
  clusterConfigFromEnv,
  sentinelConfigFromEnv,
  isSentinelEnabled,
  defaultRetryStrategy,
  disconnectCacheClient,
  getClusterFailoverClient,
  getClusterHealthMonitor,
  _setCacheClientForTesting,
  _resetCacheClientForTesting,
} from "./client.js";

export {
  parseNodeList,
  clusterTopologyFromEnv,
  resolveScaleReads,
  buildClusterOptions,
} from "./clusterTopology.js";

export {
  RedisClusterHealthMonitor,
  type HealthCheckableNode,
  type RedisClusterHealthMonitorOptions,
} from "./clusterHealth.js";

export {
  RedisClusterFailoverClient,
  type ClusterNodeConnection,
  type RedisClusterFailoverClientOptions,
  type RedisRoutingStats,
} from "./clusterFailover.js";

export {
  getOrSet,
  setCacheEntry,
  invalidate,
  getCacheStats,
  resetCacheStats,
  type GetOrSetOptions,
} from "./cacheAside.js";

export {
  collectClusterMetrics,
  mergeClusterMetrics,
  evaluateClusterHealth,
} from "./metrics.js";

export type {
  RedisClusterConfig,
  RedisClusterTopology,
  RedisNodeRole,
  RedisNodeHealth,
  SentinelNodeConfig,
  CacheEntry,
  CacheInvalidation,
  ClusterMetrics,
} from "./types.js";

export {
  redisLockAcquire,
  redisLockRelease,
  redisLockRenew,
  redisLockInspect,
  redisLockScan,
  workflowLockKey,
  stepLockKey,
  fenceKeyFor,
  serializeLockPayload,
  parseLockPayload,
  type RedisLockPayload,
  type RedisLockRenewResult,
} from "./lock.js";
export {
  acquireRedlock,
  releaseRedlock,
  extendRedlock,
  lockKeyForResource,
  withCartCheckoutLock,
  type RedlockOptions,
  type LockHandle,
} from "./redlock.js";
