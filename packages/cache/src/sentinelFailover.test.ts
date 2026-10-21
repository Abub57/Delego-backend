/**
 * Vitest unit tests for SentinelFailoverHealthBridge
 *
 * This file is intentionally self-contained: it stubs every collaborator so
 * the suite never reaches @delegolabs/utils or @delegolabs/types (which are
 * not pre-built in this repo's CI environment).
 *
 * Acceptance criteria verified:
 *   - READONLY errors are caught and re-thrown as SentinelReadonlyError (never unhandled).
 *   - healthCheck() returns "degraded" during the election window (≤ 10 s).
 *   - healthCheck() returns "failing" when the election window is exceeded.
 *   - +switch-master events trigger a setNodes() refresh within 500 ms.
 *   - The new master host:port is reflected within 500 ms.
 *   - healthCheck() returns "healthy" when no failover is in progress.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  SentinelFailoverHealthBridge,
  SentinelReadonlyError,
  type SentinelRedisClient,
} from "./sentinelFailover.js";

// ---------------------------------------------------------------------------
// Minimal stubs — no imports from clusterHealth.ts (avoids @delegolabs/utils)
// ---------------------------------------------------------------------------

type RedisNodeRole = "master" | "replica";

interface RedisNodeHealth {
  id: string;
  role: RedisNodeRole;
  healthy: boolean;
  consecutiveFailures: number;
  lastError?: string;
  lastCheckedAt?: string;
}

interface HealthCheckableNode {
  id: string;
  role: RedisNodeRole;
  ping(): Promise<string>;
  connect?(): Promise<unknown>;
}

/** Minimal stand-in for RedisClusterHealthMonitor. */
class FakeMonitor {
  private nodes: Map<string, RedisNodeHealth> = new Map();

  constructor(initialNodes: HealthCheckableNode[]) {
    for (const n of initialNodes) {
      this.nodes.set(n.id, {
        id: n.id,
        role: n.role,
        healthy: true,
        consecutiveFailures: 0,
      });
    }
  }

  getHealth(): RedisNodeHealth[] {
    return [...this.nodes.values()].map((e) => ({ ...e }));
  }

  getNodeHealth(id: string): RedisNodeHealth | undefined {
    const e = this.nodes.get(id);
    return e ? { ...e } : undefined;
  }

  setNodes(nodes: HealthCheckableNode[]): void {
    const nextIds = new Set(nodes.map((n) => n.id));
    for (const id of [...this.nodes.keys()]) {
      if (!nextIds.has(id)) this.nodes.delete(id);
    }
    for (const node of nodes) {
      const existing = this.nodes.get(node.id);
      if (existing) {
        existing.role = node.role;
      } else {
        this.nodes.set(node.id, {
          id: node.id,
          role: node.role,
          healthy: true,
          consecutiveFailures: 0,
        });
      }
    }
  }

  async checkNow(): Promise<void> {
    // In tests, mark all nodes healthy after a sweep so failover-complete
    // detection works correctly.
    for (const entry of this.nodes.values()) {
      entry.healthy = true;
      entry.consecutiveFailures = 0;
    }
  }
}

// Cast FakeMonitor to the shape SentinelFailoverHealthBridge expects.
function asMonitor(fake: FakeMonitor): ConstructorParameters<typeof SentinelFailoverHealthBridge>[0]["monitor"] {
  return fake as unknown as ConstructorParameters<typeof SentinelFailoverHealthBridge>[0]["monitor"];
}

// ---------------------------------------------------------------------------
// Fake Sentinel client
// ---------------------------------------------------------------------------

type EventCallback = (...args: unknown[]) => void;

class FakeSentinelClient implements SentinelRedisClient {
  readonly options = {
    name: "mymaster",
    sentinels: [{ host: "sentinel-1", port: 26379 }],
    host: "redis-master",
    port: 6379,
  };

