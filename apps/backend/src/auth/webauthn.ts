import crypto from 'crypto';

export interface LinkedPasskeyProfile {
  userId: string;
  walletAddresses: string[];
  credentialIds: string[];
}

export interface StoredCredential {
  credentialId: string;
  publicKey: string;
  walletAddress: string;
  signCount: number;
}

export interface WebAuthnAssertion {
  credentialId: string;
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
}

const profiles = new Map<string, LinkedPasskeyProfile>();
const credentials = new Map<string, StoredCredential>();

function toBase64Url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Buffer {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(padded, 'base64');
}

/**
 * Associate a hardware passkey credential with a user and one of their
 * Stellar wallet addresses. A single user may link many credentials, each
 * bound to a wallet address, enabling multi-wallet profiles.
 */
export function linkPasskey(
  userId: string,
  walletAddress: string,
  credential: StoredCredential,
): LinkedPasskeyProfile {
  const existing = profiles.get(userId);
  const profile: LinkedPasskeyProfile = existing ?? {
    userId,
    walletAddresses: [],
    credentialIds: [],
  };

  if (!profile.walletAddresses.includes(walletAddress)) {
    profile.walletAddresses.push(walletAddress);
  }
  if (!profile.credentialIds.includes(credential.credentialId)) {
    profile.credentialIds.push(credential.credentialId);
  }

  profiles.set(userId, profile);
  credentials.set(credential.credentialId, { ...credential, walletAddress });
  return profile;
}

export function getProfile(userId: string): LinkedPasskeyProfile | undefined {
  return profiles.get(userId);
}

/**
 * Resolve the credential that matches the presented credential ID. This is
 * the user-handle disambiguation step: when a user has multiple passkeys we
 * must select the exact credential (and its public key) rather than assuming
 * a single key per user.
 */
export function resolveCredential(credentialId: string): StoredCredential | undefined {
  return credentials.get(credentialId);
}

/**
 * Verify a WebAuthn assertion signature using the public key of the
 * credential matching the presented credential ID.
 */
export function verifyAssertion(assertion: WebAuthnAssertion): boolean {
  const credential = resolveCredential(assertion.credentialId);
  if (!credential) {
    return false;
  }

  const clientData = fromBase64Url(assertion.clientDataJSON);
  const authenticatorData = fromBase64Url(assertion.authenticatorData);
  const signature = fromBase64Url(assertion.signature);

  const clientDataHash = crypto.createHash('sha256').update(clientData).digest();
  const signedData = Buffer.concat([authenticatorData, clientDataHash]);

  const verifier = crypto.createVerify('SHA256');
  verifier.update(signedData);
  verifier.end();

  return verifier.verify(credential.publicKey, signature);
}

export function verifyAssertionForUser(
  userId: string,
  assertion: WebAuthnAssertion,
): boolean {
  const profile = profiles.get(userId);
  if (!profile || !profile.credentialIds.includes(assertion.credentialId)) {
    return false;
  }
  return verifyAssertion(assertion);
}
