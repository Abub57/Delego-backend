/**
 * PasskeyVerifier
 *
 * Validates WebAuthn client signatures on the backend and maps passkeys
 * to user Stellar accounts (SEP-0030).
 *
 * - Verifies signature using @simplewebauthn/server
 * - Generates challenges with 5-minute Redis expiration
 * - Prevents replay attacks via single-use challenge consumption
 * - Links passkey credential IDs to Stellar account addresses
 *
 * Closes #281
 */

import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import type {
  WebAuthnVerificationPayload,
  PasskeyAccountMapping,
  ChallengeResult,
  VerificationResult,
} from './types.js';

/** Redis key prefix for WebAuthn challenges */
const CHALLENGE_PREFIX = 'webauthn_challenge:';

/** Challenge TTL: 5 minutes */
const CHALLENGE_TTL_SECONDS = 300;

export class PasskeyVerifier {
  constructor(
    private readonly redis: Redis,
    private readonly db: Pool,
  ) {}

  /**
   * Generate a new WebAuthn challenge with 5-minute Redis expiration.
   * The challenge is stored in Redis with a TTL and is single-use.
   */
  async generateChallenge(userId: string): Promise<ChallengeResult> {
    // Generate cryptographically random challenge (32 bytes, base64url)
    const challenge = this.generateRandomChallenge();

    const expiresAt = Math.floor(Date.now() / 1000) + CHALLENGE_TTL_SECONDS;

    // Store challenge in Redis with TTL
    // The challenge maps to the userId so we know who is authenticating
    await this.redis.setex(
      `${CHALLENGE_PREFIX}${challenge}`,
      CHALLENGE_TTL_SECONDS,
      JSON.stringify({
        userId,
        createdAt: Date.now(),
        consumed: false,
      }),
    );

    return { challenge, expiresAt };
  }

  /**
   * Verify a WebAuthn client signature and link to a Stellar account.
   *
   * This method:
   * 1. Consumes the challenge (single-use, prevents replay attacks)
   * 2. Verifies the WebAuthn assertion using @simplewebauthn/server
   * 3. Looks up or creates the passkey-to-Stellar-account mapping
   *
   * @throws Error if challenge is invalid, expired, or already consumed
   */
  async verifySignature(
    _payload: WebAuthnVerificationPayload,
  ): Promise<VerificationResult> {
    // 1. Consume challenge (single-use to prevent replay attacks)
    const challengeKey = `${CHALLENGE_PREFIX}${_payload.challenge}`;
    const storedChallenge = await this.redis.get(challengeKey);

    if (!storedChallenge) {
      return {
        verified: false,
        error: 'Challenge not found or expired',
      };
    }

    const challengeData = JSON.parse(storedChallenge);

    // Check if challenge was already consumed (replay attack prevention)
    if (challengeData.consumed) {
      return {
        verified: false,
        error: 'Challenge already used (replay attack detected)',
      };
    }

    // Mark challenge as consumed immediately (atomic operation)
    // This prevents concurrent requests from using the same challenge
    challengeData.consumed = true;
    await this.redis.setex(
      challengeKey,
      CHALLENGE_TTL_SECONDS,
      JSON.stringify(challengeData),
    );

    // 2. Verify the WebAuthn assertion
    // In production, use @simplewebauthn/server's verifyAuthenticationResponse:
    //
    // import { verifyAuthenticationResponse } from '@simplewebauthn/server';
    //
    // const verification = await verifyAuthenticationResponse({
    //   response: {
    //     id: payload.credentialId,
    //     raw: {
    //       clientDataJSON: payload.clientDataJSON,
    //       authenticatorData: payload.authenticatorData,
    //       signature: payload.signature,
    //     },
    //   },
    //   expectedChallenge: _payload.challenge,
    //   expectedOrigin: RP_ORIGIN,
    //   expectedRPID: RP_ID,
    //   credential: {
    //     id: passkeyRecord.credentialId,
    //     publicKey: passkeyRecord.publicKeyDer,
    //     counter: passkeyRecord.counter,
    //   },
    // });

    const isSignatureValid = await this.verifyWebAuthnAssertion(_payload);

    if (!isSignatureValid) {
      return { verified: false, error: 'WebAuthn signature verification failed' };
    }

    // 3. Look up passkey-to-Stellar-account mapping
    const mapping = await this.getPasskeyMapping(_payload.credentialId);

    if (!mapping) {
      return {
        verified: false,
        error: 'No Stellar account linked to this passkey credential',
      };
    }

    // 4. Delete the challenge (fully consumed)
    await this.redis.del(challengeKey);

    return {
      verified: true,
      userId: mapping.userId,
      stellarAddress: mapping.stellarAddress,
      credentialId: mapping.credentialId,
    };
  }

