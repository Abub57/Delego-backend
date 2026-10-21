-- Migration: 040_passkey_credentials
-- Issue: #367 Passkey / WebAuthn Biometric Authentication Verification Service
-- Description: Stores WebAuthn credential public keys, signature counters and
--              registration challenges so passkeys can be used for passwordless
--              registration and biometric transaction authorization.
--
-- The signature `counter` is the replay-protection mechanism: a cloned
-- authenticator that replays a previously captured assertion presents a
-- counter value that has not advanced, and is rejected.

CREATE TABLE IF NOT EXISTS passkey_credentials (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- base64url encoding of the raw credential id returned by the authenticator
  credential_id      TEXT        NOT NULL UNIQUE,
  -- COSE public key bytes; BYTEA so verification never has to re-encode
  public_key         BYTEA       NOT NULL,
  -- Signature counter. NULL means the authenticator does not implement one.
  counter            BIGINT      NOT NULL DEFAULT 0,
  transports         TEXT[]      NOT NULL DEFAULT '{}',
  -- Human-friendly label shown in account settings
  name               VARCHAR(128),
  -- 'single-device' | 'multi-device', per WebAuthn L3
  device_type        VARCHAR(16) NOT NULL DEFAULT 'single-device'
                       CHECK (device_type IN ('single-device', 'multi-device')),
  backup_eligibility  BOOLEAN     NOT NULL DEFAULT FALSE,
  backup_state        BOOLEAN     NOT NULL DEFAULT FALSE,
  aaguid             VARCHAR(64),
  user_verified      BOOLEAN     NOT NULL DEFAULT FALSE,
  last_used_at       TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_passkey_credentials_user_id
  ON passkey_credentials (user_id);

-- One authenticator per user, so a re-registration of the same device updates
-- the existing row instead of creating a duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS idx_passkey_credentials_user_credential
  ON passkey_credentials (user_id, credential_id);

-- ── Challenges ───────────────────────────────────────────────────────────────
-- Challenges are stored server-side (rather than in a signed cookie) so they
-- are single-use and can be revoked. Consumed on verification.
CREATE TABLE IF NOT EXISTS passkey_challenges (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  challenge   TEXT        NOT NULL,
  type        VARCHAR(16) NOT NULL CHECK (type IN ('registration', 'authentication')),
  user_id     UUID        REFERENCES users(id) ON DELETE CASCADE,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Challenges are looked up by value; the index also serves expiry sweeps.
CREATE UNIQUE INDEX IF NOT EXISTS idx_passkey_challenges_challenge
  ON passkey_challenges (challenge);

CREATE INDEX IF NOT EXISTS idx_passkey_challenges_expires_at
  ON passkey_challenges (expires_at);

-- ── Down migration ───────────────────────────────────────────────────────────
-- DROP TABLE IF EXISTS passkey_challenges;
-- DROP TABLE IF EXISTS passkey_credentials;
