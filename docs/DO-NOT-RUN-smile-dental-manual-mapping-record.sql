-- ============================================================================
-- DO NOT RUN. NON-EXECUTABLE DRAFT. NOT REVIEWED.
-- It refuses to run until a reviewer edits the attestation below, and even
-- then it is a manual record, NOT a verification.
-- ============================================================================
-- THE ONLY APPROVED VERIFICATION METHOD is the admin action
-- "Re-verify live deployment" (after deploying commit 43b0aab, for VAA-000002).
-- That action reads the deployment from Sarvam itself, checks deployment id,
-- agent, version, number, status and webhook, and writes the verified fields
-- only if every check passes. Nothing else verifies a mapping.
--
-- PROHIBITED: using this SQL as a substitute for that admin action, or
-- instead of it, or to skip it. Running this file never removes the need to
-- run "Re-verify live deployment".
--
-- WARNING: this file writes the same four fields the admin action writes. Once
-- they are filled in manually, the admin dashboard shows the number as having
-- a "verified mapping" and the admission gate serves business data, WITHOUT
-- ClickAI having proved Sarvam's actual deployment state. Only the audit row
-- (LIVE_MAPPING_RECORDED_MANUALLY, sarvam_verified_by_clickai = false) shows
-- the difference.
--
-- What this draft does: records Smile Dental's existing mapping in the four
-- fields added by migration 20261114130000 (phone_numbers.verified_deployment_id,
-- verified_sarvam_app_id, verified_sarvam_app_version, deployment_verified_at)
-- and writes one audit row, so the inbound admission gate keeps serving its
-- business data during the short gap between the code deploy and the admin
-- re-verification. It changes NOTHING in Sarvam and does not change routing.
--
-- The values it writes come from ClickAI's own audited records, not from
-- Sarvam. The reviewer attestation is a person's note, never proof that
-- Sarvam was checked. The record is provisional: the admin "Re-verify live
-- deployment" action MUST still be run straight after the deploy; it either
-- confirms the mapping or clears it (fail closed) if Sarvam disagrees.
--
-- Values come from the read-only production audit of 2026-11-14 (no guesses):
--   organization        VAA-000002 (organizations.id begins 5669e43f)
--   agent_configs.id    begins b2972814
--     sarvam_app_id       Conversatio-9c6a04cd-3334
--     sarvam_app_version  5
--   phone_numbers.id    begins b17dc55c
--     e164 ends 0061, provider 'sarvam', status 'active', inbound_enabled true
--     provider_deployment_id  Smile-Denta-be071be0-703e
--     connection_id begins e16a623b
--   Other rows on that deployment: none. Other non-released Sarvam numbers in
--   the organization: none (its second active number has provider 'Vobiz').
--
-- REQUIRED BEFORE RUNNING (manual review):
--   [ ] Migration 20261114130000 is applied (the precondition block checks).
--   [ ] One approved READ-ONLY Sarvam read of deployment
--       Smile-Denta-be071be0-703e (GET .../deployments/{id}) confirms ALL of:
--         status = active
--         app_id = Conversatio-9c6a04cd-3334
--         app_version = 5
--         the deployment routes the number ending 0061
--         webhook_config.url is set
--   [ ] The reviewer replaces REVIEWER_ATTESTATION_NOT_PROVIDED below with a
--       short note of who reviewed this file and where the Sarvam read result
--       is kept (no secrets, no personal data). This note is an attestation
--       by a person, recorded in the audit row as such; it does NOT prove the
--       Sarvam read happened or passed.
--   [ ] A second person has read this file.
--   [ ] The admin "Re-verify live deployment" action is scheduled to run
--       straight after the code deploy.
-- If any Sarvam value differs, STOP: do not run this file; investigate.
--
-- Execution: one transaction. Every precondition raises and aborts the whole
-- transaction (nothing is written) if it does not hold. The UPDATE is also
-- guarded by the same conditions and must touch exactly one row.
-- ============================================================================

BEGIN;

