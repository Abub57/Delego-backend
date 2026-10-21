-- Migration: 045_merchant_inventory_reservations
-- Description: Per-order inventory reservation ledger with a composite
-- unique constraint to prevent duplicate reservations for the same order
-- (Issue #342).
--
-- `merchant_inventory` only tracked aggregate available/reserved counters,
-- with no row identifying which order a reservation belonged to. Under
-- concurrent checkout retries (e.g. a client retrying a timed-out request),
-- the same order could reserve stock twice with nothing to reject the
-- duplicate at the database level.

CREATE TABLE IF NOT EXISTS merchant_inventory_reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  order_id UUID NOT NULL,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  status TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'released')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The composite unique constraint the issue calls out: one reservation row
-- per (merchant, order, product), so a duplicate checkout attempt for the
-- same order fails fast with a unique constraint violation instead of
-- silently double-reserving stock.
CREATE UNIQUE INDEX IF NOT EXISTS uq_merchant_order_reservation
  ON merchant_inventory_reservations (merchant_id, order_id, product_id);

CREATE INDEX IF NOT EXISTS idx_merchant_inventory_reservations_order
  ON merchant_inventory_reservations (order_id);

CREATE INDEX IF NOT EXISTS idx_merchant_inventory_reservations_status
  ON merchant_inventory_reservations (status);

COMMENT ON TABLE merchant_inventory_reservations IS
  'One row per (merchant, order, product) stock reservation; the unique index on (merchant_id, order_id, product_id) rejects duplicate reservations for the same order at the database level.';
