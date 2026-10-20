import type { IncomingMessage, ServerResponse } from "node:http";
import { isIPv4, isIPv6 } from "node:net";
import { json } from "@delegolabs/utils";
import { resolveTier } from "../src/rateLimit/tokenBucket/tierResolver.js";
import { resolveTenantTier } from "../src/rateLimit/tenantTiers.js";
import { TenantRateLimiter } from "../src/rateLimit/tenantRateLimiter.js";
import { extractAuth, getAuthenticatedUserContext } from "./auth.js";
import type { RateLimitConfig as LegacyRateLimitConfig } from "../src/rateLimit/types.js";
import { checkRateLimit as legacyCheckRateLimit } from "../src/rateLimit/rateLimiter.js";
import { GlobalTokenBucket, RateLimitUnavailableError, resolveGlobalTier } from "../src/rateLimit/globalTokenBucket.js";
import { getGlobalRateLimiter } from "../src/rateLimit/globalRedis.js";
import { ENDPOINT_OVERRIDES } from "../src/rateLimit/tokenBucket/tierConfig.js";
import { recordRateLimitOutcome } from "../src/rateLimit/tokenBucket/metrics.js";

// ---------------------------------------------------------------------------
// Trusted proxy resolution (Issue #354)
//
// `X-Forwarded-For` is a client-controlled header. Trusting its leftmost
// entry unconditionally lets any caller spoof an arbitrary IP and rotate it
// per-request to dodge the rate-limit bucket keyed on `getIdentifier`.
//
// Fix: only consult `X-Forwarded-For` when the *direct* TCP peer
// (`req.socket.remoteAddress`) is a known/trusted reverse proxy — configured
// via `TRUSTED_PROXY_CIDRS` (comma-separated CIDRs). When trusted, use the
// right-most entry in the header: that value was appended by the trusted
// proxy itself from the socket it saw the request on, so it reflects the
// real peer and cannot be forged by the client. Untrusted peers always get
// their own socket address — their headers are ignored entirely.
// ---------------------------------------------------------------------------

/** Private/in-VPC ranges a load balancer or reverse proxy commonly sits in. */
const DEFAULT_TRUSTED_PROXY_CIDRS = [
  "127.0.0.1/32",
  "::1/128",
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
];

function parseTrustedProxyCidrs(): string[] {
  const raw = process.env.TRUSTED_PROXY_CIDRS;
  if (!raw || raw.trim().length === 0) {
    return DEFAULT_TRUSTED_PROXY_CIDRS;
  }
  return raw
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

const TRUSTED_PROXY_CIDRS = parseTrustedProxyCidrs();

function stripIPv4MappedPrefix(ip: string): string {
  return ip.startsWith("::ffff:") ? ip.slice(7) : ip;
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    result = (result << 8) | n;
  }
  return result >>> 0;
}

function ipv6ToBigInt(ip: string): bigint | null {
  if (!isIPv6(ip)) return null;
  let groups: string[];
  if (ip.includes("::")) {
    const [head, tail] = ip.split("::");
    const headParts = head ? head.split(":") : [];
    const tailParts = tail ? tail.split(":") : [];
    const missing = 8 - headParts.length - tailParts.length;
    if (missing < 0) return null;
    groups = [...headParts, ...Array(missing).fill("0"), ...tailParts];
  } else {
    groups = ip.split(":");
  }
  if (groups.length !== 8) return null;
  let result = 0n;
  for (const g of groups) {
    const n = g === "" ? 0 : parseInt(g, 16);
    if (Number.isNaN(n)) return null;
    result = (result << 16n) | BigInt(n);
  }
  return result;
}

function isIpInCidr(ip: string, cidr: string): boolean {
  const [range, bitsStr] = cidr.split("/");
  const bits = Number(bitsStr);
  const normalizedIp = stripIPv4MappedPrefix(ip);

  if (isIPv4(normalizedIp) && isIPv4(range)) {
    const ipInt = ipv4ToInt(normalizedIp);
    const rangeInt = ipv4ToInt(range);
    if (ipInt === null || rangeInt === null) return false;
    const mask = bits >= 32 ? 0xffffffff : bits <= 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (ipInt & mask) >>> 0 === (rangeInt & mask) >>> 0;
  }

  if (isIPv6(normalizedIp) && isIPv6(range)) {
    const ipBig = ipv6ToBigInt(normalizedIp);
    const rangeBig = ipv6ToBigInt(range);
    if (ipBig === null || rangeBig === null) return false;
    const full = (1n << 128n) - 1n;
    const maskBits = BigInt(Math.min(Math.max(bits, 0), 128));
    const mask = maskBits === 0n ? 0n : (full << (128n - maskBits)) & full;
    return (ipBig & mask) === (rangeBig & mask);
  }

  return false;
}

/** Whether `ip` (the direct TCP peer) is a configured trusted reverse proxy. */
export function isTrustedProxyAddress(ip: string | undefined | null): boolean {
  if (!ip) return false;
  return TRUSTED_PROXY_CIDRS.some((cidr) => isIpInCidr(ip, cidr));
}