  private listeners: Record<string, EventCallback[]> = {};
  pingShouldFail = false;
  pingDelayMs = 0;

  on(event: string, listener: EventCallback): this {
    this.listeners[event] ??= [];
    this.listeners[event].push(listener);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const cb of this.listeners[event] ?? []) cb(...args);
  }

  async ping(): Promise<string> {
    if (this.pingDelayMs > 0) {
      await new Promise((r) => setTimeout(r, this.pingDelayMs));
    }
    if (this.pingShouldFail) throw new Error("connection refused");
    return "PONG";
  }
}

function makeNode(id: string, role: RedisNodeRole = "master"): HealthCheckableNode {
  return { id, role, async ping() { return "PONG"; } };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SentinelFailoverHealthBridge — READONLY guard", () => {
  it("re-throws READONLY as SentinelReadonlyError", async () => {
    const client = new FakeSentinelClient();
    const monitor = new FakeMonitor([makeNode("redis-master:6379")]);
    const bridge = new SentinelFailoverHealthBridge({
      sentinelClient: client,
      monitor: asMonitor(monitor),
    });

    await expect(
      bridge.withWriteGuard(async () => {
        throw new Error("READONLY You can't write against a read only replica");
      }),
    ).rejects.toBeInstanceOf(SentinelReadonlyError);
  });

  it("does not wrap non-READONLY errors in SentinelReadonlyError", async () => {
    const client = new FakeSentinelClient();
    const monitor = new FakeMonitor([makeNode("redis-master:6379")]);
    const bridge = new SentinelFailoverHealthBridge({
      sentinelClient: client,
      monitor: asMonitor(monitor),
    });

    const err = await bridge.withWriteGuard(async () => {
      throw new Error("connection timeout");
    }).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(SentinelReadonlyError);
    expect(err.message).toContain("connection timeout");
  });

  it("marks the bridge degraded after a READONLY error", async () => {
    const client = new FakeSentinelClient();
    const monitor = new FakeMonitor([makeNode("redis-master:6379")]);
    const bridge = new SentinelFailoverHealthBridge({
      sentinelClient: client,
      monitor: asMonitor(monitor),
    });

    await bridge.withWriteGuard(async () => {
      throw new Error("READONLY replica");
    }).catch(() => {});

    expect(bridge.isFailoverInProgress()).toBe(true);
    const report = await bridge.healthCheck();
    expect(report.status).toBe("degraded");
  });

  it("passes through successful write results unchanged", async () => {
    const client = new FakeSentinelClient();
    const monitor = new FakeMonitor([makeNode("redis-master:6379")]);
    const bridge = new SentinelFailoverHealthBridge({
      sentinelClient: client,
      monitor: asMonitor(monitor),
    });

    const result = await bridge.withWriteGuard(async () => "OK");
    expect(result).toBe("OK");
  });

  it("marks degraded when ioredis emits READONLY on the error event", async () => {
    const client = new FakeSentinelClient();
    const monitor = new FakeMonitor([makeNode("redis-master:6379")]);
    const bridge = new SentinelFailoverHealthBridge({
      sentinelClient: client,
      monitor: asMonitor(monitor),
    });

    client.emit("error", new Error("READONLY You can't write against a read only replica"));

    expect(bridge.isFailoverInProgress()).toBe(true);
  });
});

