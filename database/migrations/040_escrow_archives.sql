-- Migration: 040_escrow_archives
-- Description: Cold storage for long-settled escrows, populated by the CDC
--              escrow snapshot archiver (`apps/backend/cdc/src/archiver/`,
--              Issue #290). Moving settled rows out of the live escrow table
--              keeps that table and its indexes small enough to stay resident.
--
-- Nothing is dropped: each archived row keeps a full `to_jsonb` snapshot of the
-- source row in `archive_payload`, so audit history survives the move and
-- columns added to the source table later are captured too.

CREATE TABLE IF NOT EXISTS escrow_archives (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  escrow_id       VARCHAR(64) NOT NULL,
  final_status    VARCHAR(32) NOT NULL,
  settled_at      TIMESTAMPTZ NOT NULL,
  archive_payload JSONB NOT NULL,
  archived_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The archiver's insert is `ON CONFLICT (escrow_id) DO NOTHING`, which makes a
-- re-run (or a second CDC replica) idempotent: an escrow can only ever be
-- archived once.
CREATE UNIQUE INDEX IF NOT EXISTS idx_escrow_archives_escrow_id
  ON escrow_archives (escrow_id);

-- Audit queries are almost always "what settled in this window", newest first.
CREATE INDEX IF NOT EXISTS idx_escrow_archives_settled_at
  ON escrow_archives (settled_at DESC);

-- Terminal status is the other common filter (e.g. refunded vs released).
CREATE INDEX IF NOT EXISTS idx_escrow_archives_final_status
  ON escrow_archives (final_status, settled_at DESC);

COMMENT ON TABLE escrow_archives IS
  'Cold storage for escrows settled beyond the live-table retention window (default 90 days). Written only by the CDC escrow archiver; archive_payload holds the full source row snapshot.';

-- ── Down migration ─────────────────────────────────────────────────────────────
-- DROP INDEX IF EXISTS idx_escrow_archives_final_status;
-- DROP INDEX IF EXISTS idx_escrow_archives_settled_at;
-- DROP INDEX IF EXISTS idx_escrow_archives_escrow_id;
-- DROP TABLE IF EXISTS escrow_archives;
