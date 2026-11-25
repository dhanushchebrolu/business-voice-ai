-- Public "seconds of conversations handled" counter on the landing page.
--
-- One aggregate across every organization, returned to the server only
-- (service_role); the public endpoint hands the browser these numbers and
-- nothing else. No tenant, number, transcript or per-call value leaves here.
--
--   completed_seconds       sum of duration_seconds of calls that connected and
--                           finished (status 'completed', duration > 0). Failed,
--                           busy, no-answer and cancelled calls carry no
--                           conversation time and are excluded.
--   active_calls            calls connected right now (two sources, below).
--   active_elapsed_seconds  seconds those calls have been connected, as of as_of.
--
-- Live calls come from two sources, each with a real "connected" moment:
--
--   1. call_logs rows with status answered/in_progress and an answered_at stamp
--      and no end (providers that report an answer, e.g. the LiveKit voice path).
--
--   2. Sarvam calls. Sarvam sends no webhook while a call is live: its result
--      webhooks arrive after the call ends. What it does send, at the start of
--      the interaction, is the agent's own `context` request to ClickAI's agent
--      API (sarvam_agent_events kind 'context', status 'ok', with the
--      interaction_id), and an interaction exists only once the call has been
--      answered. That request's arrival time is the connected moment. It is an
--      indirect signal, not a Sarvam call-state event: a call whose agent app
--      doesn't make the request is simply not counted live (it is still counted
--      in full when it completes). A Sarvam call stops counting live when the
--      agent reports its outcome (record_call_outcome, the on-end hook) or when
--      its result webhook creates/updates a finished call_logs row, and it stops
--      after 30 minutes in any case, so a lost end signal cannot inflate the total.
--      One interaction counts once however many times `context` was requested.
--
-- A call is in exactly one group at any time: live groups never include a call
-- whose call_logs row has ended, so a finishing call moves from active_* into
-- completed_seconds and is never counted in both.
--
-- Rollback:
--   DROP FUNCTION IF EXISTS public.public_conversation_stats();
--   DROP INDEX IF EXISTS public.idx_call_logs_connected_seconds;
--   DROP INDEX IF EXISTS public.idx_sarvam_agent_events_live_context;

CREATE INDEX IF NOT EXISTS idx_call_logs_connected_seconds
  ON public.call_logs (duration_seconds)
  WHERE status = 'completed' AND duration_seconds > 0;

CREATE INDEX IF NOT EXISTS idx_sarvam_agent_events_live_context
  ON public.sarvam_agent_events (created_at)
  WHERE kind = 'context' AND status = 'ok' AND interaction_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.public_conversation_stats()
RETURNS TABLE (
  completed_seconds bigint,
  active_calls integer,
  active_elapsed_seconds bigint,
  as_of timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH live AS (
    SELECT c.answered_at AS since
      FROM public.call_logs c
     WHERE c.status IN ('answered', 'in_progress')
       AND c.answered_at IS NOT NULL
       AND c.ended_at IS NULL
       AND c.answered_at > now() - interval '2 hours'
       AND c.answered_at <= now()
    UNION ALL
    SELECT s.since
      FROM (
        SELECT e.integration_id, e.interaction_id, min(e.created_at) AS since
          FROM public.sarvam_agent_events e
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
                AND (c.ended_at IS NOT NULL OR c.status IN ('answered', 'in_progress')))
  )
  SELECT
    COALESCE((SELECT sum(c.duration_seconds)
                FROM public.call_logs c
               WHERE c.status = 'completed' AND c.duration_seconds > 0), 0)::bigint,
    (SELECT count(*) FROM live)::integer,
    COALESCE((SELECT sum(floor(extract(epoch FROM now() - l.since))) FROM live l), 0)::bigint,
    now();
$$;

REVOKE ALL ON FUNCTION public.public_conversation_stats() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.public_conversation_stats() TO service_role;
