/**
 * Horizon `/paths/strict-receive` client with connection pooling.
 *
 * Quote traffic is bursty and latency-sensitive, so one keep-alive agent per
 * Horizon origin is reused across requests (no TLS handshake per quote), with
 * a bounded socket pool. Identical concurrent requests are coalesced into a
 * single upstream call.
 */

import http from "node:http";
import https from "node:https";

export interface HorizonAssetRef {
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
}

/** One record of `/paths/strict-receive` (amounts are decimal strings). */
export interface HorizonPathRecord {
  source_asset_type: string;
  source_asset_code?: string;
  source_asset_issuer?: string;
  source_amount: string;
  destination_asset_type: string;
  destination_asset_code?: string;
  destination_asset_issuer?: string;
  destination_amount: string;
  path: HorizonAssetRef[];
}

export interface StrictReceivePathsQuery {
  /** Horizon form: "native" or "CODE:ISSUER" (max 15). */
  sourceAssets: string[];
  destinationAsset: { type: string; code?: string; issuer?: string };
  /** Decimal string, ≤ 7 fractional digits. */
  destinationAmount: string;
}

export interface HorizonPathsClient {
  strictReceivePaths(query: StrictReceivePathsQuery): Promise<HorizonPathRecord[]>;
}

export class HorizonRequestError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "HorizonRequestError";
  }
}

export interface PooledHorizonClientOptions {
  /** Max concurrent sockets to Horizon. Default 32. */
  maxSockets?: number;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export class PooledHorizonClient implements HorizonPathsClient {
  private readonly baseUrl: URL;
  private readonly agent: http.Agent;
  private readonly httpGet: (
    url: URL,
    options: http.RequestOptions,
    callback: (res: http.IncomingMessage) => void
  ) => http.ClientRequest;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(horizonUrl: string, options: PooledHorizonClientOptions = {}) {
    this.baseUrl = new URL(horizonUrl);
    const secure = this.baseUrl.protocol === "https:";
    const agentOptions = {
      keepAlive: true,
      keepAliveMsecs: 10_000,
      maxSockets: options.maxSockets ?? 32,
      maxFreeSockets: 8,
      scheduling: "lifo" as const,
    };
    this.agent = secure ? new https.Agent(agentOptions) : new http.Agent(agentOptions);
    this.httpGet = secure ? https.get : http.get;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.maxResponseBytes = options.maxResponseBytes ?? 2 * 1024 * 1024;
  }

  async strictReceivePaths(query: StrictReceivePathsQuery): Promise<HorizonPathRecord[]> {
    const url = new URL("/paths/strict-receive", this.baseUrl);
    url.searchParams.set("source_assets", query.sourceAssets.join(","));
    url.searchParams.set("destination_asset_type", query.destinationAsset.type);
    if (query.destinationAsset.type !== "native") {
      url.searchParams.set("destination_asset_code", query.destinationAsset.code ?? "");
      url.searchParams.set("destination_asset_issuer", query.destinationAsset.issuer ?? "");
    }
    url.searchParams.set("destination_amount", query.destinationAmount);

    const body = (await this.getJson(url)) as { _embedded?: { records?: HorizonPathRecord[] } };
    return body._embedded?.records ?? [];
  }

  /** Closes pooled sockets (graceful shutdown). */
  close(): void {
    this.agent.destroy();
  }

  private getJson(url: URL): Promise<unknown> {
    const key = url.toString();
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const request = this.request(url).finally(() => this.inflight.delete(key));
    this.inflight.set(key, request);
    return request;
  }

  private request(url: URL): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const req = this.httpGet(
        url,
        { agent: this.agent, headers: { Accept: "application/json" }, timeout: this.timeoutMs },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > this.maxResponseBytes) {
              req.destroy(new HorizonRequestError("Horizon response exceeded size limit"));
              return;
            }
            chunks.push(chunk);
          });
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            const status = res.statusCode ?? 0;
            if (status < 200 || status >= 300) {
              reject(new HorizonRequestError(`Horizon ${url.pathname} returned HTTP ${status}`, status));
              return;
            }
            try {
              resolve(JSON.parse(text));
            } catch {
              reject(new HorizonRequestError("Horizon returned invalid JSON", status));
            }
          });
          res.on("error", reject);
        }
      );
      req.on("timeout", () => req.destroy(new HorizonRequestError(`Horizon request timed out after ${this.timeoutMs}ms`)));
      req.on("error", reject);
    });
  }
}
