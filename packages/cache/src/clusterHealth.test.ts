import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  RedisClusterHealthMonitor,
  type HealthCheckableNode,
} from "./clusterHealth.js";
import type { RedisNodeRole } from "./types.js";

/** Fake node whose ping outcome and reconnect behaviour are scriptable. */
class FakeNode implements HealthCheckableNode {
  pingCount = 0;
  connectCount = 0;
  pingShouldFail = false;
  pingDelayMs = 0;

  constructor(
    readonly id: string,
    readonly role: RedisNodeRole
  ) {}

  async ping(): Promise<string> {
    this.pingCount += 1;
    if (this.pingDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.pingDelayMs));
    }
    if (this.pingShouldFail) throw new Error(`ping failed: ${this.id}`);
    return "PONG";
  }

  async connect(): Promise<unknown> {
    this.connectCount += 1;
    return null;
  }
}

function buildNodes(): FakeNode[] {
  return [
    new FakeNode("10.0.0.1:6379", "master"),
    new FakeNode("10.0.0.1:6380", "replica"),
    new FakeNode("10.0.0.2:6379", "master"),
    new FakeNode("10.0.0.2:6380", "replica"),
  ];
}

function buildMonitor(
  nodes: FakeNode[],
  overrides: Partial<ConstructorParameters<typeof RedisClusterHealthMonitor>[0]> = {}
) {
  const onUnhealthy = vi.fn();
  const onHealthy = vi.fn();
  const monitor = new RedisClusterHealthMonitor({
    nodes,
    intervalMs: 5,
    pingTimeoutMs: 50,
    failureThreshold: 2,
    onUnhealthy,
    onHealthy,
    ...overrides,
  });
  return { monitor, onUnhealthy, onHealthy };
}

describe("RedisClusterHealthMonitor — construction", () => {
  it("requires at least one node", () => {
    expect(() => buildMonitor([])).toThrow(/at least one node/);
  });

  it("rejects a failure threshold below 1", () => {
    expect(() => buildMonitor(buildNodes(), { failureThreshold: 0 })).toThrow(
      /failureThreshold must be >= 1/
    );
  });

  it("starts every node healthy so replicas take reads immediately", () => {
    const { monitor } = buildMonitor(buildNodes());

    expect(monitor.getHealth().every((h) => h.healthy)).toBe(true);
    expect(monitor.isHealthy("10.0.0.1:6380")).toBe(true);
  });

  it("reports an unmonitored node as not healthy", () => {
    const { monitor } = buildMonitor(buildNodes());
    expect(monitor.isHealthy("10.0.9.9:6379")).toBe(false);
    expect(monitor.getNodeHealth("10.0.9.9:6379")).toBeUndefined();
  });
});

