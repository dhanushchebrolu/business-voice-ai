-- Shared Sarvam call slots.
--
-- Sarvam allows a fixed number of simultaneous calls on the account (default
-- 4). Until now only each customer's own in-flight calls were limited, so
-- campaigns of different customers (and a campaign plus a single call) could
-- together exceed the account limit. This adds one limit that every outbound
-- Sarvam call counts against, enforced atomically where the call row is written.
--
--   outbound_concurrency()   what the dispatcher and admin pages read:
--                            slot_limit, in_use, free.
--     slot_limit  platform_settings 'outbound.max_concurrent_calls' {"limit": N}
--                 (1..50), 4 when absent or unreadable. Set it to the account's
--                 real Sarvam concurrency.
--     in_use      Sarvam outbound calls not finished (initiated, ringing,
--                 answered, in_progress, outcome_unknown) that started in the last
--                 15 minutes, across every organization, plus inbound Sarvam calls
--                 live right now. A call whose end never arrived stops holding its
--                 slot after those windows, so a lost webhook cannot block dialling.
--                 An inbound call is live from its `context` request until the agent
--                 reports its outcome or its result is recorded, at most 30 minutes.
--
--   trg_call_logs_outbound_concurrency
--                            BEFORE INSERT on a new Sarvam outbound call row:
--                            takes one global advisory lock, counts, and refuses
--                            the insert (SQLSTATE PC001, message starting
--                            PROVIDER_CONCURRENCY_LIMIT) when no slot is free.
--                            Because it runs inside the admission functions'
--                            transaction, a refusal rolls back the whole admission:
--                            nothing is reserved, charged or written. The lock is
--                            always taken after the customer's own lock and held to
--                            the end of the transaction, so overlapping dispatch runs,
--                            several campaigns and single calls all see one count.
--
-- Additive: two functions and one trigger; no table or column changes.
-- Rollback:
--   DROP TRIGGER IF EXISTS trg_call_logs_outbound_concurrency ON public.call_logs;
--   DROP FUNCTION IF EXISTS public.enforce_outbound_concurrency();
--   DROP FUNCTION IF EXISTS public.outbound_concurrency();

CREATE OR REPLACE FUNCTION public.outbound_concurrency()
RETURNS TABLE (slot_limit integer, in_use integer, free integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH cfg AS (
    SELECT COALESCE(
             (SELECT LEAST(GREATEST((s.value ->> 'limit')::integer, 1), 50)
                FROM public.platform_settings s
               WHERE s.key = 'outbound.max_concurrent_calls'
                 AND (s.value ->> 'limit') ~ '^[0-9]{1,3}$'),
             4) AS lim
  ),
  outbound AS (
    SELECT count(*) AS n
      FROM public.call_logs c
     WHERE c.provider = 'sarvam'
       AND c.direction = 'outbound'
       AND c.status IN ('initiated', 'ringing', 'answered', 'in_progress', 'outcome_unknown')
       AND c.started_at > now() - interval '15 minutes'
  ),
  inbound AS (
    SELECT count(*) AS n
      FROM (
        SELECT e.integration_id, e.interaction_id
          FROM public.sarvam_agent_events e
          JOIN public.sarvam_agent_integrations i
            ON i.id = e.integration_id AND i.role = 'inbound'
         WHERE e.kind = 'context' AND e.status = 'ok' AND e.interaction_id IS NOT NULL
           AND e.created_at > now() - interval '30 minutes'
           AND e.created_at <= now()
         GROUP BY e.integration_id, e.interaction_id
      ) s
     WHERE NOT EXISTS (
             SELECT 1 FROM public.sarvam_agent_events o
              WHERE o.integration_id = s.integration_id
                AND o.interaction_id = s.interaction_id
                AND o.kind = 'call_outcome' AND o.status = 'ok')
       AND NOT EXISTS (
             SELECT 1 FROM public.call_logs c
              WHERE c.provider = 'sarvam'
                AND (c.provider_call_id = s.interaction_id
                     OR c.provider_metadata ->> 'interaction_id' = s.interaction_id)
                AND c.ended_at IS NOT NULL)
  )
  SELECT cfg.lim,
         (outbound.n + inbound.n)::integer,
         GREATEST(cfg.lim - (outbound.n + inbound.n), 0)::integer
    FROM cfg, outbound, inbound;
$$;

CREATE OR REPLACE FUNCTION public.enforce_outbound_concurrency()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  slots record;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('clickai.outbound_concurrency', 0));
  SELECT * INTO slots FROM public.outbound_concurrency();
  IF slots.in_use >= slots.slot_limit THEN
    RAISE EXCEPTION 'PROVIDER_CONCURRENCY_LIMIT: % of % call slots are in use', slots.in_use, slots.slot_limit
      USING ERRCODE = 'PC001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_call_logs_outbound_concurrency ON public.call_logs;
CREATE TRIGGER trg_call_logs_outbound_concurrency
  BEFORE INSERT ON public.call_logs
  FOR EACH ROW
  WHEN (NEW.provider = 'sarvam' AND NEW.direction = 'outbound'
        AND NEW.status IN ('initiated', 'ringing', 'answered', 'in_progress'))
  EXECUTE FUNCTION public.enforce_outbound_concurrency();

REVOKE ALL ON FUNCTION public.outbound_concurrency() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.outbound_concurrency() TO service_role;
REVOKE ALL ON FUNCTION public.enforce_outbound_concurrency() FROM PUBLIC, anon, authenticated;
