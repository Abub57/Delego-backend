-- Migration: 049_escrow_release_reminders
-- Description: Supports the automated escrow release reminder worker (#587).
--              `orders.escrow_deadline` is the moment an escrow auto-finalizes
--              (releases or enters dispute) if the buyer has not confirmed
--              receipt. `escrow_reminders_sent` records one row per
--              (order, reminder window) so each reminder is sent exactly once.

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS escrow_deadline TIMESTAMPTZ;

-- The reminder scan only looks at in-transit orders with a deadline.
CREATE INDEX IF NOT EXISTS idx_orders_in_transit_escrow_deadline
  ON orders (escrow_deadline)
  WHERE status = 'in_transit' AND escrow_deadline IS NOT NULL;

CREATE TABLE IF NOT EXISTS escrow_reminders_sent (
  order_id        UUID        NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  hours_remaining SMALLINT    NOT NULL CHECK (hours_remaining IN (48, 12)),
  sent_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (order_id, hours_remaining)
);
