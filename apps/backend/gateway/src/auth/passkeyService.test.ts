/**
 * Passkey / WebAuthn verification service — Issue #367
 *
 * The cryptographic ceremonies are delegated to @simplewebauthn/server, so
 * these tests mock the library and focus on the service's own responsibilities:
 * challenge single-use, user binding, persistence, and — the security-critical
 * part — signature-counter replay rejection.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const generateRegistrationOptions = vi.fn();
const generateAuthenticationOptions = vi.fn();
const verifyRegistrationResponse = vi.fn();
const verifyAuthenticationResponse = vi.fn();

vi.mock("@simplewebauthn/server", () => ({
  generateRegistrationOptions: (...args: unknown[]) => generateRegistrationOptions(...args),
  generateAuthenticationOptions: (...args: unknown[]) => generateAuthenticationOptions(...args),
  verifyRegistrationResponse: (...args: unknown[]) => verifyRegistrationResponse(...args),
  verifyAuthenticationResponse: (...args: unknown[]) => verifyAuthenticationResponse(...args),
}));

vi.mock("../models/PasskeyCredential.js", () => ({
  PasskeyCredential: {
    findOne: vi.fn(),
    findAll: vi.fn(),
    create: vi.fn(),
    destroy: vi.fn(),
  },
}));

vi.mock("../models/PasskeyChallenge.js", () => ({
  PasskeyChallenge: {
    findOne: vi.fn(),
    create: vi.fn(),
    destroy: vi.fn(),
  },
}));

vi.mock("../models/User.js", () => ({
  User: {
    findByPk: vi.fn(),
  },
}));

import {
  getPasskeyConfig,
  beginPasskeyRegistration,
  completePasskeyRegistration,
  beginPasskeyAuthentication,
  completePasskeyAuthentication,
  assertCounterAdvanced,
  listPasskeys,
  renamePasskey,
  deletePasskey,
} from "./passkeyService.js";
import { PasskeyError } from "./passkeyTypes.js";
import { PasskeyCredential } from "../models/PasskeyCredential.js";
import { PasskeyChallenge } from "../models/PasskeyChallenge.js";
import { User } from "../models/User.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const CHALLENGE = "Y2hhbGxlbmdlLWNoYWxsZW5nZQ";
const RP_ID = "passkeys.delego.io";
const ORIGIN = "https://passkeys.delego.io";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a clientDataJSON blob carrying `challenge`, as a browser would send. */
function clientDataJSON(challenge: string): string {
  return Buffer.from(
    JSON.stringify({
      type: "webauthn.create",
      challenge,
      origin: ORIGIN,
      crossOrigin: false,
    })
  ).toString("base64url");
}

function registrationResponse(challenge = CHALLENGE) {
  return {
    id: "cred-abc",
    rawId: "cred-abc",
    response: {
      clientDataJSON: clientDataJSON(challenge),
      attestationObject: "attestation",
      transports: ["internal", "hybrid"],
    },
    clientExtensionResults: {},
    type: "public-key",
  } as never;
}

function authenticationResponse(challenge = CHALLENGE) {
  return {
    id: "cred-abc",
    rawId: "cred-abc",
    response: {
      clientDataJSON: clientDataJSON(challenge),
      authenticatorData: "authdata",
      signature: "signature",
      userHandle: USER_ID,
    },
    clientExtensionResults: {},
    type: "public-key",
  } as never;
}

