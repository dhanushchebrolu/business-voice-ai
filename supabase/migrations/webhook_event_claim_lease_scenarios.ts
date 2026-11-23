/**
 * SQL for 20261126090000_webhook_event_claim_lease.sql, shared by the CI
 * PostgreSQL test (webhook_event_claim_lease.pg.test.ts) and the local QA
 * database run. Everything uses its own synthetic organization and is meant
 * to run inside BEGIN ... ROLLBACK (scenarios) or be deleted afterwards
 * (concurrency fixtures).
 *
 * A "crash" is a claim that is never completed; lease expiry is simulated by
 * moving claimed_at back past the 120 s lease (the functions read
 * clock_timestamp(), so nothing else needs faking).
 */

export const LEASE = 120;

/** One organization, number, Sarvam outbound call (initiated, attempt id known) and a wallet. */
export function fixtureSql(p: { org: string; call: string; attempt: string }): string {
  // Setup reads auth.users (owner-only on Supabase), so it runs as the database owner;
  // everything after it runs as service_role, like the app.
  return `
RESET ROLE;
INSERT INTO public.organizations (id, name, owner_id)
VALUES ('${p.org}', 'QA WEBHOOK CLAIM (temporary)', (SELECT id FROM auth.users ORDER BY created_at LIMIT 1));
INSERT INTO public.wallet_transactions (organization_id, amount, kind, description)
VALUES ('${p.org}', 10000, 'topup', 'QA webhook claim credit');
INSERT INTO public.call_logs (id, organization_id, provider, direction, status, caller_number,
  destination_number, provider_call_id, started_at, billing_cap_minutes, billing_rate_per_minute)
VALUES ('${p.call}', '${p.org}', 'sarvam', 'outbound', 'initiated', '+915559990001',
  '+915559993001', '${p.attempt}', now(), 5, 400);
SET ROLE service_role;
`;
}

/** The status write a "connected" result makes (what applyCallEvent sends). */
export const COMPLETED_PATCH = `'{"status":"completed","duration_seconds":130,"ended_at":"2026-11-22T06:30:00Z","resolution_source":"provider","final_agent_variables":{}}'::jsonb`;

/** One full finalization pass (what finalizeTerminalCall does): bill 3 min at 400, campaign step, complete. */
export function finalizeSql(call: string): string {
  return `SELECT coalesce((
    SELECT public.apply_call_billing('${call}', t, 1200, 900, 'INR', 3, 'outbound call · 3 min')
      || ':' || (public.apply_call_campaign_outcome('${call}', t, NULL, NULL, '{}'::jsonb, false, 'warm', NULL) ->> 'result')
      || ':' || public.complete_call_finalization('${call}', t)::text
    FROM (SELECT public.claim_call_finalization('${call}', 120) AS t) x WHERE t IS NOT NULL), 'no_lease');`;
}

export const claimSql = (eventId: string, max: string = "10") =>
  `SELECT public.claim_webhook_event('sarvam', '${eventId}', 'completed', '{}'::jsonb, ${LEASE}, ${max});`;

/**
 * Deterministic single-session scenarios. Raises on the first failed check;
 * prints ALL_OK at the end. Covers each crash boundary, fencing, the operator,
 * the attempt cap, legacy stuck rows and the shared table's other users.
 */
