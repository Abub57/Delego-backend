/**
 * Redis client singleton for the analytics service (#392).
 *
 * Mirrors apps/backend/gateway/src/rateLimit/redisClient.ts: same
 * env var, same test/CI mock fallback via ioredis-mock so unit tests
 * never need a live Redis instance.
 */

import { Redis } from "ioredis";
import { createRequire } from "node:module";
import { createLogger } from "@delegolabs/utils";

const log = createLogger("analytics:redis", process.env.LOG_LEVEL ?? "info");

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

let redis: Redis | null = null;

export function getRedisClient(): Redis {
  if (!redis) {
    const isTest =
      process.env.NODE_ENV === "test" ||
      process.env.MOCK_REDIS === "true" ||
      process.env.CI === "true";

    if (isTest) {
      log.info("Using mock Redis connection for analytics caching");
      const require = createRequire(import.meta.url);
      const MockRedisConstructor = require("ioredis-mock");
      redis = new MockRedisConstructor();
    } else {
      log.info("Connecting to real Redis for analytics caching", { url: REDIS_URL });
      redis = new Redis(REDIS_URL, {
        maxRetriesPerRequest: 3,
        retryStrategy(times: number): number | null {
          if (times > 5) {
            log.error("Redis connection failed after 5 retries — giving up");
            return null;
          }
          return Math.min(times * 200, 2000);
        },
        lazyConnect: false,
      });

      redis.on("connect", () => log.info("Redis connected", { url: REDIS_URL }));
      redis.on("error", (err: Error) => log.error("Redis error", { error: err.message }));
    }
  }
  return redis as Redis;
}

/** Test-only: drop the singleton so the next getRedisClient() rebuilds it. */
export function resetRedisClientForTests(): void {
  redis = null;
}
