-- Migration: 046_restock_waitlist
-- Description: Buyers can join a waitlist for an out-of-stock product and are
-- notified (email and/or web push), in signup order, once a merchant
-- replenishes inventory above zero.
--
-- Status lifecycle: pending -> notified | failed | cancelled

CREATE TABLE IF NOT EXISTS product_restock_waitlist (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id    UUID         NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  buyer_address VARCHAR(56),
  email         VARCHAR(255),
  status        VARCHAR(32)  NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'notified', 'failed', 'cancelled')),
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  notified_at   TIMESTAMPTZ,
  -- A subscription is useless without at least one way to reach the buyer.
  CONSTRAINT chk_restock_waitlist_contact
    CHECK (buyer_address IS NOT NULL OR email IS NOT NULL)
);

-- Dispatch query: pending subscribers for a product in signup order.
CREATE INDEX IF NOT EXISTS idx_restock_product_pending
  ON product_restock_waitlist (product_id, created_at)
  WHERE status = 'pending';

-- One pending subscription per contact per product, so repeat clicks on
-- "Notify me" don't queue duplicate notifications.
CREATE UNIQUE INDEX IF NOT EXISTS uq_restock_pending_email
  ON product_restock_waitlist (product_id, LOWER(email))
  WHERE status = 'pending' AND email IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_restock_pending_buyer
  ON product_restock_waitlist (product_id, buyer_address)
  WHERE status = 'pending' AND buyer_address IS NOT NULL;

COMMENT ON TABLE product_restock_waitlist IS
  'Buyers waiting for an out-of-stock product; notified in created_at order when stock rises above zero.';