describe("RedisClusterHealthMonitor — pings", () => {
  let nodes: FakeNode[];

  beforeEach(() => {
    nodes = buildNodes();
  });

  it("pings every master and replica on a sweep", async () => {
    const { monitor } = buildMonitor(nodes);
    await monitor.checkNow();

    for (const node of nodes) {
      expect(node.pingCount).toBe(1);
    }
  });

  it("stays healthy when every node answers", async () => {
    const { monitor, onUnhealthy } = buildMonitor(nodes);
    await monitor.checkNow();
    await monitor.checkNow();

    expect(monitor.getHealth().every((h) => h.healthy)).toBe(true);
    expect(onUnhealthy).not.toHaveBeenCalled();
  });

  it("marks a node unhealthy only after the failure threshold is reached", async () => {
    const failing = nodes[1];
    failing.pingShouldFail = true;

    const { monitor, onUnhealthy } = buildMonitor(nodes, { failureThreshold: 3 });

    await monitor.checkNow();
    expect(monitor.isHealthy(failing.id)).toBe(true);

    await monitor.checkNow();
    expect(monitor.isHealthy(failing.id)).toBe(true);
    expect(monitor.getNodeHealth(failing.id)?.consecutiveFailures).toBe(2);

    await monitor.checkNow();
    expect(monitor.isHealthy(failing.id)).toBe(false);
    expect(monitor.getNodeHealth(failing.id)?.consecutiveFailures).toBe(3);
    expect(onUnhealthy).toHaveBeenCalledTimes(1);
  });

  it("records the failure reason on the node health entry", async () => {
    const failing = nodes[1];
    failing.pingShouldFail = true;

    const { monitor } = buildMonitor(nodes, { failureThreshold: 1 });
    await monitor.checkNow();

    const health = monitor.getNodeHealth(failing.id);
    expect(health?.lastError).toBe(`ping failed: ${failing.id}`);
    expect(health?.lastCheckedAt).toBeDefined();
  });

  it("recovers a node once pings succeed again", async () => {
    const flaky = nodes[1];
    flaky.pingShouldFail = true;

    const { monitor, onHealthy } = buildMonitor(nodes, { failureThreshold: 1 });
    await monitor.checkNow();
    expect(monitor.isHealthy(flaky.id)).toBe(false);

    flaky.pingShouldFail = false;
    await monitor.checkNow();

    expect(monitor.isHealthy(flaky.id)).toBe(true);
    expect(monitor.getNodeHealth(flaky.id)?.consecutiveFailures).toBe(0);
    expect(monitor.getNodeHealth(flaky.id)?.lastError).toBeUndefined();
    expect(onHealthy).toHaveBeenCalledTimes(1);
  });

  it("does not re-announce or reconnect an already-unhealthy node", async () => {
    const failing = nodes[1];
    failing.pingShouldFail = true;

    const { monitor, onUnhealthy, onHealthy } = buildMonitor(nodes, {
      failureThreshold: 1,
    });

    await monitor.checkNow();
    await monitor.checkNow();
    await monitor.checkNow();

    expect(onUnhealthy).toHaveBeenCalledTimes(1);
    expect(onHealthy).not.toHaveBeenCalled();
    expect(monitor.getNodeHealth(failing.id)?.consecutiveFailures).toBe(3);
  });

  it("treats a ping that exceeds the timeout as a failure", async () => {
    const slow = nodes[1];
    slow.pingDelayMs = 200;

    const { monitor, onUnhealthy } = buildMonitor(nodes, {
      pingTimeoutMs: 10,
      failureThreshold: 1,
    });

    await monitor.checkNow();

    expect(monitor.isHealthy(slow.id)).toBe(false);
    expect(monitor.getNodeHealth(slow.id)?.lastError).toMatch(/timed out after 10ms/);
    expect(onUnhealthy).toHaveBeenCalledTimes(1);
  });

  it("does not let a slow node block the sweep from pinging the others", async () => {
    const slow = nodes[0];
    slow.pingDelayMs = 100;

    const { monitor } = buildMonitor(nodes, { pingTimeoutMs: 10 });

    await monitor.checkNow();

    // Every other node must still have been pinged despite the slow one.
    expect(nodes[1].pingCount).toBe(1);
    expect(nodes[2].pingCount).toBe(1);
    expect(nodes[3].pingCount).toBe(1);
  });

  it("collapses overlapping sweeps onto the in-flight one", async () => {
    const slow = nodes[0];
    slow.pingDelayMs = 60;

    const { monitor } = buildMonitor(nodes, { pingTimeoutMs: 1, failureThreshold: 1 });

    await Promise.all([monitor.checkNow(), monitor.checkNow(), monitor.checkNow()]);

    expect(nodes[1].pingCount).toBe(1);
  });

  it("never rejects the sweep even when every ping fails", async () => {
    for (const node of nodes) node.pingShouldFail = true;

    const { monitor, onUnhealthy } = buildMonitor(nodes, { failureThreshold: 1 });

    await expect(monitor.checkNow()).resolves.toBeUndefined();
    expect(monitor.getHealth().every((h) => !h.healthy)).toBe(true);
    expect(onUnhealthy).toHaveBeenCalledTimes(nodes.length);
  });

  it("swallows a throwing reconnect callback so the sweep still completes", async () => {
    const failing = nodes[1];
    failing.pingShouldFail = true;

    const { monitor } = buildMonitor(nodes, {
      failureThreshold: 1,
      onUnhealthy: () => {
        throw new Error("connect refused");
      },
    });

    await expect(monitor.checkNow()).resolves.toBeUndefined();
    expect(monitor.isHealthy(failing.id)).toBe(false);
  });
});

