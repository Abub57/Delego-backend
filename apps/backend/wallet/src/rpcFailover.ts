/**
 * Issue #527 — Real-time Stellar Horizon / Soroban RPC failover switcher.
 *
 * Stellar RPC nodes can experience latency spikes or downtime. This module
 * maintains a pool of configured endpoints, pings each one on a fixed interval
 * (default 15 s) while verifying the reported ledger sequence, and routes
 * requests to the lowest-latency healthy node using a weighted round-robin
 * (a healthier/faster node receives proportionally more traffic).
 *
 * Guarantees matching the acceptance criteria:
 * - A failing node is removed from the active pool within one failure cycle
 *   (`failureThreshold` defaults to 1 failure for single-cycle removal).
 * - Clients are never dropped during a single-node outage: callers keep
 *   receiving an active node (a healthy peer, or the least-bad node as a last
 *   resort) and retry/failover is automatic.
 */

export interface RpcNodeHealth {
  url: string;
  isHealthy: boolean;
  latencyMs: number;
  latestLedger: number;
  failureCount: number;
}

export interface RpcNodePoolOptions {
  /** 3+ endpoints are expected for real failover redundancy. */
  urls: string[];
  /** How often to ping every node. Default 15_000 ms. */
  pingIntervalMs?: number;
  /** Per-request timeout for a health ping. Default 3_000 ms. */
  timeoutMs?: number;
  /** Consecutive failures before a node leaves the active pool. Default 1. */
  failureThreshold?: number;
  /** Injectable fetch for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Called whenever traffic moves from one active node to another. */
  onFailover?: (event: FailoverEvent) => void;
  /** Called when every node reports degraded performance. */
  onAllDegraded?: (nodes: RpcNodeHealth[]) => void;
}

export interface FailoverEvent {
  from: string | null;
  to: string;
  reason: string;
  at: string;
}

/** Shape of a Soroban RPC `getLatestLedger` response we care about. */
interface GetLatestLedgerResult {
  sequence?: number;
  result?: { sequence?: number };
}

export function chooseBestHealthyNode(nodes: RpcNodeHealth[]): RpcNodeHealth | undefined {
  const healthy = nodes.filter((node) => node.isHealthy);
  if (healthy.length === 0) {
    return undefined;
  }

  return [...healthy].sort((a, b) => {
    if (a.latencyMs !== b.latencyMs) return a.latencyMs - b.latencyMs;
    if (a.latestLedger !== b.latestLedger) return b.latestLedger - a.latestLedger;
    return a.failureCount - b.failureCount;
  })[0];
}

export class RpcNodePool {
  private readonly nodes = new Map<string, RpcNodeHealth>();
  private readonly failureThreshold: number;
  private readonly timeoutMs: number;
  private readonly pingIntervalMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly onFailover?: (event: FailoverEvent) => void;
  private readonly onAllDegraded?: (nodes: RpcNodeHealth[]) => void;

  private roundRobinIndex = 0;
  private activeUrl: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private degradedAlerted = false;

  constructor(options: RpcNodePoolOptions) {
    const {
      urls,
      pingIntervalMs = 15_000,
      timeoutMs = 3_000,
      failureThreshold = 1,
      fetchImpl = fetch,
      onFailover,
      onAllDegraded,
    } = options;

    this.failureThreshold = failureThreshold;
    this.timeoutMs = timeoutMs;
    this.pingIntervalMs = pingIntervalMs;
    this.fetchImpl = fetchImpl;
    this.onFailover = onFailover;
    this.onAllDegraded = onAllDegraded;

    for (const url of urls) {
      this.nodes.set(url, {
        url,
        isHealthy: true,
        latencyMs: Number.POSITIVE_INFINITY,
        latestLedger: 0,
        failureCount: 0,
      });
    }
  }

