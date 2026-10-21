import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { correlationMiddleware } from "./correlation.js";
import { withServerSpan } from "./telemetry/propagation.js";

// ─── Request body size limiting ────────────────────────────────────────────

/** Default cap for `readBodyWithLimit` — 1 MiB. */
export const DEFAULT_BODY_SIZE_LIMIT_BYTES = 1024 * 1024;

/**
 * Thrown by `readBodyWithLimit` when the request body exceeds the configured
 * limit. Callers should catch this specifically (via `instanceof`) and
 * respond 413 Payload Too Large — see wallet/payments `readJsonBody` and
 * notifications `readBody` for the reference wiring.
 */
export class PayloadTooLargeError extends Error {
  readonly limitBytes: number;

  constructor(limitBytes: number) {
    super(`Request body exceeds the ${limitBytes}-byte limit`);
    this.name = "PayloadTooLargeError";
    this.limitBytes = limitBytes;
  }
}

/**
 * Reads the raw request body, rejecting with `PayloadTooLargeError` as soon
 * as more than `limitBytes` have been read — the check happens per-chunk so
 * an oversized body is rejected without buffering the whole thing in memory.
 */
export function readBodyWithLimit(
  req: IncomingMessage,
  limitBytes: number = DEFAULT_BODY_SIZE_LIMIT_BYTES
): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    let bytesRead = 0;
    let rejected = false;

    req.on("data", (chunk: Buffer | string) => {
      if (rejected) return;

      bytesRead += Buffer.byteLength(chunk);
      if (bytesRead > limitBytes) {
        rejected = true;
        reject(new PayloadTooLargeError(limitBytes));
        req.removeAllListeners("data");
        req.removeAllListeners("end");
        return;
      }

      body += chunk;
    });

    req.on("end", () => {
      if (!rejected) resolve(body);
    });

    req.on("error", (err) => {
      if (!rejected) reject(err);
    });
  });
}

export type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>
) => void | Promise<void>;

export interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: RouteHandler;
}

export interface HttpServerOptions {
  port: number;
  host?: string;
  serviceName: string;
  version?: string;
  routes?: Route[];
  middleware?: Array<(req: IncomingMessage, res: ServerResponse, next: (err?: any) => void) => void | Promise<void>>;
}

function matchRoute(
  routes: Route[],
  method: string,
  pathname: string
): { route: Route; params: Record<string, string> } | null {
  for (const route of routes) {
    if (route.method !== method) continue;
    const match = pathname.match(route.pattern);
    if (!match) continue;
    const params: Record<string, string> = {};
    route.paramNames.forEach((name, i) => {
      params[name] = match[i + 1] ?? "";
    });
    return { route, params };
  }
  return null;
}

export function route(
  method: string,
  path: string,
  handler: RouteHandler
): Route {
  const paramNames: string[] = [];
  const pattern = new RegExp(
    "^" +
      path.replace(/:([a-zA-Z]+)/g, (_, name) => {
        paramNames.push(name);
        return "([^/]+)";
      }) +
      "$"
  );
  return { method, pattern, paramNames, handler };
}

export function json(
  res: ServerResponse,
  status: number,
  body: unknown
): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

export function startHttpServer(options: HttpServerOptions): Server {
  const { port, host = "0.0.0.0", serviceName, version = "0.0.1", routes = [] } =
    options;

  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`).pathname;
    // Continues the caller's trace (traceparent) when a global tracer is set.
    return withServerSpan(req, res, pathname, () => handleRequest(req, res, pathname));
  });

  const handleRequest = async (req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> => {

    const middlewares = [correlationMiddleware, ...(options.middleware ?? [])];
    let index = 0;

    const next = async (err?: any) => {
      if (err) {
        json(res, 500, {
          data: null,
          error: {
            code: "INTERNAL_ERROR",
            message: err instanceof Error ? err.message : "Unknown error",
          },
        });
        return;
      }

      if (index < middlewares.length) {
        const mw = middlewares[index++];
        try {
          await mw(req, res, next);
        } catch (mwErr) {
          await next(mwErr);
        }
      } else {
        const matched = matchRoute(routes, req.method ?? "GET", pathname);
        if (matched) {
          try {
            await matched.route.handler(req, res, matched.params);
          } catch (err) {
            if (err instanceof PayloadTooLargeError) {
              json(res, 413, {
                data: null,
                error: { code: "PAYLOAD_TOO_LARGE", message: err.message },
              });
              return;
            }
            json(res, 500, {
              data: null,
              error: {
                code: "INTERNAL_ERROR",
                message: err instanceof Error ? err.message : "Unknown error",
              },
            });
          }
          return;
        }

        if (req.method === "GET" && pathname === "/health") {
          json(res, 200, {
            data: {
              status: "ok",
              service: serviceName,
              version,
              timestamp: new Date().toISOString(),
            },
            error: null,
          });
          return;
        }

        json(res, 404, {
          data: null,
          error: { code: "NOT_FOUND", message: `Route not found: ${pathname}` },
        });
      }
    };

    await next();
  };

  server.listen(port, host, () => {
    // eslint-disable-next-line no-console
    console.log(`[${serviceName}] listening on ${host}:${port}`);
  });

  return server;
}

