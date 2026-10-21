-- Migration: 20261020_webhook_delivery_forensic_logs
-- Description: Granular forensic log of outbound webhook delivery attempts.
--              One row per attempt, recording the request payload hash, the
--              HTTP response status, latency, a response body sample, and the
--              failure reason, so merchant integrations can diagnose why a
--              delivery was rejected.
--
-- endpoint_id is an application-layer identifier (the webhook endpoint UUID
-- registered in the WebhookRegistry). No FK is defined here because webhook
-- endpoints are not backed by a database table yet; add it once they are.

CREATE TABLE IF NOT EXISTS webhook_delivery_logs (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint_id          UUID        NOT NULL,
  event_type           VARCHAR(64) NOT NULL,
  payload_hash         CHAR(64)    NOT NULL,
  attempt_number       SMALLINT    NOT NULL DEFAULT 1,
  http_status          SMALLINT,
  latency_ms           INTEGER,
  response_body_sample TEXT,
  error_message        TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Newest-first forensic view of everything sent to one endpoint.
CREATE INDEX IF NOT EXISTS idx_webhook_logs_endpoint_created
  ON webhook_delivery_logs(endpoint_id, created_at DESC);

-- Failed attempts only: a 4xx/5xx response, or no response at all
-- (http_status IS NULL, e.g. a timeout or connection error). Partial so the
-- retry-triage path stays small as successful deliveries accumulate.
CREATE INDEX IF NOT EXISTS idx_webhook_logs_failed_attempts
  ON webhook_delivery_logs(endpoint_id, created_at DESC)
  WHERE http_status >= 400 OR http_status IS NULL;
