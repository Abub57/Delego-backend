/**
 * Read/write command segregation tests for `RedisClusterFailoverClient`.
 *
 * These cover the issue's acceptance criteria — reads spread across replicas,
 * writes always to masters — against a fake node pool that records which node
 * each command was executed on. A fake is necessary because the routing
 * decision is made by picking a connection, and asserting "the command ran on
 * a replica" requires observing that connection; against a live cluster the
 * same assertions would need per-node `CLIENT ID`/`INFO cmdstats` scraping.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  RedisClusterFailoverClient,
  type ClusterNodeConnection,
} from "./clusterFailover.js";
import type { RedisNodeRole } from "./types.js";

/** Fake per-node connection that records every command executed against it. */
class FakeNode implements ClusterNodeConnection {
  readonly executed: string[] = [];
  pingCount = 0;
  reconnectCount = 0;
  status: string;

  constructor(
    readonly id: string,
    readonly role: RedisNodeRole,
    options: { status?: string; failWith?: Error } = {}
  ) {
    this.status = options.status ?? "ready";
    this.failWith = options.failWith;
  }

  failWith: Error | undefined;

  async ping(): Promise<string> {
    this.pingCount += 1;
    if (this.failWith) throw this.failWith;
    return "PONG";
  }

  async connect(): Promise<unknown> {
    this.reconnectCount += 1;
    this.status = "ready";
    return null;
  }

  /** Records the command name on this node and resolves with a marker. */
  async exec<T>(command: string, result?: T): Promise<T> {
    this.executed.push(command);
    if (this.failWith) throw this.failWith;
    return (result ?? `${command}@${this.id}`) as T;
  }
}

/** A 3-shard cluster: 3 masters, one replica each. */
function buildCluster(options: { replicaStatuses?: Record<string, string> } = {}) {
  const masters = [
    new FakeNode("10.0.0.1:6379", "master"),
    new FakeNode("10.0.0.2:6379", "master"),
    new FakeNode("10.0.0.3:6379", "master"),
  ];
  const replicas = [
    new FakeNode("10.0.0.1:6380", "replica", { status: options.replicaStatuses?.r1 }),
    new FakeNode("10.0.0.2:6380", "replica", { status: options.replicaStatuses?.r2 }),
    new FakeNode("10.0.0.3:6380", "replica", { status: options.replicaStatuses?.r3 }),
  ];
  return { masters, replicas };
}

describe("RedisClusterFailoverClient — write routing", () => {
  let masters: FakeNode[];
  let replicas: FakeNode[];
  let client: RedisClusterFailoverClient<FakeNode>;

  beforeEach(() => {
    ({ masters, replicas } = buildCluster());
    client = new RedisClusterFailoverClient({
      masters,
      replicas,
      enableReadOnlyReplicas: true,
    });
  });

  it("routes every write to a master, never a replica", async () => {
    for (let i = 0; i < 9; i += 1) {
      await client.write((node) => node.exec("SET"));
    }

    for (const replica of replicas) {
      expect(replica.executed).toEqual([]);
    }

    const stats = client.getRoutingStats();
    expect(stats.masterWrites).toBe(9);
    expect(stats.replicaWrites).toBe(0);
  });

  it("spreads writes across the shard masters rather than pinning one", async () => {
    for (let i = 0; i < 9; i += 1) {
      await client.write((node) => node.exec("SET"));
    }

    const totalExecuted = masters.reduce((sum, m) => sum + m.executed.length, 0);
    expect(totalExecuted).toBe(9);
    // Round-robin over 3 masters with 9 writes means an even 3/3/3 split.
    for (const master of masters) {
      expect(master.executed.length).toBe(3);
    }
  });

  it("keeps writes on the master when a replica is ready and idle", async () => {
    // A replica that is connected and healthy must still never see a write.
    for (const replica of replicas) {
      expect(replica.status).toBe("ready");
    }

    await client.write((node) => node.exec("DEL"));

    expect(client.getRoutingStats().replicaWrites).toBe(0);
    expect(replicas.flatMap((r) => r.executed)).toEqual([]);
  });

  it("rejects the write when no master is usable", async () => {
    for (const master of masters) master.status = "end";

    await expect(client.write((node) => node.exec("SET"))).rejects.toThrow(
      /No healthy Redis master/
    );
  });

  it("skips masters the health monitor marked unhealthy", async () => {
    const unhealthy = new Set(["10.0.0.2:6379"]);
    const healthyOnly = new RedisClusterFailoverClient({
      masters,
      replicas,
      enableReadOnlyReplicas: true,
      isHealthy: (id) => !unhealthy.has(id),
    });

    for (let i = 0; i < 6; i += 1) {
      await healthyOnly.write((node) => node.exec("SET"));
    }

    expect(masters[1].executed).toEqual([]);
    expect(masters[0].executed.length).toBe(3);
    expect(masters[2].executed.length).toBe(3);
  });
});

