/**
 * Verifies the ioredis `Cluster` instance `getCacheClient` builds in cluster
 * mode is actually configured for read-replica routing, rather than only that
 * the option object looks right in isolation (see clusterTopology.test.ts).
 *
 * `ioredis` is mocked so the constructor arguments can be asserted without a
 * live multi-node cluster, which this repository has no way to stand up.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getCacheClient,
  clusterConfigFromEnv,
  getClusterFailoverClient,
  getClusterHealthMonitor,
  disconnectCacheClient,
  _resetCacheClientForTesting,
} from "./client.js";

const { clusterMock, redisMock, nodesMock, clusterListeners } = vi.hoisted(() => {
  const listeners = new Map<string, Array<(payload?: unknown) => void>>();
  return {
    clusterMock: vi.fn(),
    redisMock: vi.fn(),
    nodesMock: vi.fn((_role?: string): unknown[] => []),
    clusterListeners: listeners,
  };
});

vi.mock("ioredis", () => ({
  Cluster: class MockCluster {
    on(event: string, handler: (payload?: unknown) => void) {
      const handlers = clusterListeners.get(event) ?? [];
      handlers.push(handler);
      clusterListeners.set(event, handlers);
      return this;
    }
    quit = vi.fn(async () => "OK");
    nodes = nodesMock;
    options: Record<string, unknown> = {};
    status = "wait";
    constructor(...args: unknown[]) {
      clusterMock(...args);
    }
  },
  Redis: class MockRedis {
    quit = vi.fn(async () => "OK");
    constructor(...args: unknown[]) {
      redisMock(...args);
    }
  },
}));

const PRODUCTION_ENV = { NODE_ENV: "production" } as NodeJS.ProcessEnv;

function clusterConfig(nodes: string[], extra: NodeJS.ProcessEnv = {}) {
  return clusterConfigFromEnv({
    REDIS_CLUSTER_NODES: nodes.join(","),
    ...extra,
  } as NodeJS.ProcessEnv);
}

/** Options object passed to the mocked `Cluster` constructor. */
function clusterOptions(): Record<string, unknown> {
  const call = clusterMock.mock.calls[0];
  expect(call).toBeDefined();
  return call[1] as Record<string, unknown>;
}

/** Invoke every handler `getCacheClient` registered for a Cluster event. */
function emitClusterEvent(event: string, payload?: unknown): void {
  const handlers = clusterListeners.get(event);
  expect(handlers, `no listener registered for "${event}"`).toBeDefined();
  for (const handler of handlers!) handler(payload);
}

