import type { IncomingMessage } from "node:http";
import { verifyToken } from "../src/auth/authService.js";
import { isTokenRevokedSync } from "../src/auth/tokenBlacklist.js";
import {
  resolveMerchantTeamPermissions,
  type MerchantTeamPermission,
} from "../src/auth/permissions.js";

export interface AuthContext {
  userId: string | null;
  token: string | null;
}

export interface AuthenticatedUserContext {
  userId: string;
  email: string;
  roles: string[];
  /** Merchant-team permissions resolved from the token's role/permission claims. */
  permissions: MerchantTeamPermission[];
}

const authenticatedUserContexts = new WeakMap<IncomingMessage, AuthenticatedUserContext>();

/**
 * Retrieve the typed authenticated-user context populated by extractAuth(),
 * instead of reading ad-hoc properties off the request.
 */
export function getAuthenticatedUserContext(req: IncomingMessage): AuthenticatedUserContext | undefined {
  return authenticatedUserContexts.get(req);
}

/**
 * Extract auth context from request headers.
 *
 * Verifies the Bearer token signature and rejects tokens that were revoked
 * on this instance (in-memory blacklist, O(1) — no I/O, < 10ms).
 */
export function extractAuth(req: IncomingMessage): AuthContext {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return { userId: null, token: null };
  }

  const token = authHeader.slice(7);
  try {
    const decoded = verifyToken(token);
    if (decoded.jti && isTokenRevokedSync(decoded.jti)) {
      return { userId: null, token: null };
    }
    authenticatedUserContexts.set(req, {
      userId: decoded.userId,
      email: decoded.email ?? "",
      roles: decoded.roles ?? [],
      permissions: resolveMerchantTeamPermissions({
        roles: decoded.roles,
        permissions: decoded.permissions,
      }),
    });
    return { userId: decoded.userId, token };
  } catch (err) {
    return { userId: null, token: null };
  }
}