DO $$
DECLARE
  -- Reviewer: replace the text below with your attestation note (see the checklist).
  -- It is stored as an attestation, never as proof of a Sarvam verification.
  reviewer_attestation constant text := 'REVIEWER_ATTESTATION_NOT_PROVIDED';
  expected_deployment constant text := 'Smile-Denta-be071be0-703e';
  expected_app_id constant text := 'Conversatio-9c6a04cd-3334';
  expected_app_version constant integer := 5;
  n record;
  a record;
  o record;
  sarvam_numbers integer;
  sharers integer;
  updated integer;
BEGIN
  IF reviewer_attestation = 'REVIEWER_ATTESTATION_NOT_PROVIDED'
     OR length(btrim(reviewer_attestation)) < 10 THEN
    RAISE EXCEPTION 'REVIEW_REQUIRED: this is a non-executable draft until a reviewer completes the checklist and attestation';
  END IF;

  -- Precondition: migration 20261114130000 applied.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'phone_numbers'
       AND column_name = 'verified_deployment_id'
  ) THEN
    RAISE EXCEPTION 'PRECONDITION: migration 20261114130000 is not applied';
  END IF;

  -- Precondition: exactly one non-released row on this deployment, and it is the audited one.
  SELECT count(*) INTO sharers FROM public.phone_numbers
   WHERE provider_deployment_id = expected_deployment AND status <> 'released';
  IF sharers <> 1 THEN
    RAISE EXCEPTION 'PRECONDITION: % non-released rows use deployment %, expected 1', sharers, expected_deployment;
  END IF;
  SELECT * INTO n FROM public.phone_numbers
   WHERE provider_deployment_id = expected_deployment AND status <> 'released';
  IF left(n.id::text, 8) <> 'b17dc55c'
     OR left(n.organization_id::text, 8) <> '5669e43f'
     OR left(n.agent_config_id::text, 8) <> 'b2972814'
     OR left(coalesce(n.connection_id::text, ''), 8) <> 'e16a623b'
     OR right(n.e164, 4) <> '0061'
     OR n.provider <> 'sarvam'
     OR n.status <> 'active'
     OR n.inbound_enabled IS NOT TRUE THEN
    RAISE EXCEPTION 'PRECONDITION: the number on % does not match the audited record', expected_deployment;
  END IF;

  -- Precondition: not verified yet, not blocked (this file only fills empty fields).
  IF n.verified_deployment_id IS NOT NULL OR n.verified_sarvam_app_id IS NOT NULL
     OR n.verified_sarvam_app_version IS NOT NULL OR n.deployment_verified_at IS NOT NULL THEN
    RAISE EXCEPTION 'PRECONDITION: a verified mapping is already recorded; nothing to do';
  END IF;
  IF n.admission_blocked_at IS NOT NULL THEN
    RAISE EXCEPTION 'PRECONDITION: the number is admission-blocked; investigate before verifying';
  END IF;

  -- Precondition: the agent mapping is exactly the audited one.
  SELECT * INTO a FROM public.agent_configs WHERE id = n.agent_config_id;
  IF a.id IS NULL OR a.organization_id <> n.organization_id
     OR a.sarvam_app_id IS DISTINCT FROM expected_app_id
     OR a.sarvam_app_version IS DISTINCT FROM expected_app_version THEN
    RAISE EXCEPTION 'PRECONDITION: agent mapping is not % v%', expected_app_id, expected_app_version;
  END IF;

  -- Precondition: one Sarvam number in the organization (the gate's invariant), live organization.
  SELECT count(*) INTO sarvam_numbers FROM public.phone_numbers
   WHERE organization_id = n.organization_id AND provider = 'sarvam' AND status <> 'released';
  IF sarvam_numbers <> 1 THEN
    RAISE EXCEPTION 'PRECONDITION: organization has % non-released Sarvam numbers, expected 1', sarvam_numbers;
  END IF;
  SELECT * INTO o FROM public.organizations WHERE id = n.organization_id;
  IF o.lifecycle_status IN ('suspended', 'cancelled', 'archived') THEN
    RAISE EXCEPTION 'PRECONDITION: organization is %', o.lifecycle_status;
  END IF;

  -- The one-row update, guarded by the same conditions.
  UPDATE public.phone_numbers
     SET verified_deployment_id = expected_deployment,
         verified_sarvam_app_id = expected_app_id,
         verified_sarvam_app_version = expected_app_version,
         deployment_verified_at = now()
   WHERE id = n.id
     AND organization_id = n.organization_id
     AND agent_config_id = a.id
     AND provider = 'sarvam'
     AND status = 'active'
     AND inbound_enabled
     AND provider_deployment_id = expected_deployment
     AND verified_deployment_id IS NULL
     AND admission_blocked_at IS NULL;
  GET DIAGNOSTICS updated = ROW_COUNT;
  IF updated <> 1 THEN
    RAISE EXCEPTION 'UPDATE_GUARD: expected 1 row, updated %', updated;
  END IF;

  -- Audit trail (no secrets, no personal data). Deliberately NOT the action the
  -- admin re-verification writes: this is a manual record, not a verification.
  INSERT INTO public.audit_logs (action, entity_type, entity_id, organization_id, new_value, reason)
  VALUES (
    'LIVE_MAPPING_RECORDED_MANUALLY',
    'phone_number',
    n.id,
    n.organization_id,
    jsonb_build_object(
      'deployment_id', expected_deployment,
      'sarvam_app_id', expected_app_id,
      'sarvam_app_version', expected_app_version,
      'via', 'manual_sql_rollout',
      'sarvam_verified_by_clickai', false,
      'pending_admin_reverify', true
    ),
    'Manual record of the existing live mapping for the admission-gate rollout; '
      || 'provisional until the admin Re-verify live deployment action runs. '
      || 'Reviewer attestation (not a verification): ' || reviewer_attestation
  );
END $$;

-- In-transaction check: the admission gate's conditions now hold (expect one row, admitted = true).
SELECT right(n.e164, 4) AS number_suffix,
       n.provider_deployment_id,
       n.verified_sarvam_app_id,
       n.verified_sarvam_app_version,
       (n.status = 'active' AND n.inbound_enabled
         AND n.verified_deployment_id = n.provider_deployment_id
         AND n.verified_sarvam_app_id = a.sarvam_app_id
         AND n.verified_sarvam_app_version = a.sarvam_app_version
         AND n.admission_blocked_at IS NULL) AS admitted
  FROM public.phone_numbers n
  JOIN public.agent_configs a ON a.id = n.agent_config_id
 WHERE n.provider_deployment_id = 'Smile-Denta-be071be0-703e' AND n.status <> 'released';

COMMIT;

-- ----------------------------------------------------------------------------
-- Post-commit verification (read-only; run separately):
--
--   SELECT right(e164, 4) AS number_suffix, status, inbound_enabled,
--          provider_deployment_id, verified_deployment_id,
--          verified_sarvam_app_id, verified_sarvam_app_version,
--          deployment_verified_at IS NOT NULL AS verified_at_set,
--          admission_blocked_at
--     FROM public.phone_numbers
--    WHERE provider_deployment_id = 'Smile-Denta-be071be0-703e';
--   -- expect: active | true | Smile-Denta-be071be0-703e | Smile-Denta-be071be0-703e
--   --         | Conversatio-9c6a04cd-3334 | 5 | true | NULL
--
--   SELECT action, created_at FROM public.audit_logs
--    WHERE action = 'LIVE_MAPPING_RECORDED_MANUALLY' ORDER BY created_at DESC LIMIT 1;
--
--   Then, straight after the code deploy (REQUIRED): run the admin action
--   "Re-verify live deployment" for VAA-000002 and expect "verified" plus an
--   audit row LIVE_DEPLOYMENT_REVERIFIED. Only that confirms the mapping
--   against Sarvam. Then one approved agent context request or test call from
--   the listed test caller must get business context (HTTP 200).
--
-- Undo (returns the row to its pre-update state; the gate then refuses again):
--
--   UPDATE public.phone_numbers
--      SET verified_deployment_id = NULL, verified_sarvam_app_id = NULL,
--          verified_sarvam_app_version = NULL, deployment_verified_at = NULL
--    WHERE provider_deployment_id = 'Smile-Denta-be071be0-703e'
--      AND verified_deployment_id = 'Smile-Denta-be071be0-703e';
-- ----------------------------------------------------------------------------
