/**
 * Passkey / WebAuthn routes — Issue #367
 *
 *   POST /api/v1/auth/passkeys/register/begin
 *   POST /api/v1/auth/passkeys/register/complete
 *   POST /api/v1/auth/passkeys/authenticate/begin
 *   POST /api/v1/auth/passkeys/authenticate/complete
 *   GET  /api/v1/auth/passkeys
 *   PATCH/DELETE /api/v1/auth/passkeys/:credentialId
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { generateId, json } from "@delegolabs/utils";
import { issueTokenPair } from "../src/auth/tokenManager.js";
import { User } from "../src/models/User.js";
import { PasskeyError } from "../src/auth/passkeyTypes.js";
import {
  beginPasskeyAuthentication,
  beginPasskeyRegistration,
  completePasskeyAuthentication,
  completePasskeyRegistration,
  deletePasskey,
  listPasskeys,
  renamePasskey,
} from "../src/auth/passkeyService.js";
import { readJsonBody } from "../src/request.js";
import { badRequest, notFound, sendApiError, unauthorized } from "../src/errors.js";
import { getRequestContext } from "../middleware/requestId.js";
import { getAuthenticatedUserContext } from "../middleware/auth.js";

/** Map a PasskeyError onto the right HTTP status. */
function handlePasskeyError(res: ServerResponse, err: unknown): void {
  if (!(err instanceof PasskeyError)) {
    sendApiError(res, 500, "INTERNAL_ERROR", "Passkey operation failed");
    return;
  }

  const status =
    err.code === "user_not_found"
      ? 404
      : err.code === "credential_not_found"
        ? 404
        : err.code === "config_error"
          ? 500
          : 400;

  const code =
    err.code === "user_not_found" || err.code === "credential_not_found"
      ? "NOT_FOUND"
      : err.code === "config_error"
        ? "INTERNAL_ERROR"
        : "VALIDATION_ERROR";

  sendApiError(res, status, code, err.message);
}

function resolveRequestId(req: IncomingMessage): string {
  return getRequestContext(req)?.requestId ?? generateId();
}

function requireUser(req: IncomingMessage): { userId: string; email: string } {
  const auth = getAuthenticatedUserContext(req);
  if (!auth) {
    throw new PasskeyError(
      "verification_failed",
      "Authentication required. Registration and management endpoints need a bearer token."
    );
  }
  return { userId: auth.userId, email: auth.email };
}

/** POST /api/v1/auth/passkeys/register/begin */
export async function beginRegistrationHandler(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const requestId = resolveRequestId(req);
  try {
    const { userId } = requireUser(req);

    const user = await User.findByPk(userId);
    if (!user) {
      throw new PasskeyError("user_not_found", "User not found.");
    }

    const { options, challenge } = await beginPasskeyRegistration(
      userId,
      user.email,
      user.displayName ?? undefined
    );

    json(res, 200, { options, challenge, requestId });
  } catch (err) {
    if (err instanceof PasskeyError && err.code === "verification_failed") {
      badRequest(res, err.message, req);
      return;
    }
    handlePasskeyError(res, err);
  }
}

/** POST /api/v1/auth/passkeys/register/complete */
export async function completeRegistrationHandler(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const requestId = resolveRequestId(req);
  try {
    const { userId } = requireUser(req);
    const body = await readJsonBody(req);
    if (!body?.response) {
      throw new PasskeyError("verification_failed", "Missing `response` in request body.");
    }

    const credential = await completePasskeyRegistration(
      userId,
      body.response,
      typeof body.name === "string" ? body.name : undefined
    );

    json(res, 201, { credential, requestId });
  } catch (err) {
    handlePasskeyError(res, err);
  }
}

/**
 * POST /api/v1/auth/passkeys/authenticate/begin
 *
 * Accepts an optional bearer token. When present the ceremony is scoped to that
 * user's credentials; otherwise it is a discoverable (usernameless) login.
 */
