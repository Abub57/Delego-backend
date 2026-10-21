# Redis Cluster deployment guide (Issue #69)

> **Status: design + runbook, not a live deployment.** Everything in this
> document describes how to stand up and operate the Redis Cluster the
> `@delegolabs/cache` package's client config (`packages/cache/src/client.ts`)
> is built to connect to. No cluster has been deployed, load-tested, or
> failover-tested from this repository — there is no multi-node Redis, no
> Sentinel, and no production-scale traffic generator available in this
> environment. Treat the acceptance criteria below as **targets to validate
> during actual deployment**, not results already achieved. `@delegolabs/cache`
> itself (client config, cache-aside helpers, tag invalidation, metrics
> parsing) is real, tested code — see `packages/cache/README.md`.

## 1. Topology

Six nodes, three masters / three replicas, one replica per master, spread
across at least three availability zones so that losing one AZ never drops
a master without an available replica to promote.

```text
              ┌─────────────── AZ-a ───────────────┐
              │  redis-master-1   redis-replica-3   │
              └──────────────────────────────────────┘
              ┌─────────────── AZ-b ───────────────┐
              │  redis-master-2   redis-replica-1   │
              └──────────────────────────────────────┘
              ┌─────────────── AZ-c ───────────────┐
              │  redis-master-3   redis-replica-2   │
              └──────────────────────────────────────┘
```

- Each master owns roughly 1/3 of the 16384 hash slots (`0–5460`,
  `5461–10922`, `10923–16383`).
- Replicas replicate asynchronously from their master and are promoted on
  failure by the cluster's own failure-detection gossip protocol (native
  Redis Cluster failover), independent of Sentinel.

### Redis Cluster bus + client ports

Each node needs its client port (e.g. `6379`) and cluster bus port
(client port + `10000`, e.g. `16379`) reachable between all six nodes.
Client-facing traffic only needs the client port open from application
subnets.

### `redis.conf` (per node, adjust `bind`/`cluster-announce-ip` per host)

```conf
port 6379
cluster-enabled yes
cluster-config-file nodes.conf
cluster-node-timeout 5000
cluster-announce-ip <node-private-ip>
cluster-announce-port 6379
cluster-announce-bus-port 16379
appendonly yes
appendfsync everysec
maxmemory 4gb
maxmemory-policy allkeys-lru
requirepass ${REDIS_PASSWORD}
masterauth ${REDIS_PASSWORD}
tcp-keepalive 60
```

### Cluster bring-up (once, from any one node after all six are running)

```bash
redis-cli --cluster create \
  10.0.1.10:6379 10.0.2.10:6379 10.0.3.10:6379 \
  10.0.1.11:6379 10.0.2.11:6379 10.0.3.11:6379 \
  --cluster-replicas 1 -a "$REDIS_PASSWORD"
```

## 2. Sentinel — why it's here alongside native Cluster failover

Redis Cluster already fails over masters on its own. Sentinel is layered
on top for two things Cluster doesn't give you directly in this
architecture:

1. **Session/rate-limit clients that intentionally run single-node Redis**
   (e.g. `apps/backend/gateway/src/rateLimit/redisClient.ts` today connects
   to one Redis instance, not the cluster). For any service that stays on
   a single logical Redis endpoint rather than the cluster, Sentinel gives
   that endpoint its own independent HA without adopting full Cluster
   client-side slot logic.
2. **External health/alerting integration** — Sentinel's `+switch-master`
   pub/sub event is a simpler hook for paging/alerting tooling than
   parsing Cluster gossip state.

Three Sentinel processes (quorum 2), one per AZ, monitoring the same
logical group:

```conf
# sentinel.conf
port 26379
sentinel monitor delego-cache 10.0.1.10 6379 2
sentinel auth-pass delego-cache ${REDIS_PASSWORD}
sentinel down-after-milliseconds delego-cache 5000
sentinel failover-timeout delego-cache 10000
sentinel parallel-syncs delego-cache 1
```

**Failover runbook:**

1. A Sentinel detects the monitored master is unreachable for
   `down-after-milliseconds` (5s) and marks it `sdown`.
2. Once ≥2 of 3 Sentinels agree (`odown`), Sentinel election picks a
   leader Sentinel and promotes the best replica (highest replication
   offset).
3. Sentinel reconfigures the remaining replicas to follow the new master
   and publishes `+switch-master`.
4. Application clients configured against Sentinel (not a fixed host)
   pick up the new master on their next connection/lookup.
5. **On-call action:** confirm via `redis-cli -p 26379 sentinel master
   delego-cache` that exactly one master is reported and replica count
   matches expectations; page if a split-brain (two masters) is observed.

This flow is the intended design; the "failover < 5s with zero data loss"
acceptance criterion needs to be measured against real Sentinel processes
under real traffic — `down-after-milliseconds` alone bounds detection time,
not total client-visible failover time, and has not been measured here.

## 3. Client-side cluster awareness

