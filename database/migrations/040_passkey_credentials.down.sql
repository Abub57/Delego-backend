-- Rollback migration: 040_passkey_credentials
-- Issue: #367 Passkey / WebAuthn Biometric Authentication Verification Service
-- Description: Drop WebAuthn credential and challenge storage.

DROP TABLE IF EXISTS passkey_challenges;
DROP TABLE IF EXISTS passkey_credentials;