export async function beginAuthenticationHandler(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const requestId = resolveRequestId(req);
  try {
    const auth = getAuthenticatedUserContext(req);
    const { options, challenge } = await beginPasskeyAuthentication(auth?.userId);
    json(res, 200, { options, challenge, requestId });
  } catch (err) {
    handlePasskeyError(res, err);
  }
}

/**
 * POST /api/v1/auth/passkeys/authenticate/complete
 *
 * On success mints the standard access/refresh token pair so a passkey login
 * is indistinguishable to clients from a password login.
 */
export async function completeAuthenticationHandler(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const requestId = resolveRequestId(req);
  try {
    const body = await readJsonBody(req);
    if (!body?.response) {
      throw new PasskeyError("verification_failed", "Missing `response` in request body.");
    }

    const result = await completePasskeyAuthentication(body.response);

    const user = await User.findByPk(result.userId);
    if (!user) {
      throw new PasskeyError("user_not_found", "User not found for this passkey.");
    }

    const tokens = await issueTokenPair(user.id, user.email, {
      roles: ["user"],
    });

    json(res, 200, {
      verified: true,
      userId: user.id,
      email: user.email,
      userVerified: result.userVerified,
      ...tokens,
      requestId,
    });
  } catch (err) {
    if (err instanceof PasskeyError && err.code === "replay_detected") {
      // A replay is a security event, not a user input problem.
      sendApiError(res, 401, "UNAUTHORIZED", err.message, req);
      return;
    }
    if (err instanceof PasskeyError && err.code === "verification_failed") {
      sendApiError(res, 401, "UNAUTHORIZED", err.message, req);
      return;
    }
    handlePasskeyError(res, err);
  }
}

/** GET /api/v1/auth/passkeys */
export async function listPasskeysHandler(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const requestId = resolveRequestId(req);
  try {
    const { userId } = requireUser(req);
    const passkeys = await listPasskeys(userId);
    json(res, 200, { passkeys, requestId });
  } catch (err) {
    if (err instanceof PasskeyError && err.code === "verification_failed") {
      unauthorized(res, err.message, req);
      return;
    }
    handlePasskeyError(res, err);
  }
}

/** PATCH /api/v1/auth/passkeys/:credentialId */
export async function renamePasskeyHandler(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const requestId = resolveRequestId(req);
  try {
    const { userId } = requireUser(req);
    const credentialId = readCredentialId(req);
    if (!credentialId) {
      notFound(res, "Passkey not found", req);
      return;
    }

    const body = await readJsonBody(req);
    if (typeof body?.name !== "string" || body.name.trim().length === 0) {
      badRequest(res, "A non-empty `name` is required.", req);
      return;
    }

    const passkey = await renamePasskey(userId, credentialId, body.name.trim());
    json(res, 200, { passkey, requestId });
  } catch (err) {
    if (err instanceof PasskeyError && err.code === "verification_failed") {
      unauthorized(res, err.message, req);
      return;
    }
    handlePasskeyError(res, err);
  }
}

/** DELETE /api/v1/auth/passkeys/:credentialId */
export async function deletePasskeyHandler(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const requestId = resolveRequestId(req);
  try {
    const { userId } = requireUser(req);
    const credentialId = readCredentialId(req);
    if (!credentialId) {
      notFound(res, "Passkey not found", req);
      return;
    }

    await deletePasskey(userId, credentialId);
    json(res, 200, { deleted: true, requestId });
  } catch (err) {
    if (err instanceof PasskeyError && err.code === "verification_failed") {
      unauthorized(res, err.message, req);
      return;
    }
    handlePasskeyError(res, err);
  }
}

/**
 * Extract a credential id from the request path.
 *
 * The gateway router keeps params off the request object, so the segment
 * following `passkeys` is matched out of the URL here.
 */
function readCredentialId(req: IncomingMessage): string | undefined {
  const path = (req.url ?? "").split("?")[0];
  const segments = path.split("/").filter(Boolean);
  const index = segments.indexOf("passkeys");
  if (index === -1 || index + 1 >= segments.length) return undefined;
  const value = segments[index + 1];
  if (!value) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}
