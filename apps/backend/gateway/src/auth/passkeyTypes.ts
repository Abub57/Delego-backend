/**
 * Passkey / WebAuthn types — Issue #367
 *
 * Shapes mirror the issue contract. `PasskeyCredential` is the domain view of
 * a stored credential; the raw WebAuthn types come from
 * `@simplewebauthn/server`.
 */

import type {
  AuthenticatorTransportFuture,
  VerifiedAuthenticationResponse,
  VerifiedRegistrationResponse,
} from "@simplewebauthn/server";

export type {
  AuthenticatorTransportFuture,
  VerifiedAuthenticationResponse,
  VerifiedRegistrationResponse,
};

/** A WebAuthn credential enrolled by a user. */
export interface PasskeyCredential {
  /** base64url-encoded credential id. */
  id: string;
  /** COSE public key bytes. */
  publicKey: Uint8Array;
  /** Signature counter used to detect cloned / replayed authenticators. */
  counter: number;
  transports?: string[];
  userId: string;
}

/** Relying-party configuration, resolved from the environment. */
export interface PasskeyConfig {
  /** Relying-party ID — the registrable domain suffix of the origin. */
  rpID: string;
  /** User-visible relying-party name shown by the authenticator. */
  rpName: string;
  /** Origins a ceremony is allowed to originate from. */
  expectedOrigins: string[];
  /** Whether the ceremony requires user verification (TouchID / FaceID / PIN). */
  userVerification: "required" | "preferred" | "discouraged";
  /**
   * Reject an assertion whose signature counter has not advanced.
   * Defaults to true — this is the replay-protection guarantee.
   */
  enforceCounter: boolean;
  /** Challenge lifetime in milliseconds. */
  challengeTtlMs: number;
}

/** A stored, single-use ceremony challenge. */
export interface PasskeyChallenge {
  challenge: string;
  type: "registration" | "authentication";
  userId?: string;
  expiresAt: Date;
}

/** Public (client-safe) view of a credential. */
export interface PasskeySummary {
  id: string;
  name: string | null;
  transports: string[];
  deviceType: string;
  backedUp: boolean;
  userVerified: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface PasskeyRegistrationStart {
  options: unknown;
  challenge: string;
}

export interface PasskeyAuthenticationStart {
  options: unknown;
  challenge: string;
}

export interface PasskeyAuthenticationResult {
  credential: PasskeyCredential;
  userId: string;
  newCounter: number;
  userVerified: boolean;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** A WebAuthn ceremony failed. `code` is stable and safe to branch on. */
export class PasskeyError extends Error {
  constructor(
    public readonly code:
      | "config_error"
      | "user_not_found"
      | "credential_not_found"
      | "challenge_not_found"
      | "challenge_expired"
      | "verification_failed"
      | "replay_detected"
      | "conflict",
    message: string
  ) {
    super(message);
    this.name = "PasskeyError";
  }
}
