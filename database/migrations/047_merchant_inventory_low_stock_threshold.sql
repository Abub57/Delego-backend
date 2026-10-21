-- Migration: 047_merchant_inventory_low_stock_threshold
-- Description: Merchant-configurable low-stock threshold. When a reservation
-- drops available_stock to or below this value the orchestrator emits an
-- `inventory.low_stock` webhook and queues a transactional email.
-- NULL disables alerting for that inventory row.

ALTER TABLE merchant_inventory
  ADD COLUMN IF NOT EXISTS low_stock_threshold INTEGER
    CHECK (low_stock_threshold IS NULL OR low_stock_threshold >= 0);

COMMENT ON COLUMN merchant_inventory.low_stock_threshold IS
  'Alert when available_stock <= this value; NULL disables low-stock alerts.';
