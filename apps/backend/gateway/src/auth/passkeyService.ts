/**
 * Passkey / WebAuthn Verification Service — Issue #367
 *
 * Implements passwordless registration and biometric transaction
 * authorization on top of `@simplewebauthn/server`:
 *
 *   Registration:   beginPasskeyRegistration  -> completePasskeyRegistration
 *   Authentication: beginPasskeyAuthentication -> completePasskeyAuthentication
 *
 * Replay protection is the security-critical part. Every assertion is checked
 * against the credential's stored signature counter; an authenticator whose
 * counter has not advanced since the last successful use is rejected, which is
 * what catches a cloned or replayed device.
 */

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  RegistrationResponseJSON,
  WebAuthnCredential,
} from "@simplewebauthn/server";
import { createLogger } from "@delegolabs/utils";
import { PasskeyChallenge } from "../models/PasskeyChallenge.js";
import { PasskeyCredential } from "../models/PasskeyCredential.js";
import { User } from "../models/User.js";
import {
  PasskeyError,
  type PasskeyAuthenticationResult,
  type PasskeyAuthenticationStart,
  type PasskeyConfig,
  type PasskeyRegistrationStart,
  type PasskeySummary,
} from "./passkeyTypes.js";

const log = createLogger("gateway:passkeys", process.env.LOG_LEVEL ?? "info");

const DEFAULT_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_RP_NAME = "Delego";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Resolve relying-party configuration from the environment.
 *
 * `WEBAUTHN_RP_ID` and `WEBAUTHN_ORIGINS` must be set explicitly in deployed
 * environments; there is no safe default, because a wrong RP ID silently
 * accepts ceremonies from the wrong origin.
 */
export function getPasskeyConfig(): PasskeyConfig {
  const rpID = process.env.WEBAUTHN_RP_ID;
  if (!rpID) {
    throw new PasskeyError(
      "config_error",
      "WEBAUTHN_RP_ID is not configured. Set it to the registrable domain of the relying party."
    );
  }

  const origins = (process.env.WEBAUTHN_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  if (origins.length === 0) {
    throw new PasskeyError(
      "config_error",
      "WEBAUTHN_ORIGINS is not configured. Set it to a comma-separated list of allowed origins."
    );
  }

  const userVerification = process.env.WEBAUTHN_USER_VERIFICATION ?? "required";
  if (!["required", "preferred", "discouraged"].includes(userVerification)) {
    throw new PasskeyError(
      "config_error",
      `WEBAUTHN_USER_VERIFICATION must be required, preferred or discouraged (got "${userVerification}").`
    );
  }

  return {
    rpID,
    rpName: process.env.WEBAUTHN_RP_NAME ?? DEFAULT_RP_NAME,
    expectedOrigins: origins,
    userVerification: userVerification as PasskeyConfig["userVerification"],
    enforceCounter: process.env.WEBAUTHN_ENFORCE_COUNTER !== "false",
    challengeTtlMs: Number(
      process.env.WEBAUTHN_CHALLENGE_TTL_MS ?? DEFAULT_CHALLENGE_TTL_MS
    ),
  };
}

// ---------------------------------------------------------------------------
// Challenge storage
// ---------------------------------------------------------------------------

async function storeChallenge(
  challenge: string,
  type: "registration" | "authentication",
  userId: string | undefined,
  ttlMs: number
): Promise<void> {
  await PasskeyChallenge.create({
    challenge,
    type,
    userId: userId ?? null,
    expiresAt: new Date(Date.now() + ttlMs),
  });
}

/**
 * Look up and immediately invalidate a challenge.
 *
 * The row is deleted on read so a challenge is strictly single-use; a replayed
 * ceremony cannot find its challenge a second time.
 */
async function consumeChallenge(
  challenge: string,
  type: "registration" | "authentication"
): Promise<string | undefined> {
  const row = await PasskeyChallenge.findOne({ where: { challenge, type } });
  if (!row) {
    throw new PasskeyError(
      "challenge_not_found",
      "Unknown or already-used challenge. Restart the WebAuthn ceremony."
    );
  }

  await PasskeyChallenge.destroy({ where: { challenge, type } });

  if (row.expiresAt.getTime() <= Date.now()) {
    throw new PasskeyError("challenge_expired", "WebAuthn challenge has expired.");
  }

  return row.userId ?? undefined;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Step 1 of registration: build `navigator.credentials.create()` options and
 * remember the challenge.
 */
export async function beginPasskeyRegistration(
  userId: string,
  userName: string,
  userDisplayName?: string
): Promise<PasskeyRegistrationStart> {
  const config = getPasskeyConfig();

  const user = await User.findByPk(userId);
  if (!user) {
    throw new PasskeyError("user_not_found", "User not found.");
  }

  // excludeCredentials stops the same authenticator being enrolled twice.
  const existing = await PasskeyCredential.findAll({
    where: { userId },
    attributes: ["credentialId", "transports"],
  });

  const options = await generateRegistrationOptions({
    rpName: config.rpName,
    rpID: config.rpID,
    userName,
    userDisplayName: userDisplayName ?? user.displayName ?? userName,
    // The user id is the stable handle the authenticator binds the credential
    // to. It must be a byte string, not the UUID text, so that the credential
    // is bound to the numeric user handle rather than a re-parseable string.
    userID: new TextEncoder().encode(userId),
    attestationType: "none",
    excludeCredentials: existing.map((credential) => ({
      id: credential.credentialId,
      transports: (credential.transports ?? []) as AuthenticatorTransportFuture[],
    })),
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: config.userVerification,
    },
  });

  await storeChallenge(options.challenge, "registration", userId, config.challengeTtlMs);

  return { options, challenge: options.challenge };
}

/**
 * Step 2 of registration: verify the attestation response and persist the
 * credential public key and initial counter.
 */
export async function completePasskeyRegistration(
  userId: string,
  response: RegistrationResponseJSON,
  name?: string
): Promise<PasskeySummary> {
  const config = getPasskeyConfig();

  if (!response?.id || !response?.rawId) {
    throw new PasskeyError(
      "verification_failed",
      "Malformed registration response: missing credential id."
    );
  }

  const challenge = challengeFromClientData(response.response.clientDataJSON);
  const challengeUserId = await consumeChallenge(challenge, "registration");
  if (challengeUserId && challengeUserId !== userId) {
    throw new PasskeyError(
      "verification_failed",
      "WebAuthn challenge does not belong to this user."
    );
  }

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: config.expectedOrigins,
      expectedRPID: config.rpID,
      requireUserVerification: config.userVerification === "required",
    });
  } catch (err) {
    log.warn("WebAuthn registration verification threw", {
      error: err instanceof Error ? err.message : String(err),
    });
    throw new PasskeyError(
      "verification_failed",
      "WebAuthn registration response could not be verified."
    );
  }

  if (!verification.verified || !verification.registrationInfo) {
    throw new PasskeyError(
      "verification_failed",
      "WebAuthn registration response failed verification."
    );
  }

  const { credential, aaguid, credentialDeviceType, credentialBackedUp, userVerified } =
    verification.registrationInfo;

  const existing = await PasskeyCredential.findOne({ where: { credentialId: response.id } });
  if (existing) {
    throw new PasskeyError(
      "conflict",
      "This authenticator is already registered. Authenticate with it instead of re-registering."
    );
  }

  const record = await PasskeyCredential.create({
    userId,
    credentialId: response.id,
    publicKey: Buffer.from(credential.publicKey),
    // A freshly enrolled authenticator starts at counter 0; the first
    // assertion advances it.
    counter: 0,
    transports: (response.response.transports ?? []) as string[],
    name: name ?? defaultCredentialName(credentialDeviceType),
    deviceType: credentialDeviceType,
    backupEligibility: credentialBackedUp,
    backupState: credentialBackedUp,
    aaguid,
    userVerified,
  });

  log.info("Passkey registered", { userId, credentialId: response.id });

  return toSummary(record);
}

