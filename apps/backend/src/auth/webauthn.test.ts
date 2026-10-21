import { describe, it, expect, beforeEach } from 'vitest';
import {
  linkPasskeyProfile,
  resolveCredential,
  verifyAssertion,
  type LinkedPasskeyProfile,
} from './webauthn';

describe('WebAuthn user handle disambiguation', () => {
  let profiles: Map<string, LinkedPasskeyProfile>;

  beforeEach(() => {
    profiles = new Map();
  });

  it('links multiple credentials to a single user across wallet addresses', () => {
    const userId = 'user-1';
    const walletA = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
    const walletB = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

    linkPasskeyProfile(profiles, userId, 'cred-1', walletA);
    linkPasskeyProfile(profiles, userId, 'cred-2', walletB);

    const profile = profiles.get(userId);
    expect(profile).toBeDefined();
    expect(profile!.userId).toBe(userId);
    expect(profile!.credentialIds).toEqual(['cred-1', 'cred-2']);
    expect(profile!.walletAddresses).toEqual([walletA, walletB]);
  });

  it('does not duplicate credentials or wallet addresses on re-link', () => {
    const userId = 'user-1';
    const walletA = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

    linkPasskeyProfile(profiles, userId, 'cred-1', walletA);
    linkPasskeyProfile(profiles, userId, 'cred-1', walletA);

    const profile = profiles.get(userId)!;
    expect(profile.credentialIds).toEqual(['cred-1']);
    expect(profile.walletAddresses).toEqual([walletA]);
  });

  it('resolves the credential matching the presented credential ID', () => {
    const userId = 'user-1';
    linkPasskeyProfile(profiles, userId, 'cred-1', 'GAAA');
    linkPasskeyProfile(profiles, userId, 'cred-2', 'GBBB');

    const resolved = resolveCredential(profiles, userId, 'cred-2');
    expect(resolved).not.toBeNull();
    expect(resolved!.credentialId).toBe('cred-2');
    expect(resolved!.walletAddress).toBe('GBBB');
  });

  it('returns null when the credential ID is not linked to the user', () => {
    linkPasskeyProfile(profiles, 'user-1', 'cred-1', 'GAAA');
    expect(resolveCredential(profiles, 'user-1', 'cred-unknown')).toBeNull();
    expect(resolveCredential(profiles, 'user-unknown', 'cred-1')).toBeNull();
  });

  it('verifies an assertion using the public key of the matching credential', async () => {
    const userId = 'user-1';
    linkPasskeyProfile(profiles, userId, 'cred-1', 'GAAA');
    linkPasskeyProfile(profiles, userId, 'cred-2', 'GBBB');

    const publicKeys: Record<string, string> = {
      'cred-1': 'pubkey-1',
      'cred-2': 'pubkey-2',
    };

    const verify = async (publicKey: string, signature: string) =>
      publicKey === 'pubkey-2' && signature === 'sig-2';

    const result = await verifyAssertion(
      profiles,
      userId,
      { credentialId: 'cred-2', signature: 'sig-2' },
      publicKeys,
      verify,
    );

    expect(result).toBe(true);
  });

  it('rejects an assertion signed with a non-matching key', async () => {
    const userId = 'user-1';
    linkPasskeyProfile(profiles, userId, 'cred-1', 'GAAA');
    linkPasskeyProfile(profiles, userId, 'cred-2', 'GBBB');

    const publicKeys: Record<string, string> = {
      'cred-1': 'pubkey-1',
      'cred-2': 'pubkey-2',
    };

    const verify = async (publicKey: string, signature: string) =>
      publicKey === 'pubkey-2' && signature === 'sig-2';

    const result = await verifyAssertion(
      profiles,
      userId,
      { credentialId: 'cred-2', signature: 'sig-1' },
      publicKeys,
      verify,
    );

    expect(result).toBe(false);
  });

  it('rejects an assertion for an unknown credential', async () => {
    const userId = 'user-1';
    linkPasskeyProfile(profiles, userId, 'cred-1', 'GAAA');

    const verify = async () => true;

    const result = await verifyAssertion(
      profiles,
      userId,
      { credentialId: 'cred-unknown', signature: 'sig' },
      { 'cred-1': 'pubkey-1' },
      verify,
    );

    expect(result).toBe(false);
  });
});
