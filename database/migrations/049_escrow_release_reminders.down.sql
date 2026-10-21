DROP TABLE IF EXISTS escrow_reminders_sent;
DROP INDEX IF EXISTS idx_orders_in_transit_escrow_deadline;
ALTER TABLE orders DROP COLUMN IF EXISTS escrow_deadline;