export const CLAIM_SCENARIOS_SQL = `
RESET ROLE;
DO $scenarios$
DECLARE
  org uuid := gen_random_uuid();
  c uuid; r jsonb; t1 uuid; t2 uuid; t3 uuid; s text; n integer;
  owner uuid := (SELECT id FROM auth.users ORDER BY created_at LIMIT 1);
  ok_count integer := 0;
BEGIN
  INSERT INTO public.organizations (id, name, owner_id) VALUES (org, 'QA CLAIM SCENARIOS', owner);
  INSERT INTO public.wallet_transactions (organization_id, amount, kind, description)
  VALUES (org, 100000, 'topup', 'scenario credit');
  -- The rest runs as the app does (service_role); only the owner lookup above needs more.
  EXECUTE 'SET LOCAL ROLE service_role';

  ------------------------------------------------------------------ 1
  -- Crash right after receipt (claim recorded, nothing applied).
  c := gen_random_uuid();
  INSERT INTO public.call_logs (id, organization_id, provider, direction, status, destination_number,
    provider_call_id, started_at, billing_cap_minutes, billing_rate_per_minute)
  VALUES (c, org, 'sarvam', 'outbound', 'initiated', '+915559994001', 'att_s1', now(), 5, 400);
  r := public.claim_webhook_event('sarvam', 'att_s1', 'completed', '{}', 120, 10);
  IF r->>'result' <> 'claimed' OR (r->>'attempt')::int <> 1 THEN RAISE EXCEPTION 'S1 first claim: %', r; END IF;
  t1 := (r->>'token')::uuid;
  -- (crash) A redelivery inside the lease: someone else holds it.
  r := public.claim_webhook_event('sarvam', 'att_s1', 'completed', '{}', 120, 10);
  IF r->>'result' <> 'in_progress' THEN RAISE EXCEPTION 'S1 within lease: %', r; END IF;
  -- Lease expires; the redelivery takes over with a new token.
  UPDATE public.webhook_events SET claimed_at = claimed_at - interval '121 seconds' WHERE event_id = 'att_s1';
  r := public.claim_webhook_event('sarvam', 'att_s1', 'completed', '{}', 120, 10);
  IF r->>'result' <> 'claimed' OR (r->>'reclaimed')::boolean IS NOT TRUE OR (r->>'attempt')::int <> 2 THEN
    RAISE EXCEPTION 'S1 takeover: %', r; END IF;
  t2 := (r->>'token')::uuid;
  -- The crashed (stale) processor wakes up: fenced out, writes nothing.
  s := public.apply_call_event_fenced('sarvam', 'att_s1', t1, c, ${COMPLETED_PATCH});
  IF s <> 'claim_lost' THEN RAISE EXCEPTION 'S1 stale apply: %', s; END IF;
  IF (SELECT status FROM public.call_logs WHERE id = c) <> 'initiated' THEN RAISE EXCEPTION 'S1 stale wrote'; END IF;
  UPDATE public.webhook_events SET processed_at = now() WHERE event_id = 'att_s1' AND claim_token = t1;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'S1 stale completed the event'; END IF;
  -- The new holder applies and completes.
  s := public.apply_call_event_fenced('sarvam', 'att_s1', t2, c, ${COMPLETED_PATCH});
  IF s <> 'applied' THEN RAISE EXCEPTION 'S1 apply: %', s; END IF;
  IF (SELECT status || ':' || duration_seconds || ':' || finalization_state FROM public.call_logs WHERE id = c)
     <> 'completed:130:pending' THEN RAISE EXCEPTION 'S1 call row: %', (SELECT row_to_json(l) FROM public.call_logs l WHERE id = c); END IF;
  UPDATE public.webhook_events SET processed_at = now(), error = NULL WHERE event_id = 'att_s1' AND claim_token = t2 AND processed_at IS NULL;
  -- Re-delivery after completion: duplicate.
  r := public.claim_webhook_event('sarvam', 'att_s1', 'completed', '{}', 120, 10);
  IF r->>'result' <> 'processed' THEN RAISE EXCEPTION 'S1 replay: %', r; END IF;
  ok_count := ok_count + 1;

  ------------------------------------------------------------------ 2
  -- Crash after the status write, before finalization / completion.
  c := gen_random_uuid();
  INSERT INTO public.call_logs (id, organization_id, provider, direction, status, destination_number,
    provider_call_id, started_at, billing_cap_minutes, billing_rate_per_minute)
  VALUES (c, org, 'sarvam', 'outbound', 'initiated', '+915559994002', 'att_s2', now(), 5, 400);
  t1 := (public.claim_webhook_event('sarvam', 'att_s2', 'completed', '{}', 120, 10)->>'token')::uuid;
  IF public.apply_call_event_fenced('sarvam', 'att_s2', t1, c, ${COMPLETED_PATCH}) <> 'applied' THEN RAISE EXCEPTION 'S2 apply'; END IF;
  -- (crash) Recovery takes over: the call is already final, nothing is rewritten.
  UPDATE public.webhook_events SET claimed_at = claimed_at - interval '121 seconds' WHERE event_id = 'att_s2';
  t2 := (public.claim_webhook_event('sarvam', 'att_s2', 'completed', '{}', 120, 10)->>'token')::uuid;
  s := public.apply_call_event_fenced('sarvam', 'att_s2', t2, c,
       '{"status":"failed","duration_seconds":0}'::jsonb);
  IF s <> 'already_final' THEN RAISE EXCEPTION 'S2 recovery apply: %', s; END IF;
  IF (SELECT status FROM public.call_logs WHERE id = c) <> 'completed' THEN RAISE EXCEPTION 'S2 final overwritten'; END IF;
  -- Finalization (still pending from the trigger) runs once; a recovery pass bills nothing.
  t3 := public.claim_call_finalization(c, 120);
  IF t3 IS NULL THEN RAISE EXCEPTION 'S2 no finalization lease'; END IF;
  IF public.apply_call_billing(c, t3, 1200, 900, 'INR', 3, 'outbound call · 3 min') <> 'applied' THEN RAISE EXCEPTION 'S2 billing'; END IF;
  PERFORM public.apply_call_campaign_outcome(c, t3, NULL, NULL, '{}'::jsonb, false, 'warm', NULL);
  IF NOT public.complete_call_finalization(c, t3) THEN RAISE EXCEPTION 'S2 complete'; END IF;
  -- Crash after finalization, before the event is completed: recovery takes over again.
  UPDATE public.webhook_events SET claimed_at = claimed_at - interval '121 seconds' WHERE event_id = 'att_s2';
  t2 := (public.claim_webhook_event('sarvam', 'att_s2', 'completed', '{}', 120, 10)->>'token')::uuid;
  IF public.apply_call_event_fenced('sarvam', 'att_s2', t2, c, ${COMPLETED_PATCH}) <> 'already_final' THEN RAISE EXCEPTION 'S2 third apply'; END IF;
  IF public.claim_call_finalization(c, 120) IS NOT NULL THEN RAISE EXCEPTION 'S2 finalized twice'; END IF;
  UPDATE public.webhook_events SET processed_at = now() WHERE event_id = 'att_s2' AND claim_token = t2;
  IF (SELECT count(*) || ':' || sum(amount) FROM public.wallet_transactions
        WHERE organization_id = org AND kind = 'call_usage' AND reference = c::text) <> '1:-1200' THEN
    RAISE EXCEPTION 'S2 ledger'; END IF;
  ok_count := ok_count + 1;

  ------------------------------------------------------------------ 3
  -- Operator resolution vs a stale webhook processor (same attempt key).
  c := gen_random_uuid();
  INSERT INTO public.call_logs (id, organization_id, provider, direction, status, destination_number,
    provider_call_id, started_at, billing_cap_minutes, billing_rate_per_minute)
  VALUES (c, org, 'sarvam', 'outbound', 'initiated', '+915559994003', 'att_s3', now(), 5, 400);
  t1 := (public.claim_webhook_event('sarvam', 'att_s3', 'completed', '{}', 120, 10)->>'token')::uuid;
  -- The webhook processor hangs; its lease expires; the operator (no cap) takes over.
  UPDATE public.webhook_events SET claimed_at = claimed_at - interval '121 seconds' WHERE event_id = 'att_s3';
  r := public.claim_webhook_event('sarvam', 'att_s3', 'no_answer', '{"source":"operator_resolution"}', 120, NULL);
  IF r->>'result' <> 'claimed' THEN RAISE EXCEPTION 'S3 operator claim: %', r; END IF;
  t2 := (r->>'token')::uuid;
  IF public.apply_call_event_fenced('sarvam', 'att_s3', t2, c,
       '{"status":"no_answer","resolution_source":"operator"}'::jsonb) <> 'applied' THEN RAISE EXCEPTION 'S3 operator apply'; END IF;
  -- The stale webhook processor wakes up: it can't write over the operator's decision.
  s := public.apply_call_event_fenced('sarvam', 'att_s3', t1, c, ${COMPLETED_PATCH});
  IF s <> 'claim_lost' THEN RAISE EXCEPTION 'S3 stale apply: %', s; END IF;
  UPDATE public.webhook_events SET processed_at = now() WHERE event_id = 'att_s3' AND claim_token = t2;
  -- A later webhook for that attempt is a duplicate; the decision stands.
  IF public.claim_webhook_event('sarvam', 'att_s3', 'completed', '{}', 120, 10)->>'result' <> 'processed' THEN RAISE EXCEPTION 'S3 replay'; END IF;
  IF (SELECT status || ':' || resolution_source FROM public.call_logs WHERE id = c) <> 'no_answer:operator' THEN
    RAISE EXCEPTION 'S3 operator outcome changed'; END IF;
  ok_count := ok_count + 1;

  ------------------------------------------------------------------ 4
  -- A failure during recovery stays recoverable at once; the cap stops automatic loops.
  c := gen_random_uuid();
  INSERT INTO public.call_logs (id, organization_id, provider, direction, status, destination_number,
    provider_call_id, started_at, billing_cap_minutes, billing_rate_per_minute)
  VALUES (c, org, 'sarvam', 'outbound', 'initiated', '+915559994004', 'att_s4', now(), 5, 400);
  t1 := (public.claim_webhook_event('sarvam', 'att_s4', 'completed', '{}', 120, 3)->>'token')::uuid;
  UPDATE public.webhook_events SET error = 'boom 1' WHERE event_id = 'att_s4' AND claim_token = t1;
  r := public.claim_webhook_event('sarvam', 'att_s4', 'completed', '{}', 120, 3);
  IF r->>'result' <> 'claimed' OR (r->>'attempt')::int <> 2 THEN RAISE EXCEPTION 'S4 retry after error: %', r; END IF;
  UPDATE public.webhook_events SET error = 'boom 2' WHERE event_id = 'att_s4' AND claim_token = (r->>'token')::uuid;
  r := public.claim_webhook_event('sarvam', 'att_s4', 'completed', '{}', 120, 3);
  IF (r->>'attempt')::int <> 3 THEN RAISE EXCEPTION 'S4 third: %', r; END IF;
  UPDATE public.webhook_events SET error = 'boom 3' WHERE event_id = 'att_s4' AND claim_token = (r->>'token')::uuid;
  r := public.claim_webhook_event('sarvam', 'att_s4', 'completed', '{}', 120, 3);
  IF r->>'result' <> 'exhausted' OR r->>'error' <> 'boom 3' THEN RAISE EXCEPTION 'S4 cap: %', r; END IF;
  -- An operator is never capped.
  r := public.claim_webhook_event('sarvam', 'att_s4', 'failed', '{}', 120, NULL);
  IF r->>'result' <> 'claimed' OR (r->>'attempt')::int <> 4 THEN RAISE EXCEPTION 'S4 operator: %', r; END IF;
  ok_count := ok_count + 1;

  ------------------------------------------------------------------ 5
  -- A row stuck BEFORE this migration (no claim columns set) becomes recoverable.
  INSERT INTO public.webhook_events (provider, event_id, event_type, payload, created_at)
  VALUES ('sarvam', 'att_s5', 'completed', '{}', now() - interval '1 hour');
  r := public.claim_webhook_event('sarvam', 'att_s5', 'completed', '{}', 120, 10);
  IF r->>'result' <> 'claimed' OR (r->>'attempt')::int <> 1 THEN RAISE EXCEPTION 'S5 legacy: %', r; END IF;
  -- A fresh legacy-style row (created now, no claim) counts as claimed at created_at.
  INSERT INTO public.webhook_events (provider, event_id, event_type, payload) VALUES ('sarvam', 'att_s5b', 'completed', '{}');
  IF public.claim_webhook_event('sarvam', 'att_s5b', 'completed', '{}', 120, 10)->>'result' <> 'in_progress' THEN
    RAISE EXCEPTION 'S5 fresh legacy row taken too early'; END IF;
  ok_count := ok_count + 1;

  ------------------------------------------------------------------ 6
  -- The fenced write refuses columns it would otherwise drop silently.
  t1 := (public.claim_webhook_event('sarvam', 'att_s6', 'completed', '{}', 120, 10)->>'token')::uuid;
  BEGIN
    PERFORM public.apply_call_event_fenced('sarvam', 'att_s6', t1, c, '{"status":"completed","customer_charge":1}'::jsonb);
    RAISE EXCEPTION 'S6 accepted an unsupported column';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%unsupported column(s) customer_charge%' THEN RAISE; END IF;
  END;
  ok_count := ok_count + 1;

  ------------------------------------------------------------------ 7
  -- Other users of the shared table are unaffected: plain inserts still dedupe,
  -- their rows keep the defaults, and nothing they write is ever claimable by
  -- another provider's key.
  INSERT INTO public.webhook_events (provider, event_id, event_type, payload)
  VALUES ('vobiz_whatsapp', 'wa_s7', 'message', '{}'), ('instagram', 'ig_s7', 'message', '{}'),
         ('razorpay', 'rz_s7', 'payment.captured', '{"id":"x"}');
  BEGIN
    INSERT INTO public.webhook_events (provider, event_id, event_type, payload) VALUES ('instagram', 'ig_s7', 'message', '{}');
    RAISE EXCEPTION 'S7 duplicate accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  IF (SELECT count(*) FROM public.webhook_events WHERE event_id IN ('wa_s7','ig_s7','rz_s7')
        AND attempts = 0 AND claim_token IS NULL AND claimed_at IS NULL) <> 3 THEN RAISE EXCEPTION 'S7 defaults'; END IF;
  IF public.claim_webhook_event('sarvam', 'ig_s7', 'x', '{}', 120, 10)->>'result' <> 'claimed' THEN
    RAISE EXCEPTION 'S7 provider isolation'; END IF;
  IF (SELECT claim_token FROM public.webhook_events WHERE provider = 'instagram' AND event_id = 'ig_s7') IS NOT NULL THEN
    RAISE EXCEPTION 'S7 instagram row touched'; END IF;
  ok_count := ok_count + 1;

  ------------------------------------------------------------------ 8
  -- Ledger: across every scenario, at most one call_usage row per call.
  IF EXISTS (SELECT reference FROM public.wallet_transactions WHERE organization_id = org AND kind = 'call_usage'
             GROUP BY reference HAVING count(*) > 1) THEN RAISE EXCEPTION 'S8 duplicate ledger rows'; END IF;
  ok_count := ok_count + 1;

  RAISE NOTICE 'ALL_OK %', ok_count;
END $scenarios$;
`;
