-- Rollback for 20261020_webhook_delivery_forensic_logs.sql
DROP INDEX IF EXISTS idx_webhook_logs_failed_attempts;
DROP INDEX IF EXISTS idx_webhook_logs_endpoint_created;
DROP TABLE IF EXISTS webhook_delivery_logs;
