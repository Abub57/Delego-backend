import bcrypt from "bcryptjs";
import { RefreshToken } from "../models/RefreshToken.js";
import { User } from "../models/User.js";
import {
  getJwks,
  getTokenConfig,
  getJwtValidationConfig,
  introspectToken,
  issueAccessToken,
  issueTokenPair,
  revokeTokens,
  rotateRefreshToken,
  verifyAccessToken,
  verifyWithStore,
  type JwtValidationConfig,
} from "./tokenManager.js";
import type { TokenBinding, TokenPair } from "./tokenTypes.js";

export {
  getJwks,
  getTokenConfig,
  getJwtValidationConfig,
  introspectToken,
  issueTokenPair,
  revokeTokens,
  verifyAccessToken,
  type JwtValidationConfig,
  type TokenPair,
};

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export async function comparePassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function generateAccessToken(
  userId: string,
  email: string,
  roles: string[] = ["user"],
  binding?: TokenBinding,
  scope = "openid",
): string {
  return issueAccessToken(userId, email, { roles, binding, scope });
}

export async function generateTokens(
  userId: string,
  email: string,
  familyId?: string,
  binding?: TokenBinding,
): Promise<TokenPair> {
  return issueTokenPair(userId, email, { familyId, binding });
}

/**
 * Verify an access token. Applies the configured `clockToleranceSeconds`
 * to the `nbf` and `exp` claims and enforces issuer/audience. Supports both
 * asymmetric (RS256/ES256) and symmetric (HS256) tokens so previously-issued
 * tokens keep validating.
 */
export function verifyToken(
  token: string,
  config: JwtValidationConfig = getJwtValidationConfig(),
): { userId: string; email?: string; roles?: string[]; jti?: string; permissions?: string[] } {
  const decoded = verifyWithStore(token, {
    clockTolerance: config.clockToleranceSeconds,
    issuer: config.issuer,
    audience: config.audience,
  });
  if (typeof decoded === "object" && decoded !== null && "userId" in decoded) {
    return {
      userId: decoded.userId as string,
      email: typeof decoded.email === "string" ? decoded.email : undefined,
      roles: Array.isArray(decoded.roles) ? (decoded.roles as string[]) : undefined,
      jti: typeof decoded.jti === "string" ? decoded.jti : undefined,
      permissions: Array.isArray(decoded.permissions) ? (decoded.permissions as string[]) : undefined,
    };
  }
  throw new Error("Invalid token structure");
}

export async function revokeTokenFamily(familyId: string): Promise<void> {
  await RefreshToken.update({ revokedAt: new Date() }, { where: { familyId } });
}

export async function refreshAccessToken(
  rawRefreshToken: string,
  binding?: TokenBinding,
): Promise<TokenPair> {
  return rotateRefreshToken(rawRefreshToken, binding);
}

export function generateToken(userId: string, email: string = ""): string {
  return generateAccessToken(userId, email);
}

export interface RegisterResult {
  user: {
    id: string;
    email: string;
    displayName: string | null;
  };
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  refreshExpiresIn: number;
  tokenType: "Bearer";
  scope: string;
  token: string; // Backward compatibility
}

export async function registerUser(
  email: string,
  password: string,
  displayName?: string,
  binding?: TokenBinding,
): Promise<RegisterResult> {
  if (!email || !password) {
    throw new Error("Email and password are required");
  }

  const existingUser = await User.findOne({ where: { email } });
  if (existingUser) {
    throw new Error("User with this email already exists");
  }

  const passwordHash = await hashPassword(password);
  const user = await User.create({
    email,
    passwordHash,
    displayName: displayName ?? null,
  });

  const tokens = await issueTokenPair(user.id, user.email, { binding });

  return {
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
    },
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresIn: tokens.expiresIn,
    refreshExpiresIn: tokens.refreshExpiresIn,
    tokenType: tokens.tokenType,
    scope: tokens.scope,
    token: tokens.accessToken, // Backward compatibility
  };
}

export interface LoginResult {
  user: {
    id: string;
    email: string;
    displayName: string | null;
    stellarAddress: string | null;
  };
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  refreshExpiresIn: number;
  tokenType: "Bearer";
  scope: string;
  token: string; // Backward compatibility
}

export async function logoutUser(refreshToken?: string): Promise<void> {
  if (!refreshToken) {
    return;
  }
  try {
    await revokeTokens({ refreshToken, reason: "logout" });
  } catch {
    // Ignore invalid refresh tokens during logout.
  }
}

export async function loginUser(
  email: string,
  password: string,
  binding?: TokenBinding,
): Promise<LoginResult> {
  if (!email || !password) {
    throw new Error("Email and password are required");
  }

  const user = await User.findOne({ where: { email } });
  if (!user || !user.passwordHash) {
    throw new Error("Invalid email or password");
  }

  const isPasswordValid = await comparePassword(password, user.passwordHash);
  if (!isPasswordValid) {
    throw new Error("Invalid email or password");
  }

  const tokens = await issueTokenPair(user.id, user.email, { binding });

  return {
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      stellarAddress: user.stellarAddress,
    },
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresIn: tokens.expiresIn,
    refreshExpiresIn: tokens.refreshExpiresIn,
    tokenType: tokens.tokenType,
    scope: tokens.scope,
    token: tokens.accessToken, // Backward compatibility
  };
}