describe("RedisClusterHealthMonitor — reconnection", () => {
  it("reconnects a node once when it goes unhealthy", async () => {
    const failing = new FakeNode("10.0.0.1:6380", "replica");
    failing.pingShouldFail = true;

    const onUnhealthy = vi.fn((node: HealthCheckableNode) =>
      RedisClusterHealthMonitor.reconnectNode(node)
    );
    const monitor = new RedisClusterHealthMonitor({
      nodes: [failing],
      intervalMs: 5,
      pingTimeoutMs: 50,
      failureThreshold: 1,
      onUnhealthy,
    });

    await monitor.checkNow();

    expect(failing.connectCount).toBe(1);
    expect(onUnhealthy).toHaveBeenCalledTimes(1);

    await monitor.checkNow();
    expect(failing.connectCount).toBe(1);
  });

  it("leaves healthy nodes alone", async () => {
    const healthy = new FakeNode("10.0.0.1:6379", "master");

    const { monitor } = buildMonitor([healthy], {
      failureThreshold: 1,
      onUnhealthy: (node) => RedisClusterHealthMonitor.reconnectNode(node),
    });

    await monitor.checkNow();

    expect(healthy.connectCount).toBe(0);
  });

  it("treats a node without connect() as already handled", async () => {
    const noConnect: HealthCheckableNode = {
      id: "10.0.0.1:6379",
      role: "master",
      ping: async () => {
        throw new Error("down");
      },
    };

    const onUnhealthy = vi.fn((node: HealthCheckableNode) =>
      RedisClusterHealthMonitor.reconnectNode(node)
    );
    const monitor = new RedisClusterHealthMonitor({
      nodes: [noConnect],
      intervalMs: 5,
      pingTimeoutMs: 50,
      failureThreshold: 1,
      onUnhealthy,
    });

    await expect(monitor.checkNow()).resolves.toBeUndefined();
    expect(onUnhealthy).toHaveBeenCalledTimes(1);
    expect(monitor.isHealthy("10.0.0.1:6379")).toBe(false);
  });
});

describe("RedisClusterHealthMonitor — topology refresh", () => {
  it("adds newly discovered nodes as healthy", () => {
    const { monitor } = buildMonitor([new FakeNode("10.0.0.1:6379", "master")]);

    monitor.setNodes([
      new FakeNode("10.0.0.1:6379", "master"),
      new FakeNode("10.0.0.1:6380", "replica"),
    ]);

    expect(monitor.getHealth()).toHaveLength(2);
    expect(monitor.isHealthy("10.0.0.1:6380")).toBe(true);
  });

  it("drops nodes that left the topology", () => {
    const { monitor } = buildMonitor(buildNodes());

    monitor.setNodes([new FakeNode("10.0.0.1:6379", "master")]);

    expect(monitor.getHealth()).toHaveLength(1);
    expect(monitor.isHealthy("10.0.0.1:6380")).toBe(false);
  });

  it("preserves accumulated failure state across a role update", async () => {
    const node = new FakeNode("10.0.0.1:6380", "replica");
    node.pingShouldFail = true;

    const { monitor } = buildMonitor([node], { failureThreshold: 1 });
    await monitor.checkNow();
    expect(monitor.isHealthy(node.id)).toBe(false);

    // Post-failover promotion: same address, now a master.
    monitor.setNodes([new FakeNode(node.id, "master")]);

    expect(monitor.isHealthy(node.id)).toBe(false);
    expect(monitor.getNodeHealth(node.id)?.role).toBe("master");
  });

  it("returns health entries in a stable order", () => {
    const { monitor } = buildMonitor(buildNodes());
    const ids = monitor.getHealth().map((h) => h.id);

    expect(ids).toEqual([...ids].sort((a, b) => a.localeCompare(b)));
  });

  it("hands out copies so callers cannot mutate internal state", () => {
    const { monitor } = buildMonitor(buildNodes());

    monitor.getHealth()[0].healthy = false;

    expect(monitor.isHealthy("10.0.0.1:6379")).toBe(true);
  });
});

describe("RedisClusterHealthMonitor — interval", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("pings on the configured interval once started", async () => {
    const nodes = buildNodes();
    const { monitor } = buildMonitor(nodes, { intervalMs: 100 });

    monitor.start();
    expect(monitor.isRunning()).toBe(true);

    await vi.advanceTimersByTimeAsync(300);

    expect(nodes[0].pingCount).toBeGreaterThanOrEqual(2);
    monitor.stop();
  });

  it("is idempotent on repeated start() and stop()", async () => {
    const nodes = buildNodes();
    const { monitor } = buildMonitor(nodes, { intervalMs: 100 });

    monitor.start();
    monitor.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(nodes[0].pingCount).toBe(1);

    monitor.stop();
    monitor.stop();
    expect(monitor.isRunning()).toBe(false);

    await vi.advanceTimersByTimeAsync(500);
    expect(nodes[0].pingCount).toBe(1);
  });
});