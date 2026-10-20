import { randomUUID } from "node:crypto";
import type { CacheRedisClient } from "./client.js";

export interface RedlockOptions {
  resource: string;
  ttlMs: number;
  retryCount: number;
  retryDelayMs: number;
}

export interface LockHandle {
  lockKey: string;
  lockValue: string;
  release: () => Promise<boolean>;
  extend: (additionalTtlMs: number) => Promise<boolean>;
}

const ACQUIRE_LUA = `
if redis.call("SET", KEYS[1], ARGV[1], "NX", "PX", tonumber(ARGV[2])) then
  return 1
end
return 0
`;

const RELEASE_LUA = `
local current = redis.call("GET", KEYS[1])
if not current then
  return 0
end
if current == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;

const EXTEND_LUA = `
local current = redis.call("GET", KEYS[1])
if not current then
  return 0
end
if current == ARGV[1] then
  return redis.call("PEXPIRE", KEYS[1], tonumber(ARGV[2]))
end
return 0
`;

export function lockKeyForResource(resource: string): string {
  if (resource.startsWith("cart:")) {
    return `cart:{${resource.slice("cart:".length)}}`;
  }
  return `redlock:{${resource}}`;
}

export async function acquireRedlock(
  redis: CacheRedisClient,
  options: RedlockOptions
): Promise<LockHandle | null> {
  const { resource, ttlMs, retryCount, retryDelayMs } = options;
  const lockKey = lockKeyForResource(resource);
  const lockValue = randomUUID();

  for (let attempt = 0; attempt <= Math.max(0, retryCount); attempt += 1) {
    const acquired = Number(await redis.eval(ACQUIRE_LUA, 1, lockKey, lockValue, ttlMs)) === 1;
    if (acquired) {
      return {
        lockKey,
        lockValue,
        release: () => releaseRedlock(redis, lockKey, lockValue),
        extend: (additionalTtlMs: number) => extendRedlock(redis, lockKey, lockValue, additionalTtlMs),
      };
    }

    if (attempt === Math.max(0, retryCount)) break;
    if (retryDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }

  return null;
}

export async function releaseRedlock(
  redis: CacheRedisClient,
  lockKey: string,
  lockValue: string
): Promise<boolean> {
  const result = Number(await redis.eval(RELEASE_LUA, 1, lockKey, lockValue));
  return result === 1;
}

export async function extendRedlock(
  redis: CacheRedisClient,
  lockKey: string,
  lockValue: string,
  additionalTtlMs: number
): Promise<boolean> {
  const ttlMs = Math.max(1, additionalTtlMs);
  const result = Number(await redis.eval(EXTEND_LUA, 1, lockKey, lockValue, ttlMs));
  return result === 1;
}

export async function withCartCheckoutLock<T>(
  redis: CacheRedisClient,
  cartId: string,
  fn: () => Promise<T>,
  options: Pick<RedlockOptions, "ttlMs" | "retryCount" | "retryDelayMs"> = {
    ttlMs: 15_000,
    retryCount: 0,
    retryDelayMs: 50,
  }
): Promise<T> {
  const lock = await acquireRedlock(redis, {
    resource: `cart:${cartId}`,
    ttlMs: options.ttlMs,
    retryCount: options.retryCount,
    retryDelayMs: options.retryDelayMs,
  });

  if (!lock) {
    throw Object.assign(new Error(`Checkout lock acquisition failed for cart:${cartId}`), {
      statusCode: 409,
      code: "CART_ALREADY_LOCKED",
    });
  }

  try {
    return await fn();
  } finally {
    await lock.release();
  }
}
