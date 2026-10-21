export interface RevokedTokenEntry {
  jti: string;
  userId: string;
  revokedAt: number;
  expiresAt: number;
}

export interface JwtBlacklistStore {
  /**
   * Store a revoked token jti in Redis with a TTL matching the remaining
   * token lifetime so the entry expires automatically once the token would
   * have expired anyway.
   */
  revoke(entry: RevokedTokenEntry): Promise<void>;

  /**
   * Check whether a token jti has been revoked. Used by the JWT
   * authentication middleware across all API gateways to reject revoked
   * tokens immediately.
   */
  isRevoked(jti: string): Promise<boolean>;
}

export interface LinkedPasskeyProfile {
  userId: string;
  walletAddresses: string[];
  credentialIds: string[];
}