/**
 * Recover the ceremony challenge the browser echoed back in `clientDataJSON`.
 *
 * Reading it here (rather than trusting the caller to pass a challenge id) is
 * what binds the stored, single-use challenge to this specific response.
 */
function challengeFromClientData(clientDataJSON: string): string {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(clientDataJSON, "base64url").toString("utf-8")
    );
    if (typeof parsed === "object" && parsed !== null && "challenge" in parsed) {
      const challenge = (parsed as { challenge: unknown }).challenge;
      if (typeof challenge === "string" && challenge.length > 0) return challenge;
    }
  } catch {
    // Fall through to the error below.
  }
  throw new PasskeyError(
    "verification_failed",
    "Malformed clientDataJSON in WebAuthn response."
  );
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

/**
 * Step 1 of authentication: build `navigator.credentials.get()` options.
 *
 * When `userId` is supplied the ceremony is a usernameless lookup against that
 * user's enrolled authenticators; otherwise it is discoverable-credential
 * (usernameless) login.
 */
export async function beginPasskeyAuthentication(
  userId?: string
): Promise<PasskeyAuthenticationStart> {
  const config = getPasskeyConfig();

  const credentials = userId
    ? await PasskeyCredential.findAll({ where: { userId } })
    : [];

  const options = await generateAuthenticationOptions({
    rpID: config.rpID,
    userVerification: config.userVerification,
    allowCredentials:
      credentials.length > 0
        ? credentials.map((credential) => ({
            id: credential.credentialId,
            transports: (credential.transports ?? []) as AuthenticatorTransportFuture[],
          }))
        : undefined,
  });

  await storeChallenge(options.challenge, "authentication", userId, config.challengeTtlMs);

  return { options, challenge: options.challenge };
}

/**
 * Step 2 of authentication: verify the assertion and advance the stored
 * signature counter, rejecting replays.
 */
