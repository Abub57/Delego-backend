-- Migration: 040_webhook_secret_rotation
-- Issue: #381 Merchant Webhook HMAC Signature Rotation Service
-- Description: Persists rotation state so that in-flight grace periods survive
--              service restarts. Each row stores the new (current) and old
--              (previous) signing secret for one webhook endpoint, together
--              with the UTC deadline after which the previous secret is no
--              longer valid.
--
-- The webhook_id is an application-layer identifier (e.g. UUID) registered in
-- the in-memory WebhookRegistry. No FK is defined here because the registry is
-- not backed by a database table yet; add it once webhooks are persisted.

CREATE TABLE IF NOT EXISTS webhook_secret_rotation (
  webhook_id         VARCHAR(128)  PRIMARY KEY,
  -- The new secret that receivers should start using immediately.
  current_secret     TEXT          NOT NULL,
  -- The old secret that remains valid until rotation_deadline (nullable:
  -- absent once the grace period has been cleaned up).
  previous_secret    TEXT,
  -- UTC timestamp after which previous_secret is discarded.
  -- NULL when no grace period is active.
  rotation_deadline  TIMESTAMPTZ,
  created_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Fast lookup of all rows whose grace period has expired — used by the
-- cleanup job (WebhookSecretRotationService.cleanExpiredSecrets).
CREATE INDEX IF NOT EXISTS idx_wsr_rotation_deadline
  ON webhook_secret_rotation (rotation_deadline)
  WHERE rotation_deadline IS NOT NULL;

-- Trigger to keep `updated_at` current on every UPDATE.
CREATE OR REPLACE FUNCTION update_webhook_secret_rotation_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_wsr_updated_at ON webhook_secret_rotation;
CREATE TRIGGER trg_wsr_updated_at
  BEFORE UPDATE ON webhook_secret_rotation
  FOR EACH ROW EXECUTE FUNCTION update_webhook_secret_rotation_updated_at();

-- ── Down migration ─────────────────────────────────────────────────────────────
-- DROP TRIGGER  IF EXISTS trg_wsr_updated_at ON webhook_secret_rotation;
-- DROP FUNCTION IF EXISTS update_webhook_secret_rotation_updated_at();
-- DROP INDEX    IF EXISTS idx_wsr_rotation_deadline;
-- DROP TABLE    IF EXISTS webhook_secret_rotation;
