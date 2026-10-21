/**
 * Outbound HTTPS requests to merchant-supplied URLs (CSV files, product
 * images). Reuses the webhook SSRF guard: the hostname is resolved once,
 * private/loopback targets are rejected, and the TCP connection is pinned
 * to the validated IP so DNS rebinding can't redirect it. Redirects are not
 * followed for the same reason.
 */

import { request as httpsRequest } from "node:https";
import type { IncomingMessage } from "node:http";
import {
  createPinnedLookup,
  validateWebhookUrl,
} from "../../../../notifications/webhooks/ssrfGuard.js";

export class UnsafeUrlError extends Error {
  constructor(url: string, reason: string | undefined) {
    super(`Refusing to fetch ${url}: ${reason ?? "failed validation"}`);
    this.name = "UnsafeUrlError";
  }
}

export interface SafeRequestOptions {
  method?: "GET" | "HEAD";
  headers?: Record<string, string>;
  timeoutMs: number;
}

/** Resolves with the response stream once headers arrive; the caller consumes or destroys it. */
export async function safeHttpsRequest(
  rawUrl: string,
  options: SafeRequestOptions,
): Promise<IncomingMessage> {
  const validation = await validateWebhookUrl(rawUrl);
  if (!validation.isValid || !validation.ipAddress) {
    throw new UnsafeUrlError(rawUrl, validation.reason);
  }

  const url = new URL(rawUrl);
  const family = validation.ipAddress.includes(":") ? 6 : 4;

  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        hostname: url.hostname,
        servername: url.hostname,
        port: url.port ? Number(url.port) : 443,
        path: `${url.pathname}${url.search}`,
        method: options.method ?? "GET",
        headers: options.headers,
        lookup: createPinnedLookup(validation.ipAddress!, family),
      },
      resolve,
    );
    req.setTimeout(options.timeoutMs, () => {
      req.destroy(new Error(`Request to ${url.hostname} timed out after ${options.timeoutMs}ms`));
    });
    req.on("error", reject);
    req.end();
  });
}
