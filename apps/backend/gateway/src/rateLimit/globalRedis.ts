import { Redis } from "ioredis";
import { GlobalTokenBucket } from "./globalTokenBucket.js";

let client: Redis | undefined;
let limiter: GlobalTokenBucket | undefined;

/** No automatic in-memory fallback: all replicas must share the same quota. */
export function getGlobalRateLimiter(): GlobalTokenBucket {
  if (!limiter) {
    const owned = createGlobalRateLimiter();
    client = owned.client;
    limiter = owned.limiter;
  }
  return limiter;
}

export function createGlobalRateLimiter() {
  const client = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
    connectTimeout: 1000,
    commandTimeout: 1000,
    maxRetriesPerRequest: 0,
    enableOfflineQueue: false,
    retryStrategy: (attempt) => Math.min(attempt * 200, 2000),
  });
  // Requests get a bounded 503 on connection failure; do not log URLs/secrets.
  client.on("error", () => {});
  return { client, limiter: new GlobalTokenBucket(client) };
}

export async function closeGlobalRateLimiter(): Promise<void> {
  client?.disconnect();
  client = undefined;
  limiter = undefined;
}
