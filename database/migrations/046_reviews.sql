-- Migration: 046_reviews.sql
-- Description: Create reviews table with buyer verification constraints
-- Created: 2026-10-19

-- Reviews table: stores product reviews with buyer verification
CREATE TABLE IF NOT EXISTS reviews (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id VARCHAR(128) NOT NULL,
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    buyer_address VARCHAR(56) NOT NULL,  -- Stellar public key of the buyer
    escrow_contract_id VARCHAR(64) NOT NULL,
    buyer_signature VARCHAR(256) NOT NULL,  -- Signature proving buyer identity
    rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
    title VARCHAR(255) NOT NULL,
    content TEXT NOT NULL,
    is_visible BOOLEAN NOT NULL DEFAULT true,  -- For moderation/hiding
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    -- Ensure one review per settled order (enforced at DB level)
    CONSTRAINT unique_review_per_order UNIQUE (order_id)
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_reviews_product_id ON reviews(product_id);
CREATE INDEX IF NOT EXISTS idx_reviews_buyer_address ON reviews(buyer_address);
CREATE INDEX IF NOT EXISTS idx_reviews_created_at ON reviews(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reviews_visible ON reviews(is_visible) WHERE is_visible = true;

-- Review appeals table: merchants can contest fake/defamatory reviews
CREATE TABLE IF NOT EXISTS review_appeals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    review_id UUID NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
    merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    reason_category VARCHAR(32) NOT NULL CHECK (
        reason_category IN ('spam', 'abusive', 'unrelated', 'fraudulent')
    ),
    justification TEXT NOT NULL,
    evidence_urls TEXT[] NOT NULL DEFAULT '{}',
    status VARCHAR(32) NOT NULL DEFAULT 'pending_review' CHECK (
        status IN ('pending_review', 'approved', 'rejected')
    ),
    moderator_notes TEXT,
    moderator_id UUID,
    resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    -- One appeal per review
    CONSTRAINT unique_appeal_per_review UNIQUE (review_id)
);

-- Indexes for appeals
CREATE INDEX IF NOT EXISTS idx_review_appeals_review_id ON review_appeals(review_id);
CREATE INDEX IF NOT EXISTS idx_review_appeals_merchant_id ON review_appeals(merchant_id);
CREATE INDEX IF NOT EXISTS idx_review_appeals_status ON review_appeals(status);

-- Order delivery evidence table: stores IPFS/Arweave CIDs for delivery proofs
CREATE TABLE IF NOT EXISTS order_delivery_evidence (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id VARCHAR(128) NOT NULL,
    merchant_address VARCHAR(56) NOT NULL,
    sha256_hash VARCHAR(64) NOT NULL,
    ipfs_cid VARCHAR(128) NOT NULL,
    storage_url TEXT NOT NULL,
    file_name VARCHAR(255) NOT NULL,
    mime_type VARCHAR(64) NOT NULL,
    file_size_bytes INTEGER NOT NULL,
    verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    -- One evidence per order
    CONSTRAINT unique_evidence_per_order UNIQUE (order_id)
);

-- Indexes for delivery evidence
CREATE INDEX IF NOT EXISTS idx_order_delivery_evidence_order_id ON order_delivery_evidence(order_id);
CREATE INDEX IF NOT EXISTS idx_order_delivery_evidence_merchant ON order_delivery_evidence(merchant_address);
CREATE INDEX IF NOT EXISTS idx_order_delivery_evidence_ipfs_cid ON order_delivery_evidence(ipfs_cid);
CREATE INDEX IF NOT EXISTS idx_order_delivery_evidence_hash ON order_delivery_evidence(sha256_hash);

-- Payment records table: tracks escrow state for buyer verification
-- Note: This may already exist in payments service; adding here for review verification
CREATE TABLE IF NOT EXISTS payment_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id VARCHAR(128) NOT NULL UNIQUE,
    buyer_address VARCHAR(56) NOT NULL,
    seller_address VARCHAR(56) NOT NULL,
    escrow_contract_id VARCHAR(64) NOT NULL,
    amount_stroops NUMERIC(20, 0) NOT NULL,
    asset_code VARCHAR(12) NOT NULL DEFAULT 'USDC',
    status VARCHAR(32) NOT NULL DEFAULT 'pending' CHECK (
        status IN ('pending', 'funded', 'released', 'settled', 'cancelled', 'refunded')
    ),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_records_order_id ON payment_records(order_id);
CREATE INDEX IF NOT EXISTS idx_payment_records_buyer ON payment_records(buyer_address);
CREATE INDEX IF NOT EXISTS idx_payment_records_status ON payment_records(status);
CREATE INDEX IF NOT EXISTS idx_payment_records_escrow ON payment_records(escrow_contract_id);