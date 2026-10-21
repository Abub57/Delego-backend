/**
 * SSRF defense for outbound webhook deliveries (Issue #348).
 *
 * Merchants can specify arbitrary webhook callback URLs. Without this
 * guard, a malicious merchant could point a webhook at a private VPC
 * address (`http://10.0.0.1`) or a cloud metadata endpoint
 * (`http://169.254.169.254`) and use Delego's own servers to probe
 * internal network/cluster endpoints on their behalf.
 *
 * This module is used from the actual HTTP send path (bullQueue.ts), not
 * just at webhook registration time, because:
 *   - A hostname that resolves safely at registration time can later be
 *     repointed at a private address (DNS rebinding) — so validation has
 *     to happen right before each send, against a freshly resolved IP.
 *   - That same resolved IP is then pinned for the actual TCP connection
 *     (see createPinnedLookup / postJsonWithPinnedIp), so a second DNS
 *     lookup performed by the HTTP client at connect time can't be used
 *     to swap in a different (malicious) address after validation passed.
 */

import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import type { LookupAddress } from "node:dns";

export interface WebhookValidationResult {
  isValid: boolean;
  ipAddress?: string;
  reason?: "private_ip" | "loopback" | "unsupported_protocol" | "dns_resolution_failed";
}

/**
 * RFC 1918 private ranges, loopback, link-local (which includes the
 * 169.254.169.254 cloud-metadata address shared by AWS/GCP/Azure), and a
 * handful of other reserved/special-use IPv4 ranges that a webhook target
 * must never resolve to.
 */
function isPrivateOrReservedIPv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    // Not a well-formed IPv4 literal — fail closed rather than let an
    // unparsable address through.
    return true;
  }
  const [a, b] = parts;

  if (a === 127) return true; // 127.0.0.0/8 — loopback
  if (a === 10) return true; // 10.0.0.0/8 — private
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 — private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 — private
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 — link-local + cloud metadata
  if (a === 0) return true; // 0.0.0.0/8 — "this network"
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 — shared/CGNAT address space
  if (a === 198 && b === 18) return true; // 198.18.0.0/15 — benchmarking
  if (a >= 224) return true; // 224.0.0.0+ — multicast and reserved

  return false;
}

/** Loopback, link-local, and unique-local IPv6 ranges, plus IPv4-mapped addresses. */
function isPrivateOrReservedIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase();

  if (normalized === "::1" || normalized === "::") return true; // loopback / unspecified
  if (/^fe[89ab][0-9a-f]:/.test(normalized)) return true; // fe80::/10 — link-local
  if (/^f[cd][0-9a-f]{2}:/.test(normalized)) return true; // fc00::/7 — unique local

  // IPv4-mapped IPv6 (::ffff:a.b.c.d) — unwrap and re-check as IPv4.
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateOrReservedIPv4(mapped[1]);

  return false;
}

export function isPrivateOrReservedIp(ip: string, family: 4 | 6): boolean {
  return family === 4 ? isPrivateOrReservedIPv4(ip) : isPrivateOrReservedIPv6(ip);
}

/**
 * Resolves `rawUrl`'s hostname and checks the result against the
 * private/loopback/link-local ranges above. Must be called immediately
 * before each delivery attempt — see the module doc for why.
 */
export async function validateWebhookUrl(rawUrl: string): Promise<WebhookValidationResult> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { isValid: false, reason: "unsupported_protocol" };
  }

  // Enforce HTTPS exclusively — plaintext HTTP both leaks the HMAC-signed
  // payload on the wire and makes it trivial to redirect a webhook to an
  // internal service that doesn't speak TLS.
  if (parsed.protocol !== "https:") {
    return { isValid: false, reason: "unsupported_protocol" };
  }

  let resolved: LookupAddress;
  try {
    resolved = await dnsLookup(parsed.hostname);
  } catch {
    return { isValid: false, reason: "dns_resolution_failed" };
  }

  const { address, family } = resolved;

  if (
    (family === 4 && (address === "127.0.0.1" || address.startsWith("127."))) ||
    (family === 6 && address === "::1")
  ) {
    return { isValid: false, ipAddress: address, reason: "loopback" };
  }

  if (isPrivateOrReservedIp(address, family as 4 | 6)) {
    return { isValid: false, ipAddress: address, reason: "private_ip" };
  }

  return { isValid: true, ipAddress: address };
}

/**
 * Builds a `lookup` function for Node's `http(s).request` options that
 * always resolves to `pinnedIp`, ignoring whatever DNS answers at connect
 * time. This is what actually defeats DNS rebinding: `validateWebhookUrl`
 * resolves and checks an address once, and the TCP connection is forced
 * to use that exact address rather than re-resolving the hostname (and
 * potentially getting a different, attacker-controlled answer) when the
 * request is actually sent.
 */
export function createPinnedLookup(pinnedIp: string, family: 4 | 6) {
  return (
    _hostname: string,
    _options: unknown,
    callback: (err: NodeJS.ErrnoException | null, address: string, family: number) => void,
  ): void => {
    callback(null, pinnedIp, family);
  };
}

export interface SsrfSafePostResult {
  status: number;
  statusText: string;
  body: string;
}

/**
 * POSTs `body` to `url` over HTTPS, with the TCP connection pinned to
 * `validation.ipAddress` (see createPinnedLookup). TLS SNI/hostname
 * verification still uses the real hostname, so certificate validation is
 * unaffected — only the destination socket address is pinned.
 */
export function postJsonWithPinnedIp(
  url: URL,
  validation: WebhookValidationResult,
  body: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<SsrfSafePostResult> {
  if (!validation.isValid || !validation.ipAddress) {
    return Promise.reject(new Error("Refusing to send: webhook URL failed SSRF validation"));
  }

  const family = validation.ipAddress.includes(":") ? 6 : 4;
  const lookup = createPinnedLookup(validation.ipAddress, family);
  const payload = Buffer.from(body, "utf8");

  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        hostname: url.hostname,
        servername: url.hostname,
        port: url.port ? Number(url.port) : 443,
        path: `${url.pathname}${url.search}`,
        method: "POST",
        headers: { ...headers, "Content-Length": String(payload.byteLength) },
        lookup: lookup as unknown as never,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            statusText: res.statusMessage ?? "",
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
        res.on("error", reject);
      },
    );

    req.on("timeout", () => req.destroy(new Error(`Webhook request timed out after ${timeoutMs}ms`)));
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}
