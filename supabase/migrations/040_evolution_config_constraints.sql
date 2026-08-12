-- ============================================================
-- 040_evolution_config_constraints
--
-- Migration 039 added the `provider`/`evolution_*` columns to
-- whatsapp_config but never relaxed the constraints that migration
-- 001 put on the Meta-only columns. As written, those constraints
-- make the Evolution Go connect flow 100% non-functional against the
-- real schema:
--
--   * `phone_number_id TEXT NOT NULL` and `access_token TEXT NOT
--     NULL` — both are legitimately NULL for `provider = 'evolution'`
--     rows (Meta's columns are simply unused, per 039's own comment).
--     A fresh account's first upsert is an INSERT and trips both.
--
--   * `status TEXT NOT NULL DEFAULT 'disconnected' CHECK (status IN
--     ('connected', 'disconnected'))` — the connect flow sets
--     `status = 'connecting'` while the QR is being scanned, which
--     isn't in the allowed set. An account with a pre-existing row
--     (e.g. a previous Meta config) hits this on the UPDATE path.
--
-- This migration only relaxes those two Meta-column NOT NULLs and
-- widens the status CHECK to also allow 'connecting'. It does not
-- touch `user_id`'s NOT NULL, RLS, or any other constraint.
--
-- Idempotent — safe to re-run.
-- ============================================================

-- phone_number_id / access_token: legitimately NULL for Evolution rows.
ALTER TABLE whatsapp_config ALTER COLUMN phone_number_id DROP NOT NULL;
ALTER TABLE whatsapp_config ALTER COLUMN access_token DROP NOT NULL;

-- status: widen the inline CHECK from migration 001
-- (`whatsapp_config_status_check` is Postgres's auto-generated name
-- for an unnamed inline CHECK on the `status` column of this table)
-- to also allow 'connecting'. DROP CONSTRAINT IF EXISTS is a no-op
-- if it's already been dropped by a prior run of this migration, and
-- the guarded ADD below skips re-adding it if it's already present —
-- together that makes this block safe to re-run.
ALTER TABLE whatsapp_config DROP CONSTRAINT IF EXISTS whatsapp_config_status_check;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'whatsapp_config_status_check'
  ) THEN
    ALTER TABLE whatsapp_config
      ADD CONSTRAINT whatsapp_config_status_check
      CHECK (status IN ('connected', 'disconnected', 'connecting'));
  END IF;
END $$;