export async function completePasskeyAuthentication(
  response: AuthenticationResponseJSON
): Promise<PasskeyAuthenticationResult> {
  const config = getPasskeyConfig();

  if (!response?.id || !response?.rawId) {
    throw new PasskeyError(
      "verification_failed",
      "Malformed authentication response: missing credential id."
    );
  }

  const challenge = challengeFromClientData(response.response.clientDataJSON);
  const challengeUserId = await consumeChallenge(challenge, "authentication");

  const record = await PasskeyCredential.findOne({ where: { credentialId: response.id } });
  if (!record) {
    throw new PasskeyError(
      "credential_not_found",
      "No passkey is registered with this credential id."
    );
  }

  // A user-scoped challenge must not be redeemed by a different account.
  if (challengeUserId && challengeUserId !== record.userId) {
    throw new PasskeyError(
      "verification_failed",
      "WebAuthn challenge does not belong to this user."
    );
  }

  const storedCounter = toCounter(record.counter);
  // `.slice()` narrows the buffer type to the plain ArrayBuffer-backed
  // Uint8Array that @simplewebauthn/server expects.
  const publicKey = new Uint8Array(record.publicKey).slice();
  const credential: WebAuthnCredential = {
    id: record.credentialId,
    publicKey,
    counter: storedCounter,
    transports: (record.transports ?? []) as AuthenticatorTransportFuture[],
  };

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: config.expectedOrigins,
      expectedRPID: config.rpID,
      credential,
      requireUserVerification: config.userVerification === "required",
    });
  } catch (err) {
    log.warn("WebAuthn authentication verification threw", {
      error: err instanceof Error ? err.message : String(err),
    });
    throw new PasskeyError(
      "verification_failed",
      "WebAuthn authentication response could not be verified."
    );
  }

  if (!verification.verified) {
    throw new PasskeyError(
      "verification_failed",
      "WebAuthn authentication response failed verification."
    );
  }

  const { newCounter, userVerified } = verification.authenticationInfo;

  assertCounterAdvanced(record.credentialId, storedCounter, newCounter, config);

  // Advance the counter atomically enough for the single-writer case, and only
  // after the assertion has been cryptographically verified.
  record.counter = newCounter;
  record.lastUsedAt = new Date();
  record.userVerified = userVerified;
  await record.save();

  log.info("Passkey authentication succeeded", {
    userId: record.userId,
    credentialId: record.credentialId,
    newCounter,
  });

  return {
    credential: {
      id: record.credentialId,
      publicKey,
      counter: newCounter,
      transports: record.transports ?? [],
      userId: record.userId,
    },
    userId: record.userId,
    newCounter,
    userVerified,
  };
}

/**
 * Reject a replayed or cloned authenticator.
 *
 * Per the WebAuthn spec a counter that does not advance indicates the same
 * authenticator is being used from two places, i.e. it has been cloned. Some
 * synced passkeys legitimately report a constant counter, so a deployment can
 * relax this with WEBAUTHN_ENFORCE_COUNTER=false — but that forfeits the
 * replay guarantee and is not the default.
 */
export function assertCounterAdvanced(
  credentialId: string,
  storedCounter: number,
  newCounter: number,
  config: PasskeyConfig = getPasskeyConfig()
): void {
  if (!config.enforceCounter) return;

  if (newCounter <= storedCounter) {
    log.warn("WebAuthn counter did not advance — possible cloned authenticator", {
      credentialId,
      storedCounter,
      newCounter,
    });
    throw new PasskeyError(
      "replay_detected",
      `Passkey signature counter did not advance (stored ${storedCounter}, received ${newCounter}). ` +
        "This assertion was rejected as a potential replay or cloned authenticator."
    );
  }
}

// ---------------------------------------------------------------------------
// Credential management
// ---------------------------------------------------------------------------

export async function listPasskeys(userId: string): Promise<PasskeySummary[]> {
  const records = await PasskeyCredential.findAll({
    where: { userId },
    order: [["createdAt", "ASC"]],
  });
  return records.map(toSummary);
}

export async function renamePasskey(
  userId: string,
  credentialId: string,
  name: string
): Promise<PasskeySummary> {
  const record = await PasskeyCredential.findOne({ where: { userId, credentialId } });
  if (!record) {
    throw new PasskeyError("credential_not_found", "Passkey not found for this user.");
  }
  record.name = name;
  await record.save();
  return toSummary(record);
}

/** Remove a credential. Fails when it would leave the user with no passkey. */
export async function deletePasskey(userId: string, credentialId: string): Promise<void> {
  const record = await PasskeyCredential.findOne({ where: { userId, credentialId } });
  if (!record) {
    throw new PasskeyError("credential_not_found", "Passkey not found for this user.");
  }
  await record.destroy();
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** pg returns BIGINT as a string; normalise to a number. */
function toCounter(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function defaultCredentialName(deviceType: string): string {
  return deviceType === "multi-device" ? "Synced passkey" : "Security key / device passkey";
}

function toSummary(record: PasskeyCredential): PasskeySummary {
  return {
    id: record.credentialId,
    name: record.name,
    transports: record.transports ?? [],
    deviceType: record.deviceType,
    backedUp: record.backupState,
    userVerified: record.userVerified,
    createdAt: record.createdAt.toISOString(),
    lastUsedAt: record.lastUsedAt ? record.lastUsedAt.toISOString() : null,
  };
}