describe("RedisClusterFailoverClient — read routing", () => {
  let masters: FakeNode[];
  let replicas: FakeNode[];
  let client: RedisClusterFailoverClient<FakeNode>;

  beforeEach(() => {
    ({ masters, replicas } = buildCluster());
    client = new RedisClusterFailoverClient({
      masters,
      replicas,
      enableReadOnlyReplicas: true,
    });
  });

  it("routes reads to replicas and never to masters", async () => {
    for (let i = 0; i < 6; i += 1) {
      await client.read((node) => node.exec("GET"));
    }

    for (const master of masters) {
      expect(master.executed).toEqual([]);
    }

    const stats = client.getRoutingStats();
    expect(stats.replicaReads).toBe(6);
    expect(stats.masterReads).toBe(0);
  });

  it("distributes read traffic evenly across every replica", async () => {
    for (let i = 0; i < 9; i += 1) {
      await client.read((node) => node.exec("GET"));
    }

    // 9 reads over 3 replicas — each replica must see an equal share,
    // otherwise one replica absorbs the load and the others sit idle.
    for (const replica of replicas) {
      expect(replica.executed.length).toBe(3);
    }

    const totalExecuted = replicas.reduce((sum, r) => sum + r.executed.length, 0);
    expect(totalExecuted).toBe(9);
  });

  it("spreads consecutive reads rather than hitting one replica repeatedly", async () => {
    const targets: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      targets.push(await client.read((node) => node.exec("GET")));
    }

    expect(new Set(targets).size).toBe(3);
    expect(targets).toEqual([
      "GET@10.0.0.1:6380",
      "GET@10.0.0.2:6380",
      "GET@10.0.0.3:6380",
      "GET@10.0.0.1:6380",
      "GET@10.0.0.2:6380",
      "GET@10.0.0.3:6380",
    ]);
  });

  it("returns the value produced by the replica it selected", async () => {
    const result = await client.read((node) => node.exec("GET"));
    expect(result).toBe("GET@10.0.0.1:6380");
  });

  it("falls back to a master when no replica is ready", async () => {
    for (const replica of replicas) replica.status = "reconnecting";

    await client.read((node) => node.exec("GET"));

    const stats = client.getRoutingStats();
    expect(stats.replicaReads).toBe(0);
    expect(stats.masterReads).toBe(1);
    expect(replicas.flatMap((r) => r.executed)).toEqual([]);
  });

  it("retries on the next replica when one errors mid-read", async () => {
    replicas[0].failWith = new Error("READONLY connection lost");

    const result = await client.read((node) => node.exec("GET"));

    expect(result).toBe("GET@10.0.0.2:6380");
    expect(client.getRoutingStats().replicaReads).toBe(1);
  });

  it("falls back to a master when every replica errors", async () => {
    for (const replica of replicas) replica.failWith = new Error("replica down");

    await client.read((node) => node.exec("GET"));

    const stats = client.getRoutingStats();
    expect(stats.replicaReads).toBe(0);
    expect(stats.masterReads).toBe(1);
  });

  it("stops routing reads to a replica the health monitor marked unhealthy", async () => {
    const unhealthy = new Set(["10.0.0.1:6380", "10.0.0.2:6380"]);
    const healthAware = new RedisClusterFailoverClient({
      masters,
      replicas,
      enableReadOnlyReplicas: true,
      isHealthy: (id) => !unhealthy.has(id),
    });

    for (let i = 0; i < 4; i += 1) {
      await healthAware.read((node) => node.exec("GET"));
    }

    expect(replicas[0].executed).toEqual([]);
    expect(replicas[1].executed).toEqual([]);
    expect(replicas[2].executed.length).toBe(4);
  });
});

