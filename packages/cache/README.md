# @delegolabs/cache

Redis Cluster client with automatic read-replica routing, cache-aside
helpers, and tag-based invalidation for Delego backend services.

See [`docs/deployment/redis-cluster.md`](../../docs/deployment/redis-cluster.md)
for cluster topology, Sentinel failover, monitoring, and backup/DR — the
infrastructure this package's client is built to connect to, which has
not been deployed or load-tested from this repo.

```typescript
import { getCacheClient, getOrSet, invalidate } from "@delegolabs/cache";

const client = getCacheClient();

const product = await getOrSet(client, `product:${id}`, {
  ttlSeconds: 300,
  tags: ["products", `seller:${sellerId}`],
  loader: () => fetchProductFromDb(id),
});

// Evict every cached product tagged for this seller, e.g. after an update
await invalidate(client, { tags: [`seller:${sellerId}`], mode: "tag" });
```

## Read-replica routing

When `REDIS_CLUSTER_NODES` names more than one node, the client connects in
`ioredis` cluster mode with `scaleReads: 'slave'`. ioredis routes every
`readonly` command to a replica connection and forces everything else to the
master, so read and write traffic are segregated at the protocol level.
Set `REDIS_ENABLE_READ_ONLY_REPLICAS=false` to send reads to masters too.

For explicit control — and routing observability — use the failover client:

```typescript
import { getClusterFailoverClient } from "@delegolabs/cache";

const cluster = getClusterFailoverClient();

// Reads walk the replica pool round-robin; if none are usable they fall back
// to a master.
const value = await cluster.read((node) => node.get(`product:${id}`));

// Writes only ever target a master, round-robining across shards.
await cluster.write((node) => node.set(`product:${id}`, payload));

cluster.getRoutingStats();
// { replicaReads, masterReads, masterWrites, replicaWrites }
```

`replicaWrites` is always `0` — it exists so a routing regression is
detectable rather than silently invisible.

**Replica lag caveat.** A replica can lag the master by milliseconds, so a
read issued immediately after a write may observe the pre-write value. For
read-after-write paths (session checks, anything gated on a just-written
value) construct the client with `fallbackToMaster: false` to opt out of
replica reads entirely.

The client also pings every node on an interval
(`RedisClusterHealthMonitor`), marks nodes unhealthy after N consecutive
failures, and reconnects them — so a replica that has failed its check stops
attracting reads instead of accumulating timeouts.

## What's real vs. documented

- **Real, tested code:** `getCacheClient` (single-node and cluster-mode
  client construction from env), `buildClusterOptions` (`scaleReads: 'slave'`
  wiring), `RedisClusterFailoverClient` (read/write segregation, replica
  balancing, routing counters), `RedisClusterHealthMonitor` (ping sweeps,
  failure thresholding, reconnection), `getOrSet`/`setCacheEntry`
  (cache-aside pattern), `invalidate` (exact/prefix/tag eviction),
  `redisLockAcquire`/`redisLockRelease`/`redisLockRenew` (SET NX PX + Lua),
  and `collectClusterMetrics`/`evaluateClusterHealth` (metrics parsing +
  threshold checks). All covered by unit tests
  (`pnpm --filter @delegolabs/cache test`).
- **Documented, not deployed:** the actual 6-node cluster, Sentinel
  failover, cache warming automation, and backup/DR — see the deployment
  guide linked above. No live Redis Cluster was available to deploy or
  test against in this environment. Read/write segregation is asserted
  against a fake node pool and against the constructed `Cluster` options,
  not against real cluster traffic.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `REDIS_CLUSTER_NODES` | `localhost:6379` | Comma-separated `host:port` seed list; >1 entry enables cluster mode |
| `REDIS_CLUSTER_REPLICA_NODES` | _(unset)_ | Comma-separated replica seeds (reporting only) |
| `REDIS_ENABLE_READ_ONLY_REPLICAS` | `true` | `false` → `scaleReads: 'master'` |
| `REDIS_MAX_REDIRECTIONS` | `16` | MOVED/ASK redirects before failing |
| `REDIS_ENABLE_OFFLINE_QUEUE` | `true` | Queue commands while reconnecting |
| `REDIS_CONNECT_TIMEOUT_MS` | `10000` | Per-node connect timeout |
| `REDIS_COMMAND_TIMEOUT_MS` | `5000` | Per-command timeout |
| `REDIS_HEALTH_CHECK_INTERVAL_MS` | `5000` | Health-check ping interval |
| `REDIS_HEALTH_CHECK_TIMEOUT_MS` | `2000` | Per-ping timeout |
| `REDIS_HEALTH_CHECK_FAILURE_THRESHOLD` | `3` | Consecutive failures before a node is unhealthy |
| `REDIS_SLOTS_REFRESH_INTERVAL_MS` | `5000` | `CLUSTER SLOTS` refresh interval |
| `REDIS_PASSWORD` | _(unset)_ | `AUTH` password applied to every node |
| `MOCK_REDIS` / `NODE_ENV=test` / `CI=true` | — | Use an in-memory mock client instead of connecting |