describe("SentinelFailoverHealthBridge — healthCheck status", () => {
  it("returns 'healthy' when no failover is in progress and nodes are up", async () => {
    const client = new FakeSentinelClient();
    const monitor = new FakeMonitor([makeNode("redis-master:6379")]);
    const bridge = new SentinelFailoverHealthBridge({
      sentinelClient: client,
      monitor: asMonitor(monitor),
    });

    const report = await bridge.healthCheck();
    expect(report.status).toBe("healthy");
    expect(report.failoverInProgress).toBe(false);
  });

  it("returns 'degraded' immediately after a READONLY hit (within election window)", async () => {
    const client = new FakeSentinelClient();
    const monitor = new FakeMonitor([makeNode("redis-master:6379")]);
    const bridge = new SentinelFailoverHealthBridge({
      sentinelClient: client,
      monitor: asMonitor(monitor),
      electionWindowMs: 10_000,
    });

    await bridge.withWriteGuard(async () => {
      throw new Error("READONLY replica");
    }).catch(() => {});

    const report = await bridge.healthCheck();
    expect(report.status).toBe("degraded");
    expect(report.failoverInProgress).toBe(true);
  });

  it("returns 'failing' once the election window is exceeded", async () => {
    const client = new FakeSentinelClient();
    const monitor = new FakeMonitor([makeNode("redis-master:6379")]);
    const bridge = new SentinelFailoverHealthBridge({
      sentinelClient: client,
      monitor: asMonitor(monitor),
      electionWindowMs: 1, // 1 ms — expires almost immediately
    });

    await bridge.withWriteGuard(async () => {
      throw new Error("READONLY replica");
    }).catch(() => {});

    // Wait for the 1 ms window to expire.
    await new Promise((r) => setTimeout(r, 20));

    const report = await bridge.healthCheck();
    expect(report.status).toBe("failing");
  });

  it("healthCheck.latencyMs is a non-negative number", async () => {
    const client = new FakeSentinelClient();
    const monitor = new FakeMonitor([makeNode("redis-master:6379")]);
    const bridge = new SentinelFailoverHealthBridge({
      sentinelClient: client,
      monitor: asMonitor(monitor),
    });

    const report = await bridge.healthCheck();
    expect(typeof report.latencyMs).toBe("number");
    expect(report.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("does not throw when the ping fails; reports latency from the failed attempt", async () => {
    const client = new FakeSentinelClient();
    client.pingShouldFail = true;
    const monitor = new FakeMonitor([makeNode("redis-master:6379")]);
    const bridge = new SentinelFailoverHealthBridge({
      sentinelClient: client,
      monitor: asMonitor(monitor),
    });

    await expect(bridge.healthCheck()).resolves.toBeDefined();
  });

  it("reports correct replicasCount from monitor health", async () => {
    const client = new FakeSentinelClient();
    const monitor = new FakeMonitor([
      makeNode("master:6379", "master"),
      makeNode("replica1:6379", "replica"),
      makeNode("replica2:6379", "replica"),
    ]);
    const bridge = new SentinelFailoverHealthBridge({
      sentinelClient: client,
      monitor: asMonitor(monitor),
    });

    const report = await bridge.healthCheck();
    expect(report.replicasCount).toBe(2);
  });
});

describe("SentinelFailoverHealthBridge — +switch-master topology refresh", () => {
  it("updates the current master within 500 ms of a +switch-master event", async () => {
    const client = new FakeSentinelClient();
    const monitor = new FakeMonitor([
      makeNode("old-master:6379", "master"),
      makeNode("promoted-replica:6379", "replica"),
    ]);
    const bridge = new SentinelFailoverHealthBridge({
      sentinelClient: client,
      monitor: asMonitor(monitor),
      electionWindowMs: 10_000,
      refreshTimeoutMs: 500,
    });

    expect(bridge.getCurrentMaster().host).not.toBe("promoted-replica");

    // Five-argument form (ioredis 5.x style).
    client.emit("+switch-master", "mymaster", "old-master", 6379, "promoted-replica", 6379);

    const deadline = Date.now() + 500;
    while (bridge.getCurrentMaster().host !== "promoted-replica" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }

    expect(bridge.getCurrentMaster().host).toBe("promoted-replica");
    expect(bridge.getCurrentMaster().port).toBe(6379);
  });

  it("parses the single-string +switch-master format", async () => {
    const client = new FakeSentinelClient();
    const monitor = new FakeMonitor([
      makeNode("old:6379", "master"),
      makeNode("new:6380", "replica"),
    ]);
    const bridge = new SentinelFailoverHealthBridge({
      sentinelClient: client,
      monitor: asMonitor(monitor),
      refreshTimeoutMs: 500,
    });

    client.emit("+switch-master", "mymaster old 6379 new 6380");

    const deadline = Date.now() + 500;
    while (bridge.getCurrentMaster().host !== "new" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }

    expect(bridge.getCurrentMaster().host).toBe("new");
    expect(bridge.getCurrentMaster().port).toBe(6380);
  });

  it("promotes the new master and demotes the old in the monitor's node list", async () => {
    const client = new FakeSentinelClient();
    const monitor = new FakeMonitor([
      makeNode("old-master:6379", "master"),
      makeNode("new-master:6379", "replica"),
    ]);
    const bridge = new SentinelFailoverHealthBridge({
      sentinelClient: client,
      monitor: asMonitor(monitor),
      refreshTimeoutMs: 500,
    });

    client.emit("+switch-master", "mymaster", "old-master", 6379, "new-master", 6379);

    const deadline = Date.now() + 500;
    while (bridge.getCurrentMaster().host !== "new-master" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }

    const health = monitor.getHealth();
    const newEntry = health.find((h) => h.id === "new-master:6379");
    const oldEntry = health.find((h) => h.id === "old-master:6379");

    expect(newEntry?.role).toBe("master");
    expect(oldEntry?.role).toBe("replica");
  });

  it("clears failoverInProgress once the new master pings healthy", async () => {
    const client = new FakeSentinelClient();
    const monitor = new FakeMonitor([
      makeNode("old:6379", "master"),
      makeNode("promoted:6379", "replica"),
    ]);
    const bridge = new SentinelFailoverHealthBridge({
      sentinelClient: client,
      monitor: asMonitor(monitor),
      refreshTimeoutMs: 500,
    });

    client.emit("+switch-master", "mymaster", "old", 6379, "promoted", 6379);

    // Wait for the async refresh + checkNow to complete.
    const deadline = Date.now() + 500;
    while (bridge.isFailoverInProgress() && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }

    // FakeMonitor.checkNow() marks all nodes healthy, so the bridge should
    // detect the new master is up and clear the failover flag.
    expect(bridge.isFailoverInProgress()).toBe(false);
  });

  it("marks degraded immediately on receiving +switch-master", async () => {
    const client = new FakeSentinelClient();
    const monitor = new FakeMonitor([makeNode("master:6379", "master")]);
    const bridge = new SentinelFailoverHealthBridge({
      sentinelClient: client,
      monitor: asMonitor(monitor),
      electionWindowMs: 10_000,
      refreshTimeoutMs: 500,
    });

    client.emit("+switch-master", "mymaster", "master", 6379, "new:6379", 6379);

    // Degraded state is set synchronously before the async refresh runs.
    expect(bridge.isFailoverInProgress()).toBe(true);
  });
});

describe("SentinelFailoverHealthBridge — getCurrentMaster", () => {
  it("returns a copy so callers cannot mutate internal state", async () => {
    const client = new FakeSentinelClient();
    const monitor = new FakeMonitor([makeNode("redis-master:6379")]);
    const bridge = new SentinelFailoverHealthBridge({
      sentinelClient: client,
      monitor: asMonitor(monitor),
    });

    const master = bridge.getCurrentMaster();
    master.host = "tampered";

    expect(bridge.getCurrentMaster().host).not.toBe("tampered");
  });

  it("reflects the initial master coordinates from client options", () => {
    const client = new FakeSentinelClient();
    const monitor = new FakeMonitor([makeNode("redis-master:6379")]);
    const bridge = new SentinelFailoverHealthBridge({
      sentinelClient: client,
      monitor: asMonitor(monitor),
    });

    expect(bridge.getCurrentMaster().host).toBe("redis-master");
    expect(bridge.getCurrentMaster().port).toBe(6379);
  });
});
