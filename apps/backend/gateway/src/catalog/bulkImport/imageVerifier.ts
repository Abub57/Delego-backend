import { safeHttpsRequest } from "./safeFetch.js";

export interface ImageVerifier {
  /** Resolves to null when the URL serves an image, otherwise a human-readable reason. */
  verify(url: string): Promise<string | null>;
}

type Requester = typeof safeHttpsRequest;

/**
 * Confirms an image URL is reachable and serves `image/*` content.
 *
 * Tries HEAD first, falling back to a one-byte ranged GET for hosts that
 * reject HEAD. Results are memoized per verifier instance (one per import
 * job) since catalogs often reuse the same image across variants.
 */
export class HttpImageVerifier implements ImageVerifier {
  private readonly cache = new Map<string, Promise<string | null>>();

  constructor(
    private readonly timeoutMs = 5_000,
    private readonly request: Requester = safeHttpsRequest,
  ) {}

  verify(url: string): Promise<string | null> {
    let pending = this.cache.get(url);
    if (!pending) {
      pending = this.check(url);
      this.cache.set(url, pending);
    }
    return pending;
  }

  private async check(url: string): Promise<string | null> {
    try {
      let response = await this.request(url, { method: "HEAD", timeoutMs: this.timeoutMs });
      response.resume();

      if (response.statusCode === 405 || response.statusCode === 501) {
        response = await this.request(url, {
          method: "GET",
          headers: { Range: "bytes=0-0" },
          timeoutMs: this.timeoutMs,
        });
        response.destroy();
      }

      const status = response.statusCode ?? 0;
      if (status < 200 || status >= 300) {
        return `image_url returned HTTP ${status}`;
      }
      const contentType = String(response.headers["content-type"] ?? "");
      if (!contentType.toLowerCase().startsWith("image/")) {
        return `image_url is not an image (content-type: ${contentType || "unknown"})`;
      }
      return null;
    } catch (err) {
      return `image_url could not be fetched: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}
