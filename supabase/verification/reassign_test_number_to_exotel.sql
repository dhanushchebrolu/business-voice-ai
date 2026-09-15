-- ============================================================================
-- Klyro AI — Reviewed SQL: reassign a single phone number to the Exotel
-- runtime (NOT auto-applied by any code path — an admin must read this and
-- run it manually, once, against the correct project)
-- ============================================================================
--
-- WHY THIS EXISTS
--   +917965853287 currently has phone_numbers.provider = 'sarvam'. That
--   value means "Sarvam Voice Agents runs this call end-to-end" (the
--   Sarvam-*managed* telephony path — see telephony.server.ts's
--   TELEPHONY_PROVIDERS and provisioning-state.ts). The Klyro-owned runtime
--   this task implements (Exotel telephony + voice-runtime.server.ts's own
--   Sarvam STT/LLM/TTS orchestration — see klyro-runtime-readiness.ts)
--   requires provider = 'exotel' instead: Sarvam there is an AI backend,
--   never the telephony carrier, and no sarvam_app_id/sarvam_app_version
--   mapping is needed or read for that path (see agent-status.ts).
--
--   Per explicit instruction, this number is being treated as a test/demo
--   number for now — nothing in the application code mutates a real
--   customer's phone_numbers.provider automatically. This script is the
--   reviewed, human-run alternative: read it, confirm the BEFORE query
--   shows what you expect, run the UPDATE, confirm the AFTER query.
--
-- SAFETY
--   - Touches exactly one row, matched by e164 AND the expected current
--     provider (the WHERE clause is intentionally narrow — if the row has
--     already been changed, or looks different than expected, this UPDATE
--     matches zero rows and does nothing, rather than surprising anyone).
--   - Does not touch connection_id, agent_config_id, provider_deployment_id,
--     status, inbound_enabled, or outbound_enabled — only the provider
--     column. Exotel telephony transport wiring (webhook base URL, Exotel
--     credentials) is a separate, already-existing prerequisite tracked by
--     computeKlyroRuntimeReadiness(), not something this script can or
--     should fabricate.
--   - No DELETE, no DROP, no schema change. Reversible: the "-- ROLLBACK"
--     statement at the bottom restores the prior value if needed.
--   - Run the BEFORE query first. If e164, organization_id, or the current
--     provider don't match what you expect for this specific number, STOP
--     and investigate rather than running the UPDATE blind.
--
-- ============================================================================

-- 1) BEFORE — confirm this is the exact row you intend to change.
select
  id,
  e164,
  organization_id,
  business_id,
  provider,
  status,
  connection_id,
  agent_config_id,
  provider_deployment_id
from phone_numbers
where e164 = '+917965853287';

-- 2) UPDATE — only runs if the row is still exactly what BEFORE showed
--    (provider = 'sarvam'). Matches at most one row.
update phone_numbers
set provider = 'exotel'
where e164 = '+917965853287'
  and provider = 'sarvam';

-- 3) AFTER — confirm exactly one row now shows provider = 'exotel'.
select
  id,
  e164,
  organization_id,
  business_id,
  provider,
  status
from phone_numbers
where e164 = '+917965853287';

-- ============================================================================
-- ROLLBACK — only if step 2 needs to be undone. Do not run alongside step 2.
-- ============================================================================
-- update phone_numbers
-- set provider = 'sarvam'
-- where e164 = '+917965853287'
--   and provider = 'exotel';

-- ============================================================================
-- AFTER RUNNING THIS: the number alone does not make the Klyro-owned
-- runtime "ready" — computeKlyroRuntimeReadiness() (klyro-runtime-readiness.ts)
-- also requires EXOTEL_SID/EXOTEL_API_KEY/EXOTEL_TOKEN to be configured,
-- SARVAM_API_KEY present, this org's agent_configs.status to be 'ready' or
-- 'live', and TELEPHONY_WEBHOOK_BASE_URL to be set. Check the admin
-- Customer 360 page's "Klyro runtime" card for this organization after
-- running this script to see exactly what (if anything) is still missing.
-- ============================================================================