`packages/cache/src/client.ts`'s `getCacheClient()` uses `ioredis`'s
`Cluster` client when `clusterConfigFromEnv()` resolves more than one seed
node (from `REDIS_CLUSTER_NODES`, a comma-separated `host:port` list of a
few seed nodes — the client discovers the rest of the topology via
`CLUSTER SLOTS`). `maxRedirections` bounds how many `MOVED`/`ASK`
redirects the client follows before giving up, and `clusterRetryStrategy`
controls reconnect backoff when a node is unreachable. This has been
exercised only against `ioredis-mock` in unit tests (single-node path);
the `Cluster` code path itself has not been run against a live cluster
from this repo.

### 3.1 Read-replica routing

`buildClusterOptions()` in `packages/cache/src/clusterTopology.ts` sets
`scaleReads` from `REDIS_ENABLE_READ_ONLY_REPLICAS`: `"slave"` when replica
reads are on (the default), `"master"` when they are off. ioredis then sends
any command flagged `readonly` to a replica connection and forces every
other command to the master, so read and write traffic are segregated at the
protocol level rather than by convention at the call site.

`scaleReads` is derived from the feature flag rather than configured
separately: the two can disagree, and when they do the setting silently lies
about where reads actually go (`scaleReads: 'slave'` with no reachable
replica falls back to the master anyway).

For callers that need more than the flag-level switch,
`RedisClusterFailoverClient` in `packages/cache/src/clusterFailover.ts`
(`getClusterFailoverClient()`) provides explicit segregation:

- `read()` walks the replica pool round-robin, retrying the next replica if
  one errors mid-command, and falls back to a master when none are usable.
- `write()` only ever selects from the master pool, round-robining across
  shards.
- `fallbackToMaster: false` opts a read out of replica reads entirely. Use
  it for read-after-write paths — a session check issued immediately after a
  write can otherwise read the pre-write value off a lagging replica.
- `getRoutingStats()` reports `replicaReads` / `masterReads` /
  `masterWrites` / `replicaWrites`. `replicaWrites` is always 0; it exists so
  a routing regression is detectable rather than silently invisible.

### 3.2 Health checking and reconnection

`RedisClusterHealthMonitor` (`packages/cache/src/clusterHealth.ts`) pings
every master and replica on `REDIS_HEALTH_CHECK_INTERVAL_MS`, marks a node
unhealthy after `REDIS_HEALTH_CHECK_FAILURE_THRESHOLD` consecutive failures,
and triggers one reconnect on the healthy → unhealthy transition.
`RedisClusterFailoverClient` consults that health state, so a replica that
has failed its check stops attracting reads instead of accumulating
timeouts. The monitor's timer is `unref`'d, so it never keeps the process
alive, and `ping` failures are always bounded by
`REDIS_HEALTH_CHECK_TIMEOUT_MS` so a hung node cannot stall a sweep.

Two ioredis options in `buildClusterOptions()` complete the failover story:

- `clusterNodeRetryStrategy` — ioredis defaults this to `null`, meaning node
  connections do **not** reconnect on their own and the client relies purely
  on `MOVED` errors to notice a node returning. A replica that restarts
  without changing slot ownership (the common case) would stay unusable
  until something happened to refresh the slot map. Setting this makes every
  node back off and reconnect like a standalone client.
- `enableReadyCheck` + `slotsRefreshInterval` — hold commands until
  `CLUSTER INFO` reports the cluster is ready, and keep the slot map fresh so
  post-failover role changes are picked up promptly.

Master *promotion* is Redis' own job and reaches the client as a changed
`CLUSTER SLOTS` map; neither the client nor the monitor performs failover.

Environment variables consumed by `clusterConfigFromEnv()`:

| Variable | Default | Purpose |
|---|---|---|
| `REDIS_CLUSTER_NODES` | `localhost:6379` | Comma-separated seed nodes |
| `REDIS_CLUSTER_REPLICA_NODES` | _(unset)_ | Comma-separated replica seeds (reporting only) |
| `REDIS_ENABLE_READ_ONLY_REPLICAS` | `true` | `false` → `scaleReads: 'master'` |
| `REDIS_MAX_REDIRECTIONS` | `16` | MOVED/ASK redirects before failing |
| `REDIS_ENABLE_OFFLINE_QUEUE` | `true` | Queue commands while reconnecting |
| `REDIS_CONNECT_TIMEOUT_MS` | `10000` | Per-node connect timeout |
| `REDIS_COMMAND_TIMEOUT_MS` | `5000` | Per-command timeout |
| `REDIS_HEALTH_CHECK_INTERVAL_MS` | `5000` | Health-check ping interval |
| `REDIS_HEALTH_CHECK_TIMEOUT_MS` | `2000` | Per-ping timeout |
| `REDIS_HEALTH_CHECK_FAILURE_THRESHOLD` | `3` | Failures before unhealthy |
| `REDIS_SLOTS_REFRESH_INTERVAL_MS` | `5000` | `CLUSTER SLOTS` refresh interval |
| `REDIS_PASSWORD` | _(unset)_ | `AUTH` password for every node |