describe("RedisClusterFailoverClient — read/write segregation under load", () => {
  let masters: FakeNode[];
  let replicas: FakeNode[];
  let client: RedisClusterFailoverClient<FakeNode>;

  beforeEach(() => {
    ({ masters, replicas } = buildCluster());
    client = new RedisClusterFailoverClient({
      masters,
      replicas,
      enableReadOnlyReplicas: true,
    });
  });

  it("keeps an interleaved read/write mix segregated by role", async () => {
    const reads: string[] = [];
    const writes: string[] = [];

    // Mimics the issue's motivating workload: catalog lookups and session
    // checks interleaved with the writes that invalidate them.
    for (let i = 0; i < 12; i += 1) {
      writes.push((await client.write((node) => node.exec("SET"))) as string);
      reads.push((await client.read((node) => node.exec("GET"))) as string);
    }

    for (const write of writes) {
      expect(write).toMatch(/:6379$/);
    }
    for (const read of reads) {
      expect(read).toMatch(/:6380$/);
    }

    const stats = client.getRoutingStats();
    expect(stats.masterWrites).toBe(12);
    expect(stats.replicaReads).toBe(12);
    expect(stats.masterReads).toBe(0);
    expect(stats.replicaWrites).toBe(0);
  });

  it("routes reads and writes to disjoint node sets", async () => {
    for (let i = 0; i < 6; i += 1) {
      await client.write((node) => node.exec("SET"));
      await client.read((node) => node.exec("GET"));
    }

    const readNodes = replicas.filter((r) => r.executed.length > 0).map((r) => r.id);
    const writeNodes = masters.filter((m) => m.executed.length > 0).map((m) => m.id);

    expect(readNodes.length).toBeGreaterThan(0);
    expect(writeNodes.length).toBeGreaterThan(0);
    for (const readNode of readNodes) {
      expect(writeNodes).not.toContain(readNode);
    }
  });
});

describe("RedisClusterFailoverClient — configuration", () => {
  it("sends all reads to masters when read-only replicas are disabled", async () => {
    const { masters, replicas } = buildCluster();
    const client = new RedisClusterFailoverClient({
      masters,
      replicas,
      enableReadOnlyReplicas: false,
    });

    for (let i = 0; i < 4; i += 1) {
      await client.read((node) => node.exec("GET"));
    }

    expect(replicas.flatMap((r) => r.executed)).toEqual([]);
    expect(client.getRoutingStats().masterReads).toBe(4);
  });

  it("rejects rather than reading a possibly-stale replica when fallback is off", async () => {
    const { masters, replicas } = buildCluster();
    const client = new RedisClusterFailoverClient({
      masters,
      replicas,
      enableReadOnlyReplicas: false,
      fallbackToMaster: false,
    });

    // Replicas exist but are switched off, and master fallback is disabled —
    // this is the read-after-write path opting out of replica reads entirely.
    await expect(client.read((node) => node.exec("GET"))).rejects.toThrow(
      /fallbackToMaster is disabled/
    );
  });

  it("treats a post-failover promoted replica as a write target", async () => {
    const { masters, replicas } = buildCluster();
    const client = new RedisClusterFailoverClient({
      masters,
      replicas,
      enableReadOnlyReplicas: true,
    });

    // Post-failover the promoted replica reports as a master, so writes must
    // now be able to land on it.
    const promoted = new FakeNode("10.0.0.1:6380", "master");
    const demoted = replicas.slice(1);
    client.refresh([...masters, promoted, ...demoted]);

    for (let i = 0; i < 4; i += 1) {
      await client.write((node) => node.exec("SET"));
    }

    expect(promoted.executed).toEqual(["SET"]);
    for (const node of demoted) {
      expect(node.executed).toEqual([]);
    }
    expect(client.getRoutingStats().masterWrites).toBe(4);
    expect(client.getRoutingStats().replicaWrites).toBe(0);
  });

  it("resetRoutingStats clears the counters", async () => {
    const { masters, replicas } = buildCluster();
    const client = new RedisClusterFailoverClient({
      masters,
      replicas,
      enableReadOnlyReplicas: true,
    });

    await client.read((node) => node.exec("GET"));
    await client.write((node) => node.exec("SET"));
    expect(client.getRoutingStats().replicaReads).toBe(1);

    client.resetRoutingStats();

    expect(client.getRoutingStats()).toEqual({
      replicaReads: 0,
      masterReads: 0,
      masterWrites: 0,
      replicaWrites: 0,
    });
  });

  it("reports per-node health from a direct ping when no monitor is attached", async () => {
    const { masters, replicas } = buildCluster();
    replicas[1].failWith = new Error("connection refused");

    const client = new RedisClusterFailoverClient({
      masters,
      replicas,
      enableReadOnlyReplicas: true,
    });

    const health = await client.pingAll();
    const failed = health.find((h) => h.id === "10.0.0.2:6380");

    expect(failed?.healthy).toBe(false);
    expect(failed?.lastError).toBe("connection refused");
    expect(health.filter((h) => h.healthy)).toHaveLength(5);
  });
});