import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { json } from "./http.js";

export const SERVICE_AUTH_HEADER = "x-delego-service-token";

export interface ServiceAuthOptions {
  /** Explicit expected credential. Takes precedence over `envVar` when provided. */
  expectedToken?: string;
  /** Environment variable containing the expected credential. */
  envVar?: string;
}

function resolveExpectedToken(options: ServiceAuthOptions): string | undefined {
  if (options.expectedToken !== undefined) return options.expectedToken;
  if (options.envVar) return process.env[options.envVar];
  return undefined;
}

function tokensMatch(provided: string, expected: string): boolean {
  // Hashing both values gives timingSafeEqual fixed-length inputs, including
  // when the supplied token has a different length from the configured token.
  const providedDigest = createHash("sha256").update(provided, "utf8").digest();
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}

/**
 * Creates middleware that authenticates a backend service using
 * `X-Delego-Service-Token`. Configure an explicit token or name its env var.
 * Missing server configuration fails closed with 503; missing or invalid
 * request credentials fail with 401.
 */
export function requireServiceAuth(
  options: ServiceAuthOptions = {},
): (req: IncomingMessage, res: ServerResponse, next: (err?: any) => void) => void {
  return (req, res, next): void => {
    const expectedToken = resolveExpectedToken(options);
    if (expectedToken === undefined || expectedToken.trim().length === 0) {
      json(res, 503, {
        data: null,
        error: { code: "SERVICE_AUTH_UNAVAILABLE", message: "Service authentication is not configured" },
      });
      return;
    }

    const providedToken = req.headers[SERVICE_AUTH_HEADER];
    if (typeof providedToken !== "string" || providedToken.length === 0 || !tokensMatch(providedToken, expectedToken)) {
      res.setHeader("WWW-Authenticate", "Delego-Service");
      json(res, 401, {
        data: null,
        error: { code: "UNAUTHORIZED", message: "Valid service credentials required" },
      });
      return;
    }

    next();
  };
}