Read/write segregation is covered by unit tests in
`packages/cache/src/clusterFailover.test.ts` (routing counts against a fake
node pool) and `packages/cache/src/clientCluster.test.ts` (the options the
`Cluster` instance is actually constructed with). Neither exercises a live
cluster.

## 4. Cache warming

Recommended approach for services that would otherwise start cold after a
deploy or failover:

1. On service startup, before accepting traffic, run a warm-up pass over
   the highest-traffic keys for that service (e.g. active user sessions,
   top-N product listings) using `setCacheEntry` directly rather than
   waiting for organic `getOrSet` misses.
2. Rate-limit the warm-up pass (e.g. batches of 100 keys with a small
   delay) so it doesn't itself spike load on the source-of-truth database
   right after a restart.
3. Track warm-up completion via the service's existing `/health` readiness
   check (see `packages/utils/src/health/`) so orchestration (k8s readiness
   probe) doesn't route traffic until warming finishes.

This is a pattern description, not a shipped warming job — no service in
this repo currently calls it, since wiring it into a specific service's
startup sequence is a per-service decision outside this PR's scope.

## 5. Monitoring, memory, and hit ratio

`packages/cache/src/metrics.ts`'s `collectClusterMetrics()` parses `INFO`
output (`used_memory`, `maxmemory`, `connected_clients`, `keyspace_hits`,
`keyspace_misses`) and measures `PING` round-trip as a latency proxy.
`evaluateClusterHealth()` flags the two thresholds from the issue's
acceptance criteria (hit ratio < 95%, per-node memory ≥ 80%).

For a real cluster, call `collectClusterMetrics()` once per node (pointing
a client at each node directly, since `CLUSTER` mode round-robins) and
merge with `mergeClusterMetrics()`. Wire the result into whatever metrics
backend the org standardizes on (Prometheus via a scrape endpoint,
StatsD, etc.) — this repo doesn't have an existing metrics pipeline to
plug into today (see `packages/utils/src/health/metrics.ts` for the
closest existing convention, which is a health-check text format, not a
Prometheus exporter).

Suggested alert thresholds, mirroring the acceptance criteria:

| Metric | Warning | Critical |
|---|---|---|
| Hit ratio | < 95% | < 85% |
| Memory used / node | ≥ 80% | ≥ 90% |
| `latencyP99Ms` | > 10ms | > 50ms |
| Connected clients / node | > 5000 | > 8000 |

## 6. Backup and disaster recovery

**Backup:**

- Enable AOF (`appendonly yes`, `appendfsync everysec`) on every node —
  already in the `redis.conf` above — as the primary durability mechanism.
- Nightly RDB snapshot (`BGSAVE`) on one replica per master (never on the
  master itself, to avoid the fork-time latency spike on the write path),
  shipped to object storage (S3 or equivalent) with a 30-day retention.
- Snapshot naming: `redis-backup/<cluster-name>/<node-id>/<date>.rdb`.

**Restore runbook (full cluster loss):**

1. Provision 6 fresh nodes with the `redis.conf` above (same
   `cluster-config-file` path).
2. For each master's most recent RDB snapshot, copy it to that node's
   data directory as `dump.rdb` before starting `redis-server`.
3. Start all 6 nodes; each master loads its RDB on boot.
4. Re-run `redis-cli --cluster create` with `--cluster-replicas 1` using
   the restored masters plus fresh (empty) replicas — replicas rebuild via
   full resync from their master.
5. Validate with `redis-cli --cluster check <any-node>:6379` — expect
   "All 16384 slots covered" and no fix warnings.
6. Resume traffic; expect a cold-cache period until `getOrSet` repopulates
   or a warm-up pass (§4) runs.

**Restore runbook (single node loss, cluster otherwise healthy):**

1. Provision a replacement node with the same `redis.conf`.
2. `redis-cli --cluster add-node <new-node>:6379 <existing-node>:6379
   --cluster-slave --cluster-master-id <id-of-the-node-being-replaced-or-its-surviving-peer>`.
3. Confirm resync completes (`INFO replication` shows `master_link_status:up`
   on the new node).

**"Backup/restore tested monthly" (acceptance criterion):** this needs a
recurring game-day exercise against real infrastructure (e.g. a scheduled
job that restores the latest snapshot into a scratch cluster and runs
`--cluster check` + a smoke-test read/write) — set up as an operational
process once real infrastructure exists, not something this PR can
schedule or verify.

## 7. Load and failover testing (not performed here)

The issue's "100k ops/sec" and "failover < 5s with zero data loss" are
acceptance criteria that require:

- A real 6-node cluster under realistic network conditions (not a
  single-machine sandbox).
- A load generator (e.g. `redis-benchmark -c 200 --cluster` or
  `memtier_benchmark`) driving representative key sizes and read/write
  mix from multiple client hosts.
- A controlled failure injection (kill `-9` a master process) during the
  load test, with client-observed error/latency logged to measure
  actual failover impact.

None of this has been run. `packages/cache`'s test suite (28 tests) covers
the cache-aside/invalidation/metrics *logic* against `ioredis-mock`, which
proves correctness of that logic but says nothing about cluster-scale
throughput or failover behavior.
