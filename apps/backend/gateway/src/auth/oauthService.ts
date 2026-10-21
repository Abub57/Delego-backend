import { fetchWithCorrelation } from "../../middleware/correlation.js";

import { User } from "../models/User.js";
import { OAuthAccount } from "../models/OAuthAccount.js";
import { generateTokens } from "./authService.js";

const VALID_PROVIDERS = ["google", "github"] as const;
export type OAuthProvider = (typeof VALID_PROVIDERS)[number];

export interface OAuthProviderProfile {
  provider: OAuthProvider;
  providerUserId: string;
  email: string;
  displayName?: string;
  avatarUrl?: string;
}

export interface OAuthAccountLink {
  userId: string;
  provider: string;
  providerUserId: string;
}

export interface OAuthCallbackResult {
  user: {
    id: string;
    email: string;
    displayName: string | null;
    stellarAddress: string | null;
  };
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  token: string;
  isNewUser: boolean;
}

interface OAuthProviderConfig {
  clientId: string;
  clientSecret: string;
  authorizationUrl: string;
  tokenUrl: string;
  userInfoUrl: string;
  scope: string;
}

function getProviderConfig(provider: OAuthProvider): OAuthProviderConfig {
  switch (provider) {
    case "google":
      return {
        clientId: process.env.GOOGLE_CLIENT_ID ?? "",
        clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
        authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenUrl: "https://oauth2.googleapis.com/token",
        userInfoUrl: "https://www.googleapis.com/oauth2/v3/userinfo",
        scope: "openid email profile",
      };
    case "github":
      return {
        clientId: process.env.GITHUB_CLIENT_ID ?? "",
        clientSecret: process.env.GITHUB_CLIENT_SECRET ?? "",
        authorizationUrl: "https://github.com/login/oauth/authorize",
        tokenUrl: "https://github.com/login/oauth/access_token",
        userInfoUrl: "https://api.github.com/user",
        scope: "read:user user:email",
      };
    default:
      throw new Error(`Unsupported OAuth provider: ${provider}`);
  }
}

export function validateProvider(provider: string): OAuthProvider {
  if (!VALID_PROVIDERS.includes(provider as OAuthProvider)) {
    throw new Error(`Unsupported OAuth provider: ${provider}`);
  }
  return provider as OAuthProvider;
}

export function buildAuthorizationUrl(provider: OAuthProvider, redirectUri: string, state: string): string {
  const config = getProviderConfig(provider);
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: config.scope,
    state,
    access_type: "offline",
    prompt: "consent",
  });
  return `${config.authorizationUrl}?${params.toString()}`;
}

export async function exchangeCodeForToken(
  provider: OAuthProvider,
  code: string,
  redirectUri: string,
): Promise<string> {
  const config = getProviderConfig(provider);

  const body: Record<string, string> = {
    grant_type: "authorization_code",
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code,
    redirect_uri: redirectUri,
  };

  const response = await fetchWithCorrelation(config.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams(body).toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OAuth token exchange failed (${provider}): ${response.status} ${text}`);
  }

  const data = (await response.json()) as { access_token?: string; error?: string };
  if (!data.access_token) {
    throw new Error(`OAuth token exchange failed (${provider}): no access_token returned`);
  }

  return data.access_token;
}

export async function fetchProviderProfile(
  provider: OAuthProvider,
  accessToken: string,
): Promise<OAuthProviderProfile> {
  const config = getProviderConfig(provider);

  const response = await fetchWithCorrelation(config.userInfoUrl, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OAuth profile fetch failed (${provider}): ${response.status} ${text}`);
  }

  const data = await response.json() as Record<string, unknown>;

  return normalizeProfile(provider, data);
}

function normalizeProfile(provider: OAuthProvider, data: Record<string, unknown>): OAuthProviderProfile {
  switch (provider) {
    case "google":
      return {
        provider: "google",
        providerUserId: String(data.sub ?? ""),
        email: String(data.email ?? ""),
        displayName: typeof data.name === "string" ? data.name : undefined,
        avatarUrl: typeof data.picture === "string" ? data.picture : undefined,
      };
    case "github": {
      const email = typeof data.email === "string"
        ? data.email
        : typeof (data as Record<string, unknown>).login === "string"
          ? `${(data as Record<string, unknown>).login}@github.local`
          : "";
      return {
        provider: "github",
        providerUserId: String(data.id ?? ""),
        email,
        displayName: typeof data.name === "string"
          ? data.name
          : typeof data.login === "string"
            ? String(data.login)
            : undefined,
        avatarUrl: typeof data.avatar_url === "string" ? data.avatar_url : undefined,
      };
    }
    default:
      throw new Error(`Unsupported provider: ${provider}`);
  }
}

export async function findExistingOAuthAccount(
  provider: OAuthProvider,
  providerUserId: string,
): Promise<OAuthAccount | null> {
  return OAuthAccount.findOne({
    where: { provider, providerUserId },
  });
}

export async function findUserByEmail(email: string): Promise<User | null> {
  return User.findOne({ where: { email } });
}

export async function linkOAuthAccount(
  userId: string,
  profile: OAuthProviderProfile,
): Promise<OAuthAccount> {
  const existing = await OAuthAccount.findOne({
    where: {
      userId,
      provider: profile.provider,
    },
  });

  if (existing) {
    await existing.update({
      providerUserId: profile.providerUserId,
      email: profile.email,
      displayName: profile.displayName ?? existing.displayName,
      avatarUrl: profile.avatarUrl ?? existing.avatarUrl,
    });
    return existing;
  }

  return OAuthAccount.create({
    userId,
    provider: profile.provider,
    providerUserId: profile.providerUserId,
    email: profile.email,
    displayName: profile.displayName ?? null,
    avatarUrl: profile.avatarUrl ?? null,
  });
}

export async function createOAuthUser(
  profile: OAuthProviderProfile,
): Promise<{ user: User; isNewUser: boolean }> {
  const user = await User.create({
    email: profile.email,
    displayName: profile.displayName ?? null,
    passwordHash: null,
  });

  await linkOAuthAccount(user.id, profile);

  return { user, isNewUser: true };
}

export async function handleOAuthCallback(
  provider: string,
  code: string,
  redirectUri: string,
): Promise<OAuthCallbackResult> {
  const validatedProvider = validateProvider(provider);

  const accessToken = await exchangeCodeForToken(validatedProvider, code, redirectUri);
  const profile = await fetchProviderProfile(validatedProvider, accessToken);

  const existingOAuthAccount = await findExistingOAuthAccount(
    profile.provider,
    profile.providerUserId,
  );

  let user: User;
  let isNewUser = false;

  if (existingOAuthAccount) {
    const foundUser = await User.findByPk(existingOAuthAccount.userId);
    if (!foundUser) {
      throw new Error("OAuth account linked to non-existent user");
    }
    user = foundUser;

    await linkOAuthAccount(user.id, profile);
  } else {
    const existingUser = await findUserByEmail(profile.email);

    if (existingUser) {
      user = existingUser;
      await linkOAuthAccount(user.id, profile);
    } else {
      const result = await createOAuthUser(profile);
      user = result.user;
      isNewUser = result.isNewUser;
    }
  }

  const tokens = await generateTokens(user.id, user.email);

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
    token: tokens.accessToken,
    isNewUser,
  };
}
