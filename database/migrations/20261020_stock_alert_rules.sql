-- Migration: stock_alert_rules
-- Issue: Merchant Low-Stock Threshold Subscriptions
-- Creates the stock_alert_rules table with a unique index per merchant/product/SKU.

BEGIN;

CREATE TABLE IF NOT EXISTS stock_alert_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id VARCHAR(64) NOT NULL,
    product_id VARCHAR(64) NOT NULL,
    sku_id VARCHAR(64),
    threshold_quantity INTEGER NOT NULL CHECK (threshold_quantity >= 0),
    notification_channel VARCHAR(32) NOT NULL DEFAULT 'email',
    channel_target VARCHAR(255) NOT NULL,
    last_triggered_at TIMESTAMPTZ,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_alert_merchant_sku
    ON stock_alert_rules (merchant_id, product_id, COALESCE(sku_id, 'DEFAULT'));

COMMIT;
