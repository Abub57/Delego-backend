/**
 * WebAuthn user handle disambiguation for multi-wallet profiles.
 *
 * A single user may link multiple hardware passkeys, each associated with one
 * or more Stellar account addresses. When an assertion is presented we must
 * disambiguate by credential ID and verify the signature with the public key
 * of the matching credential.
 */

export interface LinkedPasskeyProfile {
  userId: string;
  walletAddresses: string[];
  credentialIds: string[];
}

/**
 * A registered credential with its public key and the wallet addresses it is
 * authorized to act for. This is the storage-level record used to verify
 * assertions; the public-facing shape is {@link LinkedPasskeyProfile}.
 */
export interface RegisteredCredential {
  credentialId: string;
  publicKey: string;
  walletAddresses: string[];
}

export interface StoredPasskeyProfile {
  userId: string;
  credentials: RegisteredCredential[];
}

export interface WebAuthnAssertion {
  credentialId: string;
  /** Raw signature bytes produced by the authenticator. */
  signature: string;
  /** The client data / authenticator data that was signed. */
  data: string;
}

/**
 * Verifies a signature against a credential public key. Injected so the
 * profile logic stays independent of a specific crypto backend.
 */
export type SignatureVerifier = (
  publicKey: string,
  data: string,
  signature: string,
) => boolean | Promise<boolean>;

export class PasskeyProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PasskeyProfileError';
  }
}

/**
 * Projects a stored profile into the public {@link LinkedPasskeyProfile} shape,
 * flattening the wallet addresses across all linked credentials.
 */
export function toLinkedPasskeyProfile(
  profile: StoredPasskeyProfile,
): LinkedPasskeyProfile {
  const walletAddresses: string[] = [];
  const credentialIds: string[] = [];

  for (const credential of profile.credentials) {
    credentialIds.push(credential.credentialId);
    for (const address of credential.walletAddresses) {
      if (!walletAddresses.includes(address)) {
        walletAddresses.push(address);
      }
    }
  }

  return {
    userId: profile.userId,
    walletAddresses,
    credentialIds,
  };
}

/**
 * Links an additional credential (and its wallet addresses) to a profile.
 * Supports multiple credentials per user; re-linking an existing credential
 * merges its wallet addresses instead of duplicating the entry.
 */
export function linkCredential(
  profile: StoredPasskeyProfile,
  credential: RegisteredCredential,
): StoredPasskeyProfile {
  const existing = profile.credentials.find(
    (c) => c.credentialId === credential.credentialId,
  );

  if (!existing) {
    return {
      ...profile,
      credentials: [...profile.credentials, credential],
    };
  }

  const mergedAddresses = [...existing.walletAddresses];
  for (const address of credential.walletAddresses) {
    if (!mergedAddresses.includes(address)) {
      mergedAddresses.push(address);
    }
  }

  return {
    ...profile,
    credentials: profile.credentials.map((c) =>
      c.credentialId === credential.credentialId
        ? { ...c, walletAddresses: mergedAddresses }
        : c,
    ),
  };
}

/**
 * Finds the credential matching the presented credential ID. This is the
 * user-handle disambiguation step: the credential ID selects which public key
 * must be used to verify the assertion.
 */
export function findCredential(
  profile: StoredPasskeyProfile,
  credentialId: string,
): RegisteredCredential | undefined {
  return profile.credentials.find((c) => c.credentialId === credentialId);
}

/**
 * Verifies a WebAuthn assertion by disambiguating on the presented credential
 * ID and verifying the signature with that credential's public key.
 *
 * Returns the wallet addresses the matched credential is authorized for.
 */
export async function verifyAssertion(
  profile: StoredPasskeyProfile,
  assertion: WebAuthnAssertion,
  verify: SignatureVerifier,
): Promise<string[]> {
  const credential = findCredential(profile, assertion.credentialId);

  if (!credential) {
    throw new PasskeyProfileError(
      `No linked credential matches credential ID ${assertion.credentialId}`,
    );
  }

  const valid = await verify(
    credential.publicKey,
    assertion.data,
    assertion.signature,
  );

  if (!valid) {
    throw new PasskeyProfileError(
      `Signature verification failed for credential ${assertion.credentialId}`,
    );
  }

  return credential.walletAddresses;
}