function storedCredential(overrides: Record<string, unknown> = {}) {
  return {
    id: "row-1",
    userId: USER_ID,
    credentialId: "cred-abc",
    publicKey: Buffer.from([1, 2, 3, 4]),
    counter: 5,
    transports: ["internal"],
    name: "iPhone",
    deviceType: "multi-device",
    backupEligibility: true,
    backupState: true,
    aaguid: "aaguid-1",
    userVerified: true,
    lastUsedAt: null as Date | null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    save: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const pendingChallenge = {
  id: "ch-1",
  challenge: CHALLENGE,
  type: "authentication",
  userId: USER_ID,
  expiresAt: new Date(Date.now() + 60_000),
  createdAt: new Date(),
};

// ---------------------------------------------------------------------------

describe("getPasskeyConfig", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.WEBAUTHN_RP_ID = RP_ID;
    process.env.WEBAUTHN_ORIGINS = ORIGIN;
    delete process.env.WEBAUTHN_USER_VERIFICATION;
    delete process.env.WEBAUTHN_ENFORCE_COUNTER;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("resolves rp id, name and origins", () => {
    const config = getPasskeyConfig();
    expect(config.rpID).toBe(RP_ID);
    expect(config.expectedOrigins).toEqual([ORIGIN]);
    expect(config.rpName).toBe("Delego");
    expect(config.userVerification).toBe("required");
    expect(config.enforceCounter).toBe(true);
  });

  it("supports multiple comma-separated origins", () => {
    process.env.WEBAUTHN_ORIGINS = `${ORIGIN}, https://staging.delego.io,https://delego.io`;
    expect(getPasskeyConfig().expectedOrigins).toHaveLength(3);
  });

  it("throws when WEBAUTHN_RP_ID is missing", () => {
    delete process.env.WEBAUTHN_RP_ID;
    expect(() => getPasskeyConfig()).toThrow(PasskeyError);
  });

  it("throws when WEBAUTHN_ORIGINS is missing", () => {
    delete process.env.WEBAUTHN_ORIGINS;
    expect(() => getPasskeyConfig()).toThrow(/WEBAUTHN_ORIGINS/);
  });

  it("rejects an invalid user-verification value", () => {
    process.env.WEBAUTHN_USER_VERIFICATION = "maybe";
    expect(() => getPasskeyConfig()).toThrow(/WEBAUTHN_USER_VERIFICATION/);
  });
});

// ---------------------------------------------------------------------------

describe("registration ceremony", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.WEBAUTHN_RP_ID = RP_ID;
    process.env.WEBAUTHN_ORIGINS = ORIGIN;

    generateRegistrationOptions.mockResolvedValue({ challenge: CHALLENGE, rp: { id: RP_ID } });
    verifyRegistrationResponse.mockResolvedValue({
      verified: true,
      registrationInfo: {
        credential: { id: "cred-abc", publicKey: new Uint8Array([1, 2, 3, 4]), counter: 0 },
        credentialDeviceType: "multi-device",
        credentialBackedUp: true,
        aaguid: "aaguid-1",
        userVerified: true,
      },
    });

    (User.findByPk as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: USER_ID,
      email: "user@delego.io",
      displayName: "Delego User",
    });
    (PasskeyCredential.findAll as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (PasskeyCredential.findOne as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (PasskeyChallenge.findOne as ReturnType<typeof vi.fn>).mockResolvedValue(pendingChallenge);
    (PasskeyChallenge.create as ReturnType<typeof vi.fn>).mockResolvedValue({});
    (PasskeyChallenge.destroy as ReturnType<typeof vi.fn>).mockResolvedValue(1);
    (PasskeyCredential.create as ReturnType<typeof vi.fn>).mockImplementation(
      async (values: Record<string, unknown>) => storedCredential(values)
    );
  });

  it("begin generates options and stores a challenge bound to the user", async () => {
    const { options, challenge } = await beginPasskeyRegistration(USER_ID, "user@delego.io");

    expect(challenge).toBe(CHALLENGE);
    expect(options).toBeDefined();
    expect(generateRegistrationOptions).toHaveBeenCalledWith(
      expect.objectContaining({ rpID: RP_ID, userName: "user@delego.io" })
    );
    expect(PasskeyChallenge.create).toHaveBeenCalledWith(
      expect.objectContaining({
        challenge: CHALLENGE,
        type: "registration",
        userId: USER_ID,
      })
    );
  });

  it("begin excludes already-registered authenticators", async () => {
    (PasskeyCredential.findAll as ReturnType<typeof vi.fn>).mockResolvedValue([
      { credentialId: "existing-1", transports: ["internal"] },
    ]);

    await beginPasskeyRegistration(USER_ID, "user@delego.io");

    expect(generateRegistrationOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        excludeCredentials: [{ id: "existing-1", transports: ["internal"] }],
      })
    );
  });

  it("begin fails when the user does not exist", async () => {
    (User.findByPk as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    await expect(
      beginPasskeyRegistration(USER_ID, "user@delego.io")
    ).rejects.toMatchObject({ code: "user_not_found" });
  });

  it("complete verifies, then stores the public key and counter", async () => {
    const summary = await completePasskeyRegistration(USER_ID, registrationResponse(), "My Key");

    expect(verifyRegistrationResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedChallenge: CHALLENGE,
        expectedRPID: RP_ID,
        expectedOrigin: [ORIGIN],
      })
    );

    const created = (PasskeyCredential.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(created.userId).toBe(USER_ID);
    expect(created.credentialId).toBe("cred-abc");
    expect(Buffer.isBuffer(created.publicKey)).toBe(true);
    expect(created.counter).toBe(0);
    expect(created.transports).toEqual(["internal", "hybrid"]);
    expect(summary.id).toBe("cred-abc");
    expect(summary.deviceType).toBe("multi-device");
  });

  it("complete consumes the challenge so it cannot be replayed", async () => {
    await completePasskeyRegistration(USER_ID, registrationResponse());
    expect(PasskeyChallenge.destroy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { challenge: CHALLENGE, type: "registration" } })
    );
  });

  it("complete rejects an unknown challenge", async () => {
    (PasskeyChallenge.findOne as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    await expect(
      completePasskeyRegistration(USER_ID, registrationResponse())
    ).rejects.toMatchObject({ code: "challenge_not_found" });
    expect(verifyRegistrationResponse).not.toHaveBeenCalled();
  });

  it("complete rejects an expired challenge", async () => {
    (PasskeyChallenge.findOne as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...pendingChallenge,
      type: "registration",
      expiresAt: new Date(Date.now() - 1_000),
    });
    await expect(
      completePasskeyRegistration(USER_ID, registrationResponse())
    ).rejects.toMatchObject({ code: "challenge_expired" });
  });

  it("complete rejects a challenge issued for a different user", async () => {
    (PasskeyChallenge.findOne as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...pendingChallenge,
      type: "registration",
      userId: "some-other-user",
    });
    await expect(
      completePasskeyRegistration(USER_ID, registrationResponse())
    ).rejects.toMatchObject({ code: "verification_failed" });
  });

  it("complete rejects a malformed clientDataJSON", async () => {
    const bad = { ...registrationResponse(), response: { clientDataJSON: "not-base64-json" } };
    await expect(
      completePasskeyRegistration(USER_ID, bad as never)
    ).rejects.toMatchObject({ code: "verification_failed" });
  });

  it("complete rejects a response that fails verification", async () => {
    verifyRegistrationResponse.mockResolvedValue({ verified: false });
    await expect(
      completePasskeyRegistration(USER_ID, registrationResponse())
    ).rejects.toMatchObject({ code: "verification_failed" });
  });

  it("complete converts a library throw into a PasskeyError", async () => {
    verifyRegistrationResponse.mockRejectedValue(new Error("COSE decode failed"));
    await expect(
      completePasskeyRegistration(USER_ID, registrationResponse())
    ).rejects.toMatchObject({ code: "verification_failed" });
  });

  it("complete rejects re-registering the same authenticator", async () => {
    (PasskeyCredential.findOne as ReturnType<typeof vi.fn>).mockResolvedValue(
      storedCredential()
    );
    await expect(
      completePasskeyRegistration(USER_ID, registrationResponse())
    ).rejects.toMatchObject({ code: "conflict" });
  });
});

