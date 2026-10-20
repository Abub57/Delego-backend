import { createHash } from "node:crypto";

export const GLOBAL_QUOTAS = { free: 60, verified: 600, enterprise: 3000 } as const;
export type GlobalTier = keyof typeof GLOBAL_QUOTAS;

export function resolveGlobalTier(roles: readonly string[] | undefined): GlobalTier {
  if (roles?.includes("enterprise")) return "enterprise";
  if (roles?.some((role) => ["verified", "merchant", "pro"].includes(role))) return "verified";
  return "free";
}

/** All state changes and replenishment execute in one Redis operation.
 * An empty ARGV[3] uses Redis TIME, avoiding clock skew between gateway replicas.
 * The explicit timestamp is reserved for deterministic tests of the same script.
 */
export const GLOBAL_TOKEN_BUCKET_LUA = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local fill_rate = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])
if not now then
  local time = redis.call('TIME')
  now = tonumber(time[1]) * 1000 + tonumber(time[2]) / 1000
end
local state = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(state[1]) or capacity
local ts = tonumber(state[2]) or now
now = math.max(now, ts)
tokens = math.min(capacity, tokens + (now - ts) * fill_rate)
local allowed = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
end
local retry_ms = 0
if allowed == 0 then
  retry_ms = math.ceil((cost - tokens) / fill_rate)
end
redis.call('HSET', key, 'tokens', tostring(tokens), 'ts', tostring(now))
-- Never expire a partially depleted bucket before it could fully replenish.
redis.call('PEXPIRE', key, math.ceil(capacity / fill_rate) + 1000)
return {allowed, math.floor(tokens), retry_ms}
`;

export interface GlobalRedisClient {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

export interface GlobalDecision {
  allowed: boolean;
  tier: GlobalTier;
  headers: Record<string, string>;
}

export class RateLimitUnavailableError extends Error {
  constructor() { super("Rate limiting is temporarily unavailable"); }
}

export class GlobalTokenBucket {
  constructor(
    private readonly redis: GlobalRedisClient,
    private readonly prefix = "gateway:global-rate:v1:",
    /** Test-only clock; production defaults to Redis's clock. */
    private readonly clock?: () => number,
  ) {}

  async check(identity: string, tier: GlobalTier): Promise<GlobalDecision> {
    const capacity = GLOBAL_QUOTAS[tier];
    // Neither route nor tier belongs in the key: rotating either must not
    // create a fresh bucket. Hashing keeps identifiers out of Redis key names.
    const key = this.prefix + createHash("sha256").update(identity).digest("hex");
    let result: unknown;
    try {
      result = await this.redis.eval(
        GLOBAL_TOKEN_BUCKET_LUA, 1, key, capacity, capacity / 60_000,
        this.clock?.() ?? "", 1,
      );
    } catch {
      throw new RateLimitUnavailableError();
    }
    if (!Array.isArray(result) || result.length !== 3 ||
        !result.every((value) => typeof value === "number" && Number.isFinite(value)) ||
        ![0, 1].includes(result[0]) || result[1] < 0 || result[1] > capacity || result[2] < 0) {
      throw new RateLimitUnavailableError();
    }
    const [allowed, remaining, retryMs] = result as [number, number, number];
    const headers: Record<string, string> = {
      "X-RateLimit-Limit": String(capacity),
      "X-RateLimit-Remaining": String(remaining),
    };
    if (!allowed) headers["Retry-After"] = String(Math.max(1, Math.ceil(retryMs / 1000)));
    return { allowed: allowed === 1, tier, headers };
  }
}
