-- Sarvam provider-mapping columns (V1 manual-onboarding architecture)
--
-- Adds exactly the three nullable identifier columns the approved design
-- report calls for — no new table. Sarvam app/agent creation, connection
-- creation, and managed-number rental are manual Sarvam-dashboard steps
-- (no public API found for them); everything downstream of that manual
-- step (deployments, campaigns, instant outbound) is what these columns
-- let Klyro's admin tooling automate. See sarvam-admin.functions.ts for
-- the three admin operations that write these columns, and the
-- Exotel-to-Sarvam migration report for the full verification trail.

-- ============================================================
-- 1. agent_configs — Klyro agent -> Sarvam app mapping
-- ============================================================
ALTER TABLE public.agent_configs
  ADD COLUMN IF NOT EXISTS sarvam_app_id text,
  ADD COLUMN IF NOT EXISTS sarvam_app_version integer;

-- One Sarvam app maps to at most one Klyro agent_configs row (Klyro's own
-- model is one agent_configs row per business already). A partial unique
-- index — not a plain UNIQUE column constraint — so any number of rows may
-- still have sarvam_app_id IS NULL (not yet mapped); it only rejects two
-- different agents claiming the same Sarvam app, the realistic failure
-- mode from a manual admin data-entry step.
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_configs_sarvam_app_id
  ON public.agent_configs (sarvam_app_id) WHERE sarvam_app_id IS NOT NULL;

-- Security review finding (see the migration report): agent_configs has
-- carried a blanket authenticated INSERT/UPDATE grant since Phase 0,
-- because customers configure their own agent's name/persona/voice/etc.
-- directly from the browser (app.onboarding.tsx's insert, app.agent.tsx's
-- update). Adding sarvam_app_id/sarvam_app_version as plain columns would
-- let that same blanket grant expose them to direct customer mutation —
-- exactly the "customer can modify Sarvam mapping" failure this migration
-- must prevent. Fixed by replacing the blanket grant with an explicit
-- column list, verified against the actual current INSERT/UPDATE call
-- sites (not guessed) so no existing customer flow breaks:
--   INSERT columns actually used (app.onboarding.tsx):
--     organization_id, business_id, agent_name, primary_language,
--     voice_id, greetings, capabilities, objectives
--   UPDATE columns actually used (app.agent.tsx):
--     agent_name, persona, primary_language, voice_id, speaking_pace,
--     multilingual, after_hours_behavior, transfer_number,
--     custom_personality, capabilities, greetings
-- Deliberately excluded from both: sarvam_app_id, sarvam_app_version,
-- status, active_version (already server-only in practice — only ever
-- written via supabaseAdmin in agent.functions.ts's publish/rollback and
-- voice-runtime.server.ts's markAgentLive), and extra_languages/
-- advanced_mode (unused by any current customer write path — least
-- privilege, not speculative inclusion). SELECT is intentionally left
-- unrestricted on the new columns: they are inert identifiers (no Sarvam
-- API call is ever reachable from the browser regardless of who can read
-- an app_id), unlike call_logs.provider_cost/gross_profit which are
-- excluded for business-confidentiality reasons — and workspace.ts's
-- existing `select("*")` on agent_configs would break if SELECT were
-- restricted here, which restricting it buys nothing to justify.
REVOKE INSERT, UPDATE ON public.agent_configs FROM authenticated;

GRANT INSERT (
  organization_id, business_id, agent_name, primary_language,
  voice_id, greetings, capabilities, objectives
) ON public.agent_configs TO authenticated;

GRANT UPDATE (
  agent_name, persona, primary_language, voice_id, speaking_pace,
  multilingual, after_hours_behavior, transfer_number,
  custom_personality, capabilities, greetings
) ON public.agent_configs TO authenticated;

-- ============================================================
-- 2. telephony_connections — Klyro connection -> Sarvam connection mapping
-- ============================================================
ALTER TABLE public.telephony_connections
  ADD COLUMN IF NOT EXISTS provider_connection_id text;

-- Prevents one Sarvam connection from being bound to two different Klyro
-- telephony_connections rows (a real tenant-confusion risk even though
-- Sarvam itself has no exposed API to enumerate/validate this — the
-- constraint is Klyro's own safety net against an admin data-entry
-- mistake). No SELECT restriction, matching phone_numbers.provider_number_id
-- (already exposed to authenticated customers) and this table's existing
-- blanket SELECT grant — same reasoning as agent_configs above.
CREATE UNIQUE INDEX IF NOT EXISTS idx_telephony_connections_provider_connection_id
  ON public.telephony_connections (provider, provider_connection_id)
  WHERE provider_connection_id IS NOT NULL;

-- Already admin/service-role-write-only (no authenticated INSERT/UPDATE
-- grant on this table since it was created) — unchanged, no new grant
-- needed for the new column.

-- ============================================================
-- 3. phone_numbers — Klyro number -> Sarvam deployment mapping
-- ============================================================
ALTER TABLE public.phone_numbers
  ADD COLUMN IF NOT EXISTS provider_deployment_id text;

-- Deliberately NOT unique: a single Sarvam deployment's connection_configs
-- can bind MULTIPLE phone numbers at once (per the verified deployment
-- request shape), so multiple phone_numbers rows legitimately sharing one
-- provider_deployment_id is the correct, expected shape — a unique
-- constraint here would reject a legitimate multi-number deployment the
-- moment its second number was recorded. Plain index only, for "find every
-- number under deployment X" lookups.
CREATE INDEX IF NOT EXISTS idx_phone_numbers_provider_deployment_id
  ON public.phone_numbers (provider_deployment_id) WHERE provider_deployment_id IS NOT NULL;

-- Already admin/service-role-write-only — unchanged, no new grant needed.
