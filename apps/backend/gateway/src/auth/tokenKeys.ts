/**
 * JWT signing key store with rotation and JWKS export (Issue #77).
 *
 * Supports asymmetric algorithms (RS256 via RSA-2048, ES256 via P-256) and
 * falls back to HS256 with the shared JWT_SECRET. Keys rotate without
 * downtime: the active key signs new tokens while retired keys remain
 * available for verification until they expire.
 *
 * Configuration:
 *   JWT_SIGNING_ALGORITHM   "RS256" | "ES256" | "HS256" (default: RS256)
 *   JWT_PRIVATE_KEY         base64-encoded PEM private key (optional; generated if absent)
 *   JWT_PUBLIC_KEY          base64-encoded PEM public key (optional; generated if absent)
 *   JWT_KID                 explicit key id (default: timestamp-derived)
 *   JWT_SECRET              shared secret used for HS256 (and HS256 verification)
 *   JWT_KEY_ROTATION_DAYS   how long a retired key stays valid (default: 2)
 */

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, KeyObject } from "node:crypto";
import jwt, { type Secret, type SignOptions, type VerifyOptions } from "jsonwebtoken";
import type { JWKSKey, SigningAlgorithm } from "./tokenTypes.js";
import { createChildLogger } from "../logger.js";

const DEFAULT_ROTATION_DAYS = 2;

const log = createChildLogger({ module: "token-keys" });

/**
 * #32 — HS256 tokens fall back to this well-known secret. If JWT_SECRET is left unset
 * (or explicitly set to this value) in production, anyone can forge a valid token for
 * any userId, since the "secret" is public (checked into source control).
 */
export const DEFAULT_JWT_SECRET = "change-me-in-production";

let cachedJwtSecret: string | null = null;

/**
 * Resolves the effective HS256 JWT secret, refusing to start in production on the
 * well-known default. Mirrors the guard in apps/backend/notifications/src/websocket.ts
 * (#30) and apps/backend/wallet/src/vault.ts (#31) for the same class of risk: a public
 * fallback secret protecting real user data.
 *
 * - Production + unset/default → throws (fail closed; refuses to start).
 * - Non-production + unset/default → warns once and falls back to the default (local/dev ergonomics).
 * - Any environment with a real secret configured → returns it unchanged.
 *
 * Cached after the first call so a misconfigured production process fails fast on its
 * first HS256 use and does not spam warnings in development on every call.
 */
export function resolveJwtSecret(
  rawValue: string | undefined = process.env.JWT_SECRET,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): string {
  const isDefault = !rawValue || rawValue === DEFAULT_JWT_SECRET;

  if (isDefault) {
    if (nodeEnv === "production") {
      throw new Error(
        "JWT_SECRET must be set in production and must not equal the default development value",
      );
    }
    if (cachedJwtSecret === null) {
      log.warn("Using default JWT_SECRET - set JWT_SECRET before deploying to production");
    }
    cachedJwtSecret = DEFAULT_JWT_SECRET;
    return DEFAULT_JWT_SECRET;
  }

  cachedJwtSecret = rawValue;
  return rawValue;
}

/** Resets the memoized secret/warning state (used in tests). */
export function resetJwtSecretCache(): void {
  cachedJwtSecret = null;
}

export interface SigningKeyMaterial {
  kid: string;
  alg: SigningAlgorithm;
  privateKey: KeyObject | null;
  publicKey: KeyObject | null;
  secret: string | null;
  createdAt: number;
  expiresAt: number;
}

function base64PemOrNull(value: string | undefined): string | null {
  if (!value || value.trim() === "") return null;
  try {
    return Buffer.from(value, "base64").toString("utf8");
  } catch {
    return null;
  }
}

/**
 * Builds a PEM string from a base64-encoded env value. Accepts either the full
 * PEM (already containing BEGIN/END header lines) or just the base64 body.
 */
function pemFromEnv(
  value: string | undefined,
  kind: "private" | "public",
): string | null {
  const decoded = base64PemOrNull(value);
  if (!decoded) return null;
  const body = decoded.trim();
  if (body.startsWith("-----BEGIN")) return body;
  const header =
    kind === "private" ? "-----BEGIN PRIVATE KEY-----" : "-----BEGIN PUBLIC KEY-----";
  const footer =
    kind === "private" ? "-----END PRIVATE KEY-----" : "-----END PUBLIC KEY-----";
  return `${header}\n${body}\n${footer}`;
}

function algorithmFor(env?: string): SigningAlgorithm {
  const alg = (env ?? "RS256").toUpperCase();
  if (alg === "HS256" || alg === "ES256") return alg;
  return "RS256";
}

function generateRsaKey(): { privateKey: KeyObject; publicKey: KeyObject } {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicExponent: 0x10001,
  });
  return { privateKey, publicKey };
}

function generateEcKey(): { privateKey: KeyObject; publicKey: KeyObject } {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  return { privateKey, publicKey };
}

function generateKid(alg: SigningAlgorithm): string {
  return createHash("sha256")
    .update(`${alg}:${Date.now()}:${Math.random().toString(36).slice(2)}`)
    .digest("hex")
    .slice(0, 16);
}

