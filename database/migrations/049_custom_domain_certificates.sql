-- Migration: 049_custom_domain_certificates
-- Issue: #597 Background worker for syncing merchant domain CNAME with Let's Encrypt
-- Description: Durable queue of merchant custom-domain verification jobs and the
--              issued TLS certificates. Certificate and private-key PEMs are
--              stored AES-256-GCM encrypted as JSONB; plaintext never reaches
--              PostgreSQL.

CREATE TABLE IF NOT EXISTS domain_verification_jobs (
  merchant_id     VARCHAR(64) NOT NULL,
  custom_domain   TEXT        NOT NULL,
  target_cname    TEXT        NOT NULL,
  status          TEXT        NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'completed', 'failed')),
  attempts        INTEGER     NOT NULL DEFAULT 0,
  last_checked_at TIMESTAMPTZ,
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (merchant_id, custom_domain)
);

-- The worker polls pending jobs in FIFO order.
CREATE INDEX IF NOT EXISTS idx_domain_verification_jobs_pending
  ON domain_verification_jobs (created_at)
  WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS domain_certificates (
  merchant_id     VARCHAR(64) NOT NULL,
  domain          TEXT        NOT NULL,
  certificate_pem JSONB       NOT NULL,
  private_key_pem JSONB       NOT NULL,
  expires_at      TIMESTAMPTZ NOT NULL,
  renew_before    TIMESTAMPTZ NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (merchant_id, domain)
);

-- Renewal sweep by the certmanager renewal scheduler.
CREATE INDEX IF NOT EXISTS idx_domain_certificates_renew_before
  ON domain_certificates (renew_before);

-- ── Down migration ─────────────────────────────────────────────────────────
-- DROP TABLE IF EXISTS domain_certificates;
-- DROP TABLE IF EXISTS domain_verification_jobs;
