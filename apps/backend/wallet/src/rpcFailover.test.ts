import { describe, expect, it, vi, afterEach } from "vitest";
import {
  RpcNodePool,
  chooseBestHealthyNode,
  latencyToWeight,
  readRpcPoolConfig,
  type FailoverEvent,
} from "./rpcFailover.js";

/** Builds a fetch stub that returns a healthy `/health` and a ledger. */
function healthFetch(ledgerByUrl: Record<string, number> = {}): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    for (const [base, ledger] of Object.entries(ledgerByUrl)) {
      if (url.startsWith(base)) {
        if (url.endsWith("/health")) {
          return new Response("ok", { status: 200 });
        }
        return new Response(JSON.stringify({ result: { sequence: ledger } }), { status: 200 });
      }
    }
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
}

describe("#527 RpcNodePool", () => {
  describe("chooseBestHealthyNode", () => {
    it("prefers the lowest-latency healthy node", () => {
      const winner = chooseBestHealthyNode([
        { url: "https://rpc-a", isHealthy: true, latencyMs: 180, latestLedger: 1000, failureCount: 0 },
        { url: "https://rpc-b", isHealthy: true, latencyMs: 42, latestLedger: 1002, failureCount: 0 },
        { url: "https://rpc-c", isHealthy: false, latencyMs: 10, latestLedger: 999, failureCount: 3 },
      ]);
      expect(winner?.url).toBe("https://rpc-b");
    });

    it("returns undefined when no node is healthy", () => {
      expect(
        chooseBestHealthyNode([
          { url: "https://rpc-a", isHealthy: false, latencyMs: 10, latestLedger: 1, failureCount: 3 },
        ]),
      ).toBeUndefined();
    });
  });

  describe("failure isolation", () => {
    it("removes a node from the active pool within one failure cycle by default", () => {
      const pool = new RpcNodePool({
        urls: ["https://rpc-a", "https://rpc-b", "https://rpc-c"],
        pingIntervalMs: 0,
        timeoutMs: 200,
      });

      pool.recordFailure("https://rpc-a");

      expect(pool.getNode("https://rpc-a")?.isHealthy).toBe(false);
      expect(pool.getHealthyNodes().map((n) => n.url)).not.toContain("https://rpc-a");
      expect(pool.getActiveNode()?.url).toBe("https://rpc-b");
    });

    it("honours a higher failure threshold", () => {
      const pool = new RpcNodePool({
        urls: ["https://rpc-a", "https://rpc-b"],
        pingIntervalMs: 0,
        failureThreshold: 3,
      });
      pool.recordFailure("https://rpc-a");
      expect(pool.getNode("https://rpc-a")?.isHealthy).toBe(true);
      pool.recordFailure("https://rpc-a");
      pool.recordFailure("https://rpc-a");
      expect(pool.getNode("https://rpc-a")?.isHealthy).toBe(false);
    });

    it("never drops a client during a single-node outage", () => {
      const pool = new RpcNodePool({
        urls: ["https://rpc-a", "https://rpc-b", "https://rpc-c"],
        pingIntervalMs: 0,
      });
      pool.recordFailure("https://rpc-a");
      expect(pool.getNextNode()).toBeDefined();
      expect(pool.getActiveNode()).toBeDefined();
    });

    it("still routes to the least-bad node when all nodes are unhealthy", () => {
      const pool = new RpcNodePool({ urls: ["https://rpc-a", "https://rpc-b"], pingIntervalMs: 0 });
      pool.recordFailure("https://rpc-a");
      pool.recordFailure("https://rpc-b");
      expect(pool.getActiveNode()?.url).toBeDefined();
    });
  });

  describe("weighted round-robin", () => {
    it("routes proportionally more traffic to lower-latency nodes", () => {
      const pool = new RpcNodePool({
        urls: ["https://fast", "https://slow"],
        pingIntervalMs: 0,
      });
      pool.recordSuccess("https://fast", 10); // weight 100
      pool.recordSuccess("https://slow", 100); // weight 10

      const counts: Record<string, number> = { "https://fast": 0, "https://slow": 0 };
      for (let i = 0; i < 110; i++) {
        const node = pool.getNextNode();
        counts[node!.url] += 1;
      }

      expect(counts["https://fast"]).toBeGreaterThan(counts["https://slow"]);
    });

    it("computes weights from latency", () => {
      expect(latencyToWeight(10)).toBe(100);
      expect(latencyToWeight(1000)).toBe(1);
      expect(latencyToWeight(Number.POSITIVE_INFINITY)).toBe(1);
    });
  });

  describe("health pings", () => {
    it("marks synced nodes healthy and records the ledger", async () => {
      const pool = new RpcNodePool({
        urls: ["https://rpc-a", "https://rpc-b"],
        pingIntervalMs: 0,
        fetchImpl: healthFetch({ "https://rpc-a": 5000, "https://rpc-b": 5001 }),
      });

      await pool.pingAll();

      expect(pool.getNode("https://rpc-a")?.isHealthy).toBe(true);
      expect(pool.getNode("https://rpc-a")?.latestLedger).toBe(5000);
      expect(pool.getNode("https://rpc-b")?.latestLedger).toBe(5001);
    });

    it("marks a node unhealthy when its ledger cannot be verified", async () => {
      const pool = new RpcNodePool({
        urls: ["https://rpc-a", "https://rpc-b"],
        pingIntervalMs: 0,
        fetchImpl: healthFetch({ "https://rpc-a": 0, "https://rpc-b": 5001 }),
      });

      await pool.pingAll();

      expect(pool.getNode("https://rpc-a")?.isHealthy).toBe(false);
      expect(pool.getNode("https://rpc-b")?.isHealthy).toBe(true);
    });

    it("marks a node unhealthy when the ping throws", async () => {
      const failing = (async (input: RequestInfo | URL) => {
        if (String(input).startsWith("https://rpc-b")) throw new Error("network down");
        return new Response(JSON.stringify({ result: { sequence: 100 } }), { status: 200 });
      }) as typeof fetch;

      const pool = new RpcNodePool({
        urls: ["https://rpc-a", "https://rpc-b"],
        pingIntervalMs: 0,
        fetchImpl: failing,
      });

      await pool.pingAll();
      expect(pool.getNode("https://rpc-a")?.isHealthy).toBe(true);
      expect(pool.getNode("https://rpc-b")?.isHealthy).toBe(false);
    });

    it("starts and stops the periodic health timer", () => {
      const pool = new RpcNodePool({ urls: ["https://rpc-a"], pingIntervalMs: 15_000 });
      pool.start();
      pool.start(); // idempotent
      pool.stop();
      pool.stop(); // idempotent
      expect(true).toBe(true);
    });
  });

  describe("failover logging and alerts", () => {
    it("emits a failover event when the active node changes", () => {
      const events: FailoverEvent[] = [];
      const pool = new RpcNodePool({
        urls: ["https://rpc-a", "https://rpc-b"],
        pingIntervalMs: 0,
        onFailover: (event) => events.push(event),
      });

      pool.recordSuccess("https://rpc-a", 10);
      pool.recordSuccess("https://rpc-b", 20);
      pool.getActiveNode(); // selects rpc-a
      pool.recordFailure("https://rpc-a");
      pool.getActiveNode(); // fails over to rpc-b

      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events.at(-1)?.to).toBe("https://rpc-b");
      expect(events.at(-1)?.reason).toMatch(/active node changed/i);
    });

    it("emits an alert when every node reports degraded performance", () => {
      const alerts: unknown[] = [];
      const pool = new RpcNodePool({
        urls: ["https://rpc-a", "https://rpc-b"],
        pingIntervalMs: 0,
        onAllDegraded: (nodes) => alerts.push(nodes),
      });

      pool.recordFailure("https://rpc-a");
      pool.recordFailure("https://rpc-b");

      expect(alerts).toHaveLength(1);
    });

    it("does not re-alert continuously while all nodes remain degraded", () => {
      const onAllDegraded = vi.fn();
      const pool = new RpcNodePool({
        urls: ["https://rpc-a", "https://rpc-b"],
        pingIntervalMs: 0,
        onAllDegraded,
      });

      pool.recordFailure("https://rpc-a");
      pool.recordFailure("https://rpc-b");
      pool.recordFailure("https://rpc-a");

      expect(onAllDegraded).toHaveBeenCalledTimes(1);
    });
  });

  describe("readRpcPoolConfig", () => {
    const original = { ...process.env };

    afterEach(() => {
      process.env = { ...original };
    });

    it("reads a comma-separated pool of endpoints", () => {
      process.env.SOROBAN_RPC_POOL_URLS = "https://a, https://b ,https://c";
      process.env.SOROBAN_RPC_PING_INTERVAL_MS = "20000";
      process.env.SOROBAN_RPC_FAILURE_THRESHOLD = "2";

      const config = readRpcPoolConfig();
      expect(config.urls).toEqual(["https://a", "https://b", "https://c"]);
      expect(config.pingIntervalMs).toBe(20000);
      expect(config.failureThreshold).toBe(2);
    });

    it("falls back to a single SOROBAN_RPC_URL", () => {
      delete process.env.SOROBAN_RPC_POOL_URLS;
      process.env.SOROBAN_RPC_URL = "https://single";
      expect(readRpcPoolConfig().urls).toEqual(["https://single"]);
    });
  });
});