// ---------------------------------------------------------------------------

describe("authentication ceremony", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.WEBAUTHN_RP_ID = RP_ID;
    process.env.WEBAUTHN_ORIGINS = ORIGIN;

    generateAuthenticationOptions.mockResolvedValue({ challenge: CHALLENGE });
    verifyAuthenticationResponse.mockResolvedValue({
      verified: true,
      authenticationInfo: {
        credentialID: "cred-abc",
        newCounter: 9,
        userVerified: true,
        credentialDeviceType: "multi-device",
        credentialBackedUp: true,
        origin: ORIGIN,
        rpID: RP_ID,
      },
    });

    (PasskeyCredential.findAll as ReturnType<typeof vi.fn>).mockResolvedValue([
      { credentialId: "cred-abc", transports: ["internal"] },
    ]);
    (PasskeyCredential.findOne as ReturnType<typeof vi.fn>).mockResolvedValue(
      storedCredential()
    );
    (PasskeyChallenge.findOne as ReturnType<typeof vi.fn>).mockResolvedValue(pendingChallenge);
    (PasskeyChallenge.create as ReturnType<typeof vi.fn>).mockResolvedValue({});
    (PasskeyChallenge.destroy as ReturnType<typeof vi.fn>).mockResolvedValue(1);
  });

  it("begin scopes allowCredentials to the user's passkeys", async () => {
    const { challenge } = await beginPasskeyAuthentication(USER_ID);

    expect(challenge).toBe(CHALLENGE);
    expect(generateAuthenticationOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        rpID: RP_ID,
        allowCredentials: [{ id: "cred-abc", transports: ["internal"] }],
      })
    );
  });

  it("begin omits allowCredentials for discoverable login", async () => {
    (PasskeyCredential.findAll as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    await beginPasskeyAuthentication();
    expect(generateAuthenticationOptions).toHaveBeenCalledWith(
      expect.objectContaining({ allowCredentials: undefined })
    );
  });

  it("complete verifies the assertion and advances the counter", async () => {
    const record = storedCredential();
    (PasskeyCredential.findOne as ReturnType<typeof vi.fn>).mockResolvedValue(record);

    const result = await completePasskeyAuthentication(authenticationResponse());

    expect(result.userId).toBe(USER_ID);
    expect(result.newCounter).toBe(9);
    expect(result.credential.counter).toBe(9);
    expect(record.counter).toBe(9);
    expect(record.save).toHaveBeenCalled();
    expect(record.lastUsedAt).toBeInstanceOf(Date);
  });

  it("REJECTS a replayed assertion whose counter did not advance", async () => {
    (PasskeyCredential.findOne as ReturnType<typeof vi.fn>).mockResolvedValue(
      storedCredential({ counter: 9 })
    );
    verifyAuthenticationResponse.mockResolvedValue({
      verified: true,
      authenticationInfo: { credentialID: "cred-abc", newCounter: 9, userVerified: true },
    });

    const record = storedCredential({ counter: 9 });
    (PasskeyCredential.findOne as ReturnType<typeof vi.fn>).mockResolvedValue(record);

    await expect(
      completePasskeyAuthentication(authenticationResponse())
    ).rejects.toMatchObject({ code: "replay_detected" });

    // Critically, the counter is NOT persisted on a rejected assertion.
    expect(record.save).not.toHaveBeenCalled();
  });

  it("REJECTS a counter that goes backwards (cloned authenticator)", async () => {
    (PasskeyCredential.findOne as ReturnType<typeof vi.fn>).mockResolvedValue(
      storedCredential({ counter: 100 })
    );
    verifyAuthenticationResponse.mockResolvedValue({
      verified: true,
      authenticationInfo: { credentialID: "cred-abc", newCounter: 3, userVerified: true },
    });

    await expect(
      completePasskeyAuthentication(authenticationResponse())
    ).rejects.toMatchObject({ code: "replay_detected" });
  });

  it("rejects an unknown credential id", async () => {
    (PasskeyCredential.findOne as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    await expect(
      completePasskeyAuthentication(authenticationResponse())
    ).rejects.toMatchObject({ code: "credential_not_found" });
  });

  it("rejects a challenge issued for a different user", async () => {
    (PasskeyChallenge.findOne as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...pendingChallenge,
      userId: "attacker",
    });

    await expect(
      completePasskeyAuthentication(authenticationResponse())
    ).rejects.toMatchObject({ code: "verification_failed" });
    expect(verifyAuthenticationResponse).not.toHaveBeenCalled();
  });

  it("rejects a reused (already consumed) challenge", async () => {
    (PasskeyChallenge.findOne as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    await expect(
      completePasskeyAuthentication(authenticationResponse())
    ).rejects.toMatchObject({ code: "challenge_not_found" });
  });

  it("rejects a response that fails cryptographic verification", async () => {
    verifyAuthenticationResponse.mockResolvedValue({ verified: false });
    await expect(
      completePasskeyAuthentication(authenticationResponse())
    ).rejects.toMatchObject({ code: "verification_failed" });
  });

  it("converts a library throw into a PasskeyError without persisting", async () => {
    const record = storedCredential();
    (PasskeyCredential.findOne as ReturnType<typeof vi.fn>).mockResolvedValue(record);
    verifyAuthenticationResponse.mockRejectedValue(new Error("signature mismatch"));

    await expect(
      completePasskeyAuthentication(authenticationResponse())
    ).rejects.toMatchObject({ code: "verification_failed" });
    expect(record.save).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe("assertCounterAdvanced", () => {
  const config = {
    rpID: RP_ID,
    rpName: "Delego",
    expectedOrigins: [ORIGIN],
    userVerification: "required" as const,
    enforceCounter: true,
    challengeTtlMs: 1000,
  };

  it("allows an advancing counter", () => {
    expect(() => assertCounterAdvanced("c", 5, 6, config)).not.toThrow();
  });

  it("rejects an unchanged counter", () => {
    expect(() => assertCounterAdvanced("c", 5, 5, config)).toThrow(PasskeyError);
  });

  it("rejects a decreasing counter", () => {
    expect(() => assertCounterAdvanced("c", 5, 4, config)).toThrow(/did not advance/);
  });

  it("rejects a counter that resets to zero", () => {
    expect(() => assertCounterAdvanced("c", 5, 0, config)).toThrow(PasskeyError);
  });

  it("can be relaxed for synced passkeys that report a constant counter", () => {
    const relaxed = { ...config, enforceCounter: false };
    expect(() => assertCounterAdvanced("c", 5, 5, relaxed)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------

describe("credential management", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("listPasskeys returns summaries for the user", async () => {
    (PasskeyCredential.findAll as ReturnType<typeof vi.fn>).mockResolvedValue([
      storedCredential(),
    ]);
    const result = await listPasskeys(USER_ID);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("cred-abc");
  });

  it("renamePasskey updates the label", async () => {
    const record = storedCredential();
    (PasskeyCredential.findOne as ReturnType<typeof vi.fn>).mockResolvedValue(record);

    const result = await renamePasskey(USER_ID, "cred-abc", "Work laptop");
    expect(record.name).toBe("Work laptop");
    expect(record.save).toHaveBeenCalled();
    expect(result.name).toBe("Work laptop");
  });

  it("renamePasskey rejects an unknown credential", async () => {
    (PasskeyCredential.findOne as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    await expect(
      renamePasskey(USER_ID, "nope", "x")
    ).rejects.toMatchObject({ code: "credential_not_found" });
  });

  it("deletePasskey removes the credential", async () => {
    const record = storedCredential();
    (PasskeyCredential.findOne as ReturnType<typeof vi.fn>).mockResolvedValue(record);

    await deletePasskey(USER_ID, "cred-abc");
    expect(record.destroy).toHaveBeenCalled();
  });

  it("deletePasskey rejects an unknown credential", async () => {
    (PasskeyCredential.findOne as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    await expect(
      deletePasskey(USER_ID, "nope")
    ).rejects.toMatchObject({ code: "credential_not_found" });
  });
});