describe("getCacheClient — cluster mode wiring", () => {
  beforeEach(() => {
    clusterMock.mockClear();
    redisMock.mockClear();
    nodesMock.mockClear();
    nodesMock.mockReturnValue([]);
    clusterListeners.clear();
    _resetCacheClientForTesting();
  });

  afterEach(async () => {
    await disconnectCacheClient();
    _resetCacheClientForTesting();
  });

  it("constructs an ioredis Cluster with scaleReads: 'slave'", () => {
    getCacheClient(
      clusterConfig(["10.0.0.1:6379", "10.0.0.2:6379"]),
      PRODUCTION_ENV
    );

    expect(clusterMock).toHaveBeenCalledTimes(1);
    expect(redisMock).not.toHaveBeenCalled();
    expect(clusterOptions().scaleReads).toBe("slave");
  });

  it("passes the seed nodes through to the Cluster constructor", () => {
    getCacheClient(
      clusterConfig(["10.0.0.1:6379", "10.0.0.2:6379", "10.0.0.3:6379"]),
      PRODUCTION_ENV
    );

    expect(clusterMock.mock.calls[0][0]).toEqual([
      { host: "10.0.0.1", port: 6379 },
      { host: "10.0.0.2", port: 6379 },
      { host: "10.0.0.3", port: 6379 },
    ]);
  });

  it("uses scaleReads: 'master' when read-only replicas are disabled", () => {
    getCacheClient(
      clusterConfig(["10.0.0.1:6379", "10.0.0.2:6379"], {
        REDIS_ENABLE_READ_ONLY_REPLICAS: "false",
      }),
      PRODUCTION_ENV
    );

    expect(clusterOptions().scaleReads).toBe("master");
  });

  it("enables node reconnection on the Cluster", () => {
    getCacheClient(
      clusterConfig(["10.0.0.1:6379", "10.0.0.2:6379"]),
      PRODUCTION_ENV
    );

    const strategy = clusterOptions().clusterNodeRetryStrategy as (t: number) => number;
    expect(typeof strategy).toBe("function");
    expect(strategy(2)).toBe(200);
  });

  it("registers connect and error listeners on the Cluster", () => {
    getCacheClient(
      clusterConfig(["10.0.0.1:6379", "10.0.0.2:6379"]),
      PRODUCTION_ENV
    );

    // ioredis emits "error" per failed node connection; without a listener
    // Node treats it as an unhandled 'error' event and exits the process.
    expect(clusterListeners.has("error")).toBe(true);
    expect(clusterListeners.has("connect")).toBe(true);
  });

  it("defers the health monitor until ioredis has discovered nodes", () => {
    // nodesMock returns [] — a freshly constructed Cluster has not resolved
    // its slot map yet, so there is nothing to ping.
    getCacheClient(
      clusterConfig(["10.0.0.1:6379", "10.0.0.2:6379"]),
      PRODUCTION_ENV
    );

    expect(getClusterHealthMonitor()).toBeNull();
  });

  it("builds and starts the health monitor once the node pool resolves", () => {
    // Pool is empty at construction time, as it is for a fresh Cluster.
    getCacheClient(
      clusterConfig(["10.0.0.1:6379", "10.0.0.2:6379"]),
      PRODUCTION_ENV
    );

    expect(getClusterHealthMonitor()).toBeNull();

    // ioredis resolves CLUSTER SLOTS and seeds the pool, then emits "connect".
    nodesMock.mockImplementation((role) =>
      role === "master"
        ? [{ options: { host: "10.0.0.1", port: 6379 }, status: "ready", ping: async () => "PONG" }]
        : [{ options: { host: "10.0.0.1", port: 6380 }, status: "ready", ping: async () => "PONG" }]
    );
    emitClusterEvent("connect");

    const monitor = getClusterHealthMonitor();
    expect(monitor).not.toBeNull();
    expect(monitor?.isRunning()).toBe(true);
    expect(monitor?.getHealth().map((h) => `${h.role}:${h.id}`)).toEqual([
      "master:10.0.0.1:6379",
      "replica:10.0.0.1:6380",
    ]);
  });

  it("does not throw when the error event fires", () => {
    getCacheClient(
      clusterConfig(["10.0.0.1:6379", "10.0.0.2:6379"]),
      PRODUCTION_ENV
    );

    expect(() =>
      emitClusterEvent("error", new Error("READONLY You can't write against a read only replica"))
    ).not.toThrow();
  });

  it("exposes a failover client that splits masters from replicas", () => {
    nodesMock.mockImplementation((role) =>
      role === "master"
        ? [{ options: { host: "10.0.0.1", port: 6379 }, status: "ready", ping: async () => "PONG" }]
        : [{ options: { host: "10.0.0.1", port: 6380 }, status: "ready", ping: async () => "PONG" }]
    );

    getCacheClient(
      clusterConfig(["10.0.0.1:6379", "10.0.0.2:6379"]),
      PRODUCTION_ENV
    );

    const failover = getClusterFailoverClient();
    expect(failover).not.toBeNull();
    expect(failover?.nodes().map((n) => `${n.role}:${n.id}`)).toEqual([
      "master:10.0.0.1:6379",
      "replica:10.0.0.1:6380",
    ]);
  });

  it("routes reads to replicas and writes to masters on the live cluster", async () => {
    nodesMock.mockImplementation((role) =>
      role === "master"
        ? [
            { options: { host: "10.0.0.1", port: 6379 }, status: "ready", ping: async () => "PONG" },
          ]
        : [
            { options: { host: "10.0.0.1", port: 6380 }, status: "ready", ping: async () => "PONG" },
          ]
    );

    getCacheClient(
      clusterConfig(["10.0.0.1:6379", "10.0.0.2:6379"]),
      PRODUCTION_ENV
    );

    const failover = getClusterFailoverClient();
    expect(failover).not.toBeNull();

    const readTargets: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      readTargets.push(await failover!.read((node) => Promise.resolve(node.id)));
    }
    const writeTargets: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      writeTargets.push(await failover!.write((node) => Promise.resolve(node.id)));
    }

    expect(new Set(readTargets)).toEqual(new Set(["10.0.0.1:6380"]));
    expect(new Set(writeTargets)).toEqual(new Set(["10.0.0.1:6379"]));
    expect(failover!.getRoutingStats()).toEqual({
      replicaReads: 3,
      masterReads: 0,
      masterWrites: 3,
      replicaWrites: 0,
    });
  });
});

describe("getCacheClient — single-node mode", () => {
  beforeEach(() => {
    clusterMock.mockClear();
    redisMock.mockClear();
    nodesMock.mockClear();
    nodesMock.mockReturnValue([]);
    clusterListeners.clear();
    _resetCacheClientForTesting();
  });

  afterEach(async () => {
    await disconnectCacheClient();
    _resetCacheClientForTesting();
  });

  it("connects a standalone Redis client for a single node", () => {
    getCacheClient(clusterConfig(["10.0.0.1:6379"]), PRODUCTION_ENV);

    expect(redisMock).toHaveBeenCalledTimes(1);
    expect(clusterMock).not.toHaveBeenCalled();
    expect(redisMock.mock.calls[0][0]).toMatchObject({
      host: "10.0.0.1",
      port: 6379,
    });
  });

  it("has no health monitor or failover client outside cluster mode", () => {
    getCacheClient(clusterConfig(["10.0.0.1:6379"]), PRODUCTION_ENV);

    expect(getClusterHealthMonitor()).toBeNull();
    expect(getClusterFailoverClient()).toBeNull();
  });
});

describe("getCacheClient — mock mode", () => {
  beforeEach(() => {
    clusterMock.mockClear();
    redisMock.mockClear();
    nodesMock.mockClear();
    nodesMock.mockReturnValue([]);
    clusterListeners.clear();
    _resetCacheClientForTesting();
  });

  afterEach(() => {
    _resetCacheClientForTesting();
  });

  it("never constructs a real client in test env, even with cluster nodes set", () => {
    getCacheClient(clusterConfig(["10.0.0.1:6379", "10.0.0.2:6379"]), {
      NODE_ENV: "test",
    } as NodeJS.ProcessEnv);

    expect(clusterMock).not.toHaveBeenCalled();
    expect(redisMock).not.toHaveBeenCalled();
  });
});