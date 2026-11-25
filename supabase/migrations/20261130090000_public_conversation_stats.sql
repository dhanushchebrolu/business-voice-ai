-- Public "seconds of conversations handled" counter on the landing page.
--
-- One aggregate across every organization, returned to the server only
-- (service_role); the public endpoint hands the browser these four numbers and
-- nothing else. No tenant, number, transcript or per-call value leaves here.
--
--   completed_seconds       sum of duration_seconds of calls that connected and
--                           finished (status 'completed', duration > 0). Failed,
--                           busy, no-answer and cancelled calls carry no
--                           conversation time and are excluded.
--   active_calls            calls connected right now: status answered/in_progress
--                           with an answered_at stamp and no end. A call that was
--                           never closed stops counting after 2 hours.
--   active_elapsed_seconds  seconds those calls have been connected, as of as_of.
--
-- A call is in exactly one of the two groups (its status), so a call that ends
-- moves from active_* to completed_seconds and is never counted in both.
--
-- Rollback:
--   DROP FUNCTION IF EXISTS public.public_conversation_stats();
--   DROP INDEX IF EXISTS public.idx_call_logs_connected_seconds;

CREATE INDEX IF NOT EXISTS idx_call_logs_connected_seconds
  ON public.call_logs (duration_seconds)
  WHERE status = 'completed' AND duration_seconds > 0;

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
  SELECT
    COALESCE((SELECT sum(c.duration_seconds)
                FROM public.call_logs c
               WHERE c.status = 'completed' AND c.duration_seconds > 0), 0)::bigint,
    a.n::integer,
    a.elapsed::bigint,
    now()
  FROM (
    SELECT count(*) AS n,
           COALESCE(sum(floor(extract(epoch FROM now() - c.answered_at))), 0) AS elapsed
      FROM public.call_logs c
     WHERE c.status IN ('answered', 'in_progress')
       AND c.answered_at IS NOT NULL
       AND c.ended_at IS NULL
       AND c.answered_at > now() - interval '2 hours'
       AND c.answered_at <= now()
  ) a;
$$;

REVOKE ALL ON FUNCTION public.public_conversation_stats() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.public_conversation_stats() TO service_role;