  /** Begin the periodic background health check (`/health` + ledger). */
  start(): void {
    if (this.timer || this.pingIntervalMs <= 0) return;
    this.timer = setInterval(() => {
      void this.pingAll();
    }, this.pingIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getNode(url: string): RpcNodeHealth | undefined {
    return this.nodes.get(url);
  }

  getAllNodes(): RpcNodeHealth[] {
    return Array.from(this.nodes.values());
  }

  getHealthyNodes(): RpcNodeHealth[] {
    return this.getAllNodes().filter((node) => node.isHealthy);
  }

  /** The node new traffic should use right now. */
  getActiveNode(): RpcNodeHealth | undefined {
    const healthy = this.getHealthyNodes();
    const chosen = chooseBestHealthyNode(healthy) ?? chooseLeastBadNode(this.getAllNodes());
    if (chosen && chosen.url !== this.activeUrl) {
      this.emitFailover(this.activeUrl, chosen.url, "active node changed");
      this.activeUrl = chosen.url;
    }
    return chosen;
  }

  /**
   * Weighted round-robin pick.
   *
   * Each healthy node's weight is inversely proportional to its latency, so a
   * 10 ms node receives ~10x the traffic of a 100 ms node. The scheduler walks
   * a virtual wheel of `weight` slots per node.
   */
  getNextNode(): RpcNodeHealth | undefined {
    const healthy = this.getHealthyNodes();
    if (healthy.length === 0) {
      return chooseLeastBadNode(this.getAllNodes());
    }

    const weights = healthy.map((node) => ({
      node,
      weight: latencyToWeight(node.latencyMs),
    }));
    const totalWeight = weights.reduce((sum, entry) => sum + entry.weight, 0);
    if (totalWeight <= 0) {
      return healthy[this.roundRobinIndex++ % healthy.length];
    }

    let slot = this.roundRobinIndex++ % totalWeight;
    for (const entry of weights) {
      if (slot < entry.weight) return entry.node;
      slot -= entry.weight;
    }
    return weights[weights.length - 1]?.node;
  }

  recordSuccess(url: string, latencyMs: number, latestLedger = 0): void {
    const node = this.nodes.get(url);
    if (!node) {
      this.nodes.set(url, { url, isHealthy: true, latencyMs, latestLedger, failureCount: 0 });
      return;
    }
    node.isHealthy = true;
    node.latencyMs = latencyMs;
    node.latestLedger = latestLedger;
    node.failureCount = 0;
    this.degradedAlerted = false;
  }

  recordFailure(url: string, latencyMs = this.timeoutMs): void {
    const node = this.nodes.get(url);
    if (!node) {
      this.nodes.set(url, { url, isHealthy: false, latencyMs, latestLedger: 0, failureCount: 1 });
      this.checkAllDegraded();
      return;
    }

    node.latencyMs = latencyMs;
    node.failureCount += 1;
    node.isHealthy = node.failureCount < this.failureThreshold;
    this.checkAllDegraded();
  }

  /** Ping every node once, updating health/latency/ledger. */
  async pingAll(): Promise<RpcNodeHealth[]> {
    await Promise.all(this.getAllNodes().map((node) => this.pingNode(node.url)));
    return this.getAllNodes();
  }

  /** Ping a single node's `/health` and verify its latest ledger sequence. */
  async pingNode(url: string): Promise<RpcNodeHealth | undefined> {
    const started = Date.now();
    try {
      const { ledger } = await this.probe(url);
      const latencyMs = Date.now() - started;
      if (ledger <= 0) {
        this.recordFailure(url, latencyMs);
      } else {
        this.recordSuccess(url, latencyMs, ledger);
      }
    } catch {
      this.recordFailure(url, Date.now() - started);
    }
    return this.nodes.get(url);
  }

  private async probe(url: string): Promise<{ ledger: number }> {
    // `/health` — cheap liveness check.
    const health = await this.fetchWithTimeout(`${url}/health`);
    if (!health.ok) {
      throw new Error(`health returned ${health.status}`);
    }

    // `getLatestLedger` — verifies the node is synced, not just reachable.
    const response = await this.fetchWithTimeout(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getLatestLedger" }),
    });
    if (!response.ok) {
      throw new Error(`getLatestLedger returned ${response.status}`);
    }
    const body = (await response.json()) as GetLatestLedgerResult;
    const ledger = body.result?.sequence ?? body.sequence ?? 0;
    return { ledger };
  }

  private async fetchWithTimeout(input: string, init?: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(input, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  private checkAllDegraded(): void {
    const all = this.getAllNodes();
    if (all.length === 0) return;
    const allDegraded = all.every((node) => !node.isHealthy);
    if (allDegraded && !this.degradedAlerted) {
      this.degradedAlerted = true;
      this.onAllDegraded?.(all);
    } else if (!allDegraded) {
      this.degradedAlerted = false;
    }
  }

  private emitFailover(from: string | null, to: string, reason: string): void {
    this.onFailover?.({ from, to, reason, at: new Date().toISOString() });
  }
}

/**
 * Build a pool from environment configuration.
 *
 * `SOROBAN_RPC_POOL_URLS` is a comma-separated list of 3+ endpoints. When it
 * is unset, the single `SOROBAN_RPC_URL` (with the public testnet fallback) is
 * used so existing deployments keep working.
 */
export function readRpcPoolConfig(): RpcNodePoolOptions {
  const raw = process.env.SOROBAN_RPC_POOL_URLS ?? process.env.SOROBAN_RPC_URL;
  const urls = (raw ?? "https://soroban-testnet.stellar.org")
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);

  return {
    urls,
    pingIntervalMs: Number(process.env.SOROBAN_RPC_PING_INTERVAL_MS) || 15_000,
    timeoutMs: Number(process.env.SOROBAN_RPC_TIMEOUT_MS) || 3_000,
    failureThreshold: Number(process.env.SOROBAN_RPC_FAILURE_THRESHOLD) || 1,
  };
}

/** Map a latency reading to a positive integer weight. */
export function latencyToWeight(latencyMs: number): number {
  if (!Number.isFinite(latencyMs) || latencyMs <= 0) return 1;
  return Math.max(1, Math.round(1000 / latencyMs));
}

function chooseLeastBadNode(nodes: RpcNodeHealth[]): RpcNodeHealth | undefined {
  if (nodes.length === 0) return undefined;
  return [...nodes].sort((a, b) => {
    if (a.failureCount !== b.failureCount) return a.failureCount - b.failureCount;
    return a.latencyMs - b.latencyMs;
  })[0];
}
