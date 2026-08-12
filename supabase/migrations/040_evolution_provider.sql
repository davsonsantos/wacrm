-- ============================================================
-- 040_evolution_provider
--
-- (Originally authored as 039_evolution_provider; renumbered to 040
-- to avoid colliding with 039_inbound_media_mirror, added on main
-- concurrently.)
--
-- Adds Evolution Go (unofficial, QR-code-connected WhatsApp) as a
-- second provider alongside the Meta Cloud API. `whatsapp_config`
-- keeps its one-row-per-account shape (UNIQUE(account_id) from
-- migration 017) — `provider` picks which set of columns is live
-- for that row. Meta's columns (phone_number_id, waba_id,
-- access_token, verify_token, registered_at, ...) are simply
-- unused when provider = 'evolution', and vice versa.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'meta',
  ADD COLUMN IF NOT EXISTS evolution_instance_id TEXT,
  ADD COLUMN IF NOT EXISTS evolution_instance_token TEXT,
  ADD COLUMN IF NOT EXISTS evolution_instance_name TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'whatsapp_config_provider_check'
  ) THEN
    ALTER TABLE whatsapp_config
      ADD CONSTRAINT whatsapp_config_provider_check
      CHECK (provider IN ('meta', 'evolution'));
  END IF;
END $$;

-- Nullable + UNIQUE is fine in Postgres (multiple NULLs allowed) —
-- same pattern as phone_number_id's constraint in migration 013.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'whatsapp_config_evolution_instance_id_key'
  ) THEN
    ALTER TABLE whatsapp_config
      ADD CONSTRAINT whatsapp_config_evolution_instance_id_key
      UNIQUE (evolution_instance_id);
  END IF;
END $$;

COMMENT ON COLUMN whatsapp_config.provider IS
  'Which WhatsApp connection this account uses. ''meta'' (default) reads phone_number_id/waba_id/access_token/verify_token. ''evolution'' reads evolution_instance_id/evolution_instance_token/evolution_instance_name instead.';

COMMENT ON COLUMN whatsapp_config.evolution_instance_token IS
  'Per-instance token returned by Evolution Go on POST /instance/create, encrypted the same way as access_token (see src/lib/whatsapp/encryption.ts). Sent as the `apikey` header on every instance-scoped Evolution Go call.';
