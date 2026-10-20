/**
 * Granular merchant-team permission middleware (Issue #383).
 *
 * `requirePermission()` is an Express-compatible guard: it reads the
 * authenticated-user context populated by `extractAuth()`, checks the
 * permissions resolved from the JWT claims, and rejects with the gateway's
 * standard error envelope (401 when unauthenticated, 403 when under-privileged).
 *
 * The gateway's HTTP server registers routes through `route(method, path,
 * handler)` where `handler` is a `RouteHandler` (no `next`). `guardPermission()`
 * adapts the middleware to that contract so a single route can be guarded:
 *
 * ```ts
 * route("POST", "/api/v1/storage/presigned-url", guardPermission("catalog:write", handler));
 * ```
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { RouteHandler } from "@delegolabs/utils";
import { extractAuth, getAuthenticatedUserContext } from "./auth.js";
import { forbidden, unauthorized } from "../src/errors.js";
import {
  hasMerchantTeamPermission,
  type MerchantTeamPermission,
} from "../src/auth/permissions.js";

/** `next` callback shape shared with the gateway's HTTP middleware pipeline. */
export type PermissionNext = (err?: unknown) => void;

/** Express-compatible middleware returned by {@link requirePermission}. */
export type PermissionMiddleware = (
  req: IncomingMessage,
  res: ServerResponse,
  next: PermissionNext,
) => Promise<void>;

/**
 * Require the authenticated caller to hold `permission`.
 *
 * - 401 `UNAUTHORIZED` when the request carries no valid Bearer token.
 * - 403 `FORBIDDEN` when authenticated but the JWT claims grant no such permission.
 */
export function requirePermission(permission: MerchantTeamPermission): PermissionMiddleware {
  return async (req, res, next) => {
    const auth = extractAuth(req);
    if (!auth.userId) {
      unauthorized(res, "Authentication required", req);
      return;
    }

    const context = getAuthenticatedUserContext(req);
    const granted = hasMerchantTeamPermission(
      { roles: context?.roles, permissions: context?.permissions },
      permission,
    );

    if (!granted) {
      forbidden(res, `Missing required permission: ${permission}`, req);
      return;
    }

    next();
  };
}

/**
 * Wrap a route handler with a permission guard, adapting the middleware to the
 * gateway's `RouteHandler` contract so it can be passed directly to `route()`.
 */
export function guardPermission(
  permission: MerchantTeamPermission,
  handler: RouteHandler,
): RouteHandler {
  const middleware = requirePermission(permission);
  return async (req, res, params) => {
    // `requirePermission` is Express-style: on a 401/403 it writes the error
    // response and returns *without* invoking `next`. Resolving only from the
    // `next` callback therefore left this promise pending forever on every
    // rejected request, even though a response had already been sent. Waiting
    // on the middleware and recording whether it handed off settles both paths.
    let handedOff = false;
    let nextError: unknown;
    await middleware(req, res, (err) => {
      if (err) {
        nextError = err;
        return;
      }
      handedOff = true;
    });

    if (nextError) {
      throw nextError instanceof Error ? nextError : new Error(String(nextError));
    }
    if (!handedOff) return;

    await handler(req, res, params);
  };
}
