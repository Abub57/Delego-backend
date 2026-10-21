/**
 * Per-request Sentry error capture for the gateway (Issue #10).
 *
 * The gateway uses the plain node:http router from @delegolabs/utils, which
 * catches handler errors itself and answers 500. There is no framework error
 * hook to register, so errors are captured by wrapping each route handler and
 * middleware: the error is reported with its request context and then handed
 * back to the router, leaving the existing error responses unchanged.
 *
 * When Sentry is not initialised (SENTRY_DSN unset) the wrappers return their
 * input untouched.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import * as Sentry from "@sentry/node";
import type { Route } from "@delegolabs/utils";
import { getRequestContext } from "../../middleware/requestId.js";
import { getAuthenticatedUserContext } from "../../middleware/auth.js";

export interface SentryRequestContext {
  requestId?: string;
  userId?: string;
}

type Middleware = (
  req: IncomingMessage,
  res: ServerResponse,
  next: (err?: any) => void
) => void | Promise<void>;

/** Request ID and authenticated user ID for the given request, when known. */
export function resolveRequestContext(req: IncomingMessage): SentryRequestContext {
  const requestCtx = getRequestContext(req);
  return {
    requestId: requestCtx?.requestId,
    userId: getAuthenticatedUserContext(req)?.userId ?? requestCtx?.userId,
  };
}

/**
 * Reports an error with its request context. The context is passed as the
 * event's capture context rather than set on a shared scope, so it can never
 * leak into events from other concurrent requests.
 */
export function captureRequestError(err: unknown, req: IncomingMessage): void {
  const { requestId, userId } = resolveRequestContext(req);
  Sentry.captureException(err, {
    tags: {
      ...(requestId ? { request_id: requestId } : {}),
      http_method: req.method ?? "GET",
    },
    ...(userId ? { user: { id: userId } } : {}),
  });
}

/** Wraps route handlers so thrown errors are reported, then re-thrown. */
export function withSentryRoutes(routes: Route[]): Route[] {
  if (!Sentry.isInitialized()) return routes;
  return routes.map((r) => ({
    ...r,
    handler: async (req, res, params) => {
      try {
        await r.handler(req, res, params);
      } catch (err) {
        captureRequestError(err, req);
        throw err;
      }
    },
  }));
}

/**
 * Wraps middleware so errors are reported, whether thrown or passed to
 * `next(err)`, then handed on unchanged.
 */
export function withSentryMiddleware(middleware: Middleware[]): Middleware[] {
  if (!Sentry.isInitialized()) return middleware;
  return middleware.map((mw) => async (req, res, next) => {
    try {
      await mw(req, res, (err?: unknown) => {
        if (err) captureRequestError(err, req);
        return next(err);
      });
    } catch (err) {
      captureRequestError(err, req);
      throw err;
    }
  });
}