function loadOrCreateKey(alg: SigningAlgorithm, kid: string): SigningKeyMaterial {
  if (alg === "HS256") {
    const secret = resolveJwtSecret();
    return {
      kid,
      alg,
      privateKey: null,
      publicKey: null,
      secret,
      createdAt: Date.now(),
      expiresAt: Number.MAX_SAFE_INTEGER,
    };
  }

  const privatePem = pemFromEnv(process.env.JWT_PRIVATE_KEY, "private");
  const publicPem = pemFromEnv(process.env.JWT_PUBLIC_KEY, "public");

  if (privatePem) {
    const privateKey = createPrivateKey(privatePem);
    const publicKey = publicPem ? createPublicKey(publicPem) : null;
    return {
      kid,
      alg,
      privateKey,
      publicKey,
      secret: null,
      createdAt: Date.now(),
      expiresAt: Number.MAX_SAFE_INTEGER,
    };
  }

  const { privateKey, publicKey } = alg === "ES256" ? generateEcKey() : generateRsaKey();
  return {
    kid,
    alg,
    privateKey,
    publicKey,
    secret: null,
    createdAt: Date.now(),
    expiresAt: Number.MAX_SAFE_INTEGER,
  };
}

function keyToJwk(key: KeyObject): Record<string, string> {
  return key.export({ format: "jwk" }) as Record<string, string>;
}

interface JwtHeader {
  alg: string;
  kid?: string;
}

/** Decodes only the JWT header (no signature validation). */
export function decodeJwtHeader(token: string): JwtHeader {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("Malformed token");
  }
  let raw: string;
  try {
    raw = Buffer.from(parts[0], "base64url").toString("utf8");
  } catch {
    throw new Error("Malformed token");
  }
  const header = JSON.parse(raw) as JwtHeader;
  if (typeof header.alg !== "string" || header.alg === "") {
    throw new Error("Malformed token header");
  }
  return header;
}

export class SigningKeyStore {
  private readonly algorithm: SigningAlgorithm;
  private current: SigningKeyMaterial;
  private previous: SigningKeyMaterial[] = [];

  constructor(alg: SigningAlgorithm = algorithmFor(process.env.JWT_SIGNING_ALGORITHM)) {
    this.algorithm = alg;
    this.current = loadOrCreateKey(alg, process.env.JWT_KID ?? generateKid(alg));
  }

  get alg(): SigningAlgorithm {
    return this.algorithm;
  }

  /** The key used to sign new tokens. */
  getSigningKey(): SigningKeyMaterial {
    return this.current;
  }

  /**
   * Rotate the signing key. The retired key stays available for verification
   * for `JWT_KEY_ROTATION_DAYS` so previously-issued tokens keep validating
   * during the transition (rotation without downtime).
   */
  rotate(): SigningKeyMaterial {
    const retired = this.current;
    const rotationDays = Math.max(
      1,
      Number(process.env.JWT_KEY_ROTATION_DAYS ?? DEFAULT_ROTATION_DAYS),
    );
    retired.expiresAt = Date.now() + rotationDays * 24 * 60 * 60 * 1000;
    this.previous = [...this.previous, retired];
    this.current = loadOrCreateKey(this.algorithm, generateKid(this.algorithm));
    return this.current;
  }

  private activeKeys(): SigningKeyMaterial[] {
    const now = Date.now();
    this.previous = this.previous.filter((key) => key.expiresAt > now);
    return [...this.previous, this.current];
  }

  /** Exports the public keys for the JWKS endpoint. */
  getJwks(): JWKSKey[] {
    return this.activeKeys()
      .filter((key) => key.publicKey || key.alg === "HS256")
      .map((key): JWKSKey | null => {
        if (key.alg === "HS256") {
          return { kty: "oct", kid: key.kid, use: "sig", alg: "HS256" };
        }
        if (!key.publicKey) return null;
        const jwk = keyToJwk(key.publicKey);
        return {
          kty: jwk.kty ?? "RSA",
          kid: key.kid,
          use: "sig",
          alg: key.alg,
          n: jwk.n,
          e: jwk.e,
          crv: jwk.crv,
          x: jwk.x,
          y: jwk.y,
        };
      })
      .filter((k): k is JWKSKey => k !== null);
  }

  private findVerificationKey(alg: string, kid?: string): KeyObject | string | null {
    for (const key of this.activeKeys()) {
      if (key.alg !== alg) continue;
      if (kid && key.kid !== kid) continue;
      if (alg === "HS256") return key.secret ?? resolveJwtSecret();
      return key.publicKey;
    }
    // Fall back to the current key when no kid match (covers rotated-in HS256).
    if (alg === "HS256") return resolveJwtSecret();
    const current = this.current;
    if (current.alg === alg && current.publicKey) return current.publicKey;
    return null;
  }

  /** Signs a payload with the active key. */
  sign(payload: Record<string, unknown>, options: SignOptions = {}): string {
    const key = this.current;
    const signOptions: SignOptions = {
      algorithm: key.alg,
      keyid: key.kid,
      ...options,
    };
    const signingMaterial: Secret = key.privateKey ?? key.secret ?? "";
    return jwt.sign(payload, signingMaterial, signOptions);
  }

  /** Verifies a token, selecting the key by its alg/kid header. */
  verify(token: string, options: VerifyOptions = {}): unknown {
    const header = decodeJwtHeader(token);
    const key = this.findVerificationKey(header.alg, header.kid);
    if (!key) {
      throw new Error(`No verification key for alg ${header.alg}`);
    }
    return jwt.verify(token, key, options);
  }
}

let store: SigningKeyStore | null = null;

/** Shared singleton key store. */
export function getSigningKeyStore(): SigningKeyStore {
  if (!store) {
    store = new SigningKeyStore();
  }
  return store;
}

/** Resets the singleton (used in tests). */
export function resetSigningKeyStore(): void {
  store = null;
  resetJwtSecretCache();
}