function parseForwardedForChain(req: IncomingMessage): string[] {
  const forwarded = req.headers["x-forwarded-for"];
  const raw = Array.isArray(forwarded) ? forwarded.join(",") : forwarded ?? "";
  return raw
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

function getIdentifier(req: IncomingMessage): string {
  const auth = extractAuth(req);
  if (auth.userId) {
    return auth.userId;
  }

  const socketIp = req.socket.remoteAddress ?? undefined;

  // Only honor X-Forwarded-For when it was appended by a trusted proxy —
  // otherwise it is attacker-controlled and must be ignored.
  if (isTrustedProxyAddress(socketIp)) {
    const chain = parseForwardedForChain(req);
    if (chain.length > 0) {
      // Right-most entry reflects the socket the trusted proxy itself saw.
      return chain[chain.length - 1];
    }
  }

  return socketIp ?? "unknown";
}

function getEndpoint(req: IncomingMessage): { method: string; path: string } {
  const method = (req.method ?? "GET").toUpperCase();
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  return { method, path: url.pathname };
}

export interface RateLimitMiddlewareOptions {
  /** Explicit legacy sliding-window adapter retained for existing integrations. */
  tenantLimiter?: TenantRateLimiter;
  globalLimiter?: GlobalTokenBucket;
}

/**
 * Tiered rate limiting (Issue #309).
 *
 * Global Redis token buckets admit Free 60, Verified 600 and Enterprise 3000
 * tokens, replenished continuously over a minute without extra burst allowance.
 * Sensitive auth routes retain their additional tighter sliding-window limits.
 * Responses carry `X-RateLimit-Limit`,
 * `X-RateLimit-Remaining`, and (on HTTP 429) an exact `Retry-After` in
 * seconds. Internal service-to-service callers stay exempt, and the legacy
 * `{ maxRequests, windowMs }` override still uses the fixed-window limiter.
 *
 * `getIdentifier` calls `extractAuth` first so tier resolution (which reads
 * the authenticated-user context `extractAuth` populates) sees the caller's
 * verified roles rather than defaulting everyone to "free".
 */
export function rateLimitMiddleware(
  overrideConfig?: LegacyRateLimitConfig,
  options: RateLimitMiddlewareOptions = {}
) {
  let tenantLimiter = options.tenantLimiter;
  let globalLimiter = options.globalLimiter;
  return async (
    req: IncomingMessage,
    res: ServerResponse,
    next: (err?: any) => void
  ): Promise<void> => {
    try {
      const { method, path } = getEndpoint(req);
      if (method === "GET" && path === "/health") {
        next();
        return;
      }

      const identifier = getIdentifier(req);

      if (overrideConfig) {
        const legacyResult = await legacyCheckRateLimit(
          identifier,
          `${method}:${path}`,
          overrideConfig,
        );

        res.setHeader("RateLimit-Limit", legacyResult.limit);
        res.setHeader("RateLimit-Remaining", legacyResult.remaining);
        res.setHeader("RateLimit-Reset", legacyResult.resetInSeconds);

        if (!legacyResult.allowed) {
          res.setHeader("Retry-After", legacyResult.resetInSeconds);
          json(res, 429, {
            data: null,
            error: {
              code: "RATE_LIMIT_EXCEEDED",
              message: `Rate limit exceeded. Please retry after ${legacyResult.resetInSeconds} seconds.`,
            },
          });
          return;
        }

        next();
        return;
      }

      // Internal service-to-service callers are exempt from tenant limits.
      if (resolveTier(req) === "internal") {
        next();
        return;
      }

      let decision;
      if (options.tenantLimiter) {
        const tier = resolveTenantTier(getAuthenticatedUserContext(req)?.roles);
        decision = await options.tenantLimiter.check(identifier, tier, { endpoint: path, method });
      } else {
        const context = getAuthenticatedUserContext(req);
        globalLimiter ??= getGlobalRateLimiter();
        decision = await globalLimiter.check(
          `${context ? "user" : "ip"}:${identifier}`, resolveGlobalTier(context?.roles),
        );
        recordRateLimitOutcome(`${identifier}:global`, decision.allowed);
        if (decision.allowed && ENDPOINT_OVERRIDES[`${method}:${path}`]) {
          tenantLimiter ??= new TenantRateLimiter();
          const sensitive = await tenantLimiter.check(identifier, "free", { endpoint: path, method });
          if (!sensitive.allowed) decision = sensitive;
        }
      }

      for (const [name, value] of Object.entries(decision.headers)) {
        res.setHeader(name, value);
      }

      if (!decision.allowed) {
        json(res, 429, {
          data: null,
          error: {
            code: "RATE_LIMIT_EXCEEDED",
            message: `Rate limit exceeded for tier "${decision.tier}". Please retry after ${decision.headers["Retry-After"]} seconds.`,
          },
        });
        return;
      }

      next();
    } catch (err) {
      if (err instanceof RateLimitUnavailableError) {
        res.setHeader("Retry-After", "1");
        json(res, 503, { data: null, error: { code: "RATE_LIMIT_UNAVAILABLE", message: err.message } });
        return;
      }
      next(err);
    }
  };
}
