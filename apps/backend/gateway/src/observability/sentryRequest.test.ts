/**
 * Tests for per-request Sentry error capture (Issue #10).
 *
 * Runs a real gateway router on an ephemeral port with @sentry/node mocked,
 * so no events or network calls leave the process.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import * as Sentry from "@sentry/node";
import { route, startHttpServer } from "@delegolabs/utils";
import { requestIdMiddleware } from "../../middleware/requestId.js";
import { withSentryMiddleware, withSentryRoutes } from "./sentryRequest.js";

vi.mock("@sentry/node", () => ({
  captureException: vi.fn(),
  isInitialized: vi.fn(() => true),
}));

// Stand-in for extractAuth(): the test marks a request as authenticated via a header.
vi.mock("../../middleware/auth.js", () => ({
  getAuthenticatedUserContext: (req: IncomingMessage) => {
    const userId = req.headers["x-test-user"];
    return typeof userId === "string" ? { userId, email: "", roles: [], permissions: [] } : undefined;
  },
}));

type Middleware = (req: IncomingMessage, res: ServerResponse, next: (err?: any) => void) => void | Promise<void>;

let server: Server | undefined;

function start(middleware: Middleware[], routes = defaultRoutes()): Promise<string> {
  return new Promise((resolve) => {
    server = startHttpServer({
      port: 0,
      host: "127.0.0.1",
      serviceName: "gateway-test",
      middleware: withSentryMiddleware([requestIdMiddleware(), ...middleware]),
      routes: withSentryRoutes(routes),
    });
    server.once("listening", () => {
      resolve(`http://127.0.0.1:${(server!.address() as AddressInfo).port}`);
    });
  });
}

function defaultRoutes() {
  return [
    route("GET", "/boom", async () => {
      await new Promise((r) => setTimeout(r, 5));
      throw new Error("boom");
    }),
    route("GET", "/ok", (_req, res) => {
      res.writeHead(200);
      res.end("ok");
    }),
  ];
}

beforeEach(() => {
  vi.mocked(Sentry.captureException).mockClear();
  vi.mocked(Sentry.isInitialized).mockReturnValue(true);
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

describe("withSentryRoutes", () => {
  it("captures route errors with the request ID and user ID and keeps the error response", async () => {
    const base = await start([]);

    const res = await fetch(`${base}/boom`, {
      headers: { "x-request-id": "req-123", "x-test-user": "user-42" },
    });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      data: null,
      error: { code: "INTERNAL_ERROR", message: "boom" },
    });
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    const [err, context] = vi.mocked(Sentry.captureException).mock.calls[0];
    expect((err as Error).message).toBe("boom");
    expect(context).toEqual({
      tags: { request_id: "req-123", http_method: "GET" },
      user: { id: "user-42" },
    });
  });

  it("omits the user for unauthenticated requests", async () => {
    const base = await start([]);

    await fetch(`${base}/boom`, { headers: { "x-request-id": "req-anon" } });

    const [, context] = vi.mocked(Sentry.captureException).mock.calls[0];
    expect(context).toEqual({ tags: { request_id: "req-anon", http_method: "GET" } });
  });

  it("keeps request context separate across concurrent requests", async () => {
    const base = await start([]);

    await Promise.all(
      ["a", "b", "c"].map((id) =>
        fetch(`${base}/boom`, { headers: { "x-request-id": `req-${id}`, "x-test-user": `user-${id}` } })
      )
    );

    const contexts = vi
      .mocked(Sentry.captureException)
      .mock.calls.map(([, context]) => context as { tags: { request_id: string }; user: { id: string } });
    expect(contexts).toHaveLength(3);
    for (const context of contexts) {
      expect(context.user.id).toBe(context.tags.request_id.replace("req-", "user-"));
    }
  });

  it("does not capture successful requests", async () => {
    const base = await start([]);

    const res = await fetch(`${base}/ok`);

    expect(res.status).toBe(200);
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it("returns routes unchanged when Sentry is not initialised", () => {
    vi.mocked(Sentry.isInitialized).mockReturnValue(false);
    const routes = defaultRoutes();

    expect(withSentryRoutes(routes)).toBe(routes);
  });
});

describe("withSentryMiddleware", () => {
  it("captures errors thrown by middleware", async () => {
    const base = await start([
      () => {
        throw new Error("mw thrown");
      },
    ]);

    const res = await fetch(`${base}/ok`, { headers: { "x-request-id": "req-mw" } });

    expect(res.status).toBe(500);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    const [err, context] = vi.mocked(Sentry.captureException).mock.calls[0];
    expect((err as Error).message).toBe("mw thrown");
    expect(context).toMatchObject({ tags: { request_id: "req-mw" } });
  });

  it("captures errors passed to next(err)", async () => {
    const base = await start([(_req, _res, next) => next(new Error("mw next"))]);

    const res = await fetch(`${base}/ok`);

    expect(res.status).toBe(500);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect((vi.mocked(Sentry.captureException).mock.calls[0][0] as Error).message).toBe("mw next");
  });

  it("returns middleware unchanged when Sentry is not initialised", () => {
    vi.mocked(Sentry.isInitialized).mockReturnValue(false);
    const middleware = [requestIdMiddleware()];

    expect(withSentryMiddleware(middleware)).toBe(middleware);
  });
});