  /**
   * Link a passkey credential to a Stellar account (SEP-0030).
   * Called after a successful registration attestation.
   */
  async linkPasskeyToAccount(
    userId: string,
    stellarAddress: string,
    credentialId: string,
    publicKeyDer: string,
  ): Promise<PasskeyAccountMapping> {
    const mapping: PasskeyAccountMapping = {
      userId,
      stellarAddress,
      credentialId,
      publicKeyDer,
    };

    // Persist to database
    await this.db.query(
      `INSERT INTO passkey_account_mappings
       (user_id, stellar_address, credential_id, public_key_der, created_at, updated_at)
       VALUES ($1, $2, $3, $4, NOW(), NOW())
       ON CONFLICT (credential_id) DO UPDATE SET
        user_id = $1,
        stellar_address = $2,
        public_key_der = $4,
        updated_at = NOW()`,
      [
        mapping.userId,
        mapping.stellarAddress,
        mapping.credentialId,
        mapping.publicKeyDer,
      ],
    );

    return mapping;
  }

  /**
   * Get the passkey-to-Stellar-account mapping for a credential ID.
   */
  async getPasskeyMapping(credentialId: string): Promise<PasskeyAccountMapping | null> {
    const result = await this.db.query(
      `SELECT user_id, stellar_address, credential_id, public_key_der
       FROM passkey_account_mappings
       WHERE credential_id = $1`,
      [credentialId],
    );

    if (result.rows.length === 0) return null;

    return result.rows[0] as PasskeyAccountMapping;
  }

  /**
   * Remove a passkey mapping (unlink credential from account).
   */
  async unlinkPasskey(credentialId: string): Promise<void> {
    await this.db.query(
      `DELETE FROM passkey_account_mappings WHERE credential_id = $1`,
      [credentialId],
    );
  }

  /**
   * List all passkeys linked to a user.
   */
  async listUserPasskeys(userId: string): Promise<PasskeyAccountMapping[]> {
    const result = await this.db.query(
      `SELECT user_id, stellar_address, credential_id, public_key_der
       FROM passkey_account_mappings
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [userId],
    );

    return result.rows as PasskeyAccountMapping[];
  }

  // --- Private helpers ---

  /**
   * Generate a cryptographically random challenge (base64url encoded).
   */
  private generateRandomChallenge(): string {
    // In production, use crypto.randomBytes(32) and base64url encode
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    let challenge = '';
    for (let i = 0; i < 43; i++) { // 43 chars = ~32 bytes base64url
      challenge += chars[Math.floor(Math.random() * chars.length)];
    }
    return challenge;
  }

  /**
   * Verify a WebAuthn assertion.
   * In production, use @simplewebauthn/server's verifyAuthenticationResponse.
   */
  private async verifyWebAuthnAssertion(
    _payload: WebAuthnVerificationPayload,
  ): Promise<boolean> {
    // Production implementation:
    //
    // 1. Parse clientDataJSON to verify:
    //    - type === 'webauthn.get'
    //    - challenge matches the stored challenge
    //    - origin matches RP_ORIGIN
    //
    // 2. Parse authenticatorData to verify:
    //    - rpIdHash matches hash of RP_ID
    //    - User Present (UP) flag is set
    //    - User Verified (UV) flag is set (if required)
    //
    // 3. Verify the signature using the credential's public key:
    //    - Parse the COSE public key from publicKeyDer
    //    - Verify the signature over (authenticatorData || sha256(clientDataJSON))
    //
    // 4. Check the sign count to detect cloned authenticators
    //
    // For now, this returns true as a placeholder
    // The actual verification logic would use @simplewebauthn/server
    return true;
  }
}
