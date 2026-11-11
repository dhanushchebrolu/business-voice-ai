-- Durable background job queue (Phase 2 of docs/architecture/saas-scale-plan.md).
--
-- Production had no scheduler at all (no pg_cron, no Worker cron trigger),
-- so background work never ran. Work now goes through public.jobs, drained
-- by the Worker's scheduled() handler every minute:
--
--   * enqueue_job: idempotent on idempotency_key (a duplicate enqueue
--     returns the existing job, never a second one).
--   * claim_jobs: FOR UPDATE SKIP LOCKED, so concurrent runners never take
--     the same job; each claim is a lease (locked_until) owned by one runner
--     (locked_by). A job whose runner died is re-claimed once its lease
--     expires; one that has used all its attempts is dead-lettered instead.
--   * complete_job / fail_job: fenced on the claiming runner, so a runner
--     whose lease expired cannot overwrite the new owner's result. Failures
--     retry with exponential backoff (30 s doubling, capped at 1 h) until
--     max_attempts, then move to 'dead' (the dead-letter state) for an
--     operator.
--   * job_queue_stats: per kind/status counts and the oldest due job's age,
--     for logs, alerts and the admin page.
--   * prune_jobs: deletes succeeded jobs after a retention period; dead jobs
--     are kept until an operator requeues or discards them.
--
-- Server-only: RLS on, no policies, no grants to anon/authenticated; the
-- functions are executable by service_role only. Not destructive: one new
-- table and new functions. Re-runnable.

CREATE TABLE IF NOT EXISTS public.jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_.]{1,63}$'),
  organization_id uuid REFERENCES public.organizations(id) ON DELETE CASCADE,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 300),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'succeeded', 'dead')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
  run_at timestamptz NOT NULL DEFAULT now(),
  locked_by text,
  locked_until timestamptz,
  last_error text,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  dead_at timestamptz,
  CONSTRAINT jobs_idempotency_key_key UNIQUE (idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_jobs_due ON public.jobs (run_at) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS idx_jobs_leases ON public.jobs (locked_until) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS idx_jobs_kind_status ON public.jobs (kind, status);
CREATE INDEX IF NOT EXISTS idx_jobs_org ON public.jobs (organization_id) WHERE organization_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_jobs_dead ON public.jobs (dead_at DESC) WHERE status = 'dead';

ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.jobs FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.jobs TO service_role;

DROP TRIGGER IF EXISTS trg_jobs_updated ON public.jobs;
CREATE TRIGGER trg_jobs_updated BEFORE UPDATE ON public.jobs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ============ enqueue ============
CREATE OR REPLACE FUNCTION public.enqueue_job(
  _kind text,
  _payload jsonb,
  _idempotency_key text,
  _organization_id uuid DEFAULT NULL,
  _run_at timestamptz DEFAULT now(),
  _max_attempts integer DEFAULT 5
) RETURNS TABLE(id uuid, created boolean)
LANGUAGE plpgsql AS $$
DECLARE new_id uuid;
BEGIN
  INSERT INTO public.jobs AS j (kind, payload, idempotency_key, organization_id, run_at, max_attempts)
  VALUES (_kind, COALESCE(_payload, '{}'::jsonb), _idempotency_key, _organization_id,
          COALESCE(_run_at, now()), COALESCE(_max_attempts, 5))
  ON CONFLICT ON CONSTRAINT jobs_idempotency_key_key DO NOTHING
  RETURNING j.id INTO new_id;
  IF new_id IS NOT NULL THEN
    RETURN QUERY SELECT new_id, true;
  ELSE
    RETURN QUERY SELECT j.id, false FROM public.jobs j WHERE j.idempotency_key = _idempotency_key;
  END IF;
END; $$;

-- ============ claim ============
CREATE OR REPLACE FUNCTION public.claim_jobs(_worker text, _limit integer, _lease_seconds integer)
RETURNS SETOF public.jobs
LANGUAGE plpgsql AS $$
BEGIN
  IF _worker IS NULL OR length(_worker) = 0 THEN
    RAISE EXCEPTION 'claim_jobs: worker id required';
  END IF;
  -- A lease that expired after the last allowed attempt is dead, not retried.
  UPDATE public.jobs
     SET status = 'dead', dead_at = now(), locked_by = NULL, locked_until = NULL,
         last_error = COALESCE(last_error, 'lease expired after the last attempt')
   WHERE status = 'running' AND locked_until < now() AND attempts >= max_attempts;

  RETURN QUERY
  WITH due AS (
    SELECT j.id FROM public.jobs j
     WHERE (j.status = 'queued' AND j.run_at <= now())
        OR (j.status = 'running' AND j.locked_until < now())
     ORDER BY j.run_at
     LIMIT GREATEST(1, LEAST(COALESCE(_limit, 10), 100))
     FOR UPDATE SKIP LOCKED
  )
  UPDATE public.jobs j
     SET status = 'running',
         attempts = j.attempts + 1,
         locked_by = _worker,
         locked_until = now() + make_interval(secs => GREATEST(5, LEAST(COALESCE(_lease_seconds, 60), 900))),
         started_at = now()
    FROM due WHERE j.id = due.id
  RETURNING j.*;
END; $$;

-- ============ complete / fail (fenced on the claiming runner) ============
CREATE OR REPLACE FUNCTION public.complete_job(_id uuid, _worker text, _result jsonb DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.jobs
     SET status = 'succeeded', completed_at = now(), result = _result,
         locked_by = NULL, locked_until = NULL, last_error = NULL
   WHERE id = _id AND status = 'running' AND locked_by = _worker;
  RETURN FOUND;
END; $$;

CREATE OR REPLACE FUNCTION public.fail_job(_id uuid, _worker text, _error text, _retryable boolean DEFAULT true)
RETURNS text
LANGUAGE plpgsql AS $$
DECLARE outcome text;
BEGIN
  UPDATE public.jobs
     SET status = CASE WHEN _retryable AND attempts < max_attempts THEN 'queued' ELSE 'dead' END,
         run_at = CASE WHEN _retryable AND attempts < max_attempts
                       THEN now() + make_interval(secs => LEAST(3600, 30 * power(2, GREATEST(attempts - 1, 0))::int))
                       ELSE run_at END,
         dead_at = CASE WHEN _retryable AND attempts < max_attempts THEN NULL ELSE now() END,
         last_error = left(COALESCE(_error, 'unknown error'), 2000),
         locked_by = NULL, locked_until = NULL
   WHERE id = _id AND status = 'running' AND locked_by = _worker
  RETURNING status INTO outcome;
  RETURN COALESCE(outcome, 'not_owner');
END; $$;

-- ============ operator actions ============
CREATE OR REPLACE FUNCTION public.requeue_dead_job(_id uuid)
RETURNS boolean
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.jobs
     SET status = 'queued', attempts = 0, run_at = now(), dead_at = NULL, last_error = NULL
   WHERE id = _id AND status = 'dead';
  RETURN FOUND;
END; $$;

-- ============ visibility and retention ============
CREATE OR REPLACE FUNCTION public.job_queue_stats()
RETURNS TABLE(kind text, status text, jobs bigint, oldest_due_seconds integer)
LANGUAGE sql STABLE AS $$
  SELECT j.kind, j.status, count(*)::bigint,
         CASE WHEN j.status = 'queued'
              THEN GREATEST(0, EXTRACT(EPOCH FROM now() - min(j.run_at) FILTER (WHERE j.run_at <= now())))::int
              END
    FROM public.jobs j GROUP BY j.kind, j.status ORDER BY 1, 2;
$$;

CREATE OR REPLACE FUNCTION public.prune_jobs(_older_than interval DEFAULT interval '7 days')
RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE removed integer;
BEGIN
  DELETE FROM public.jobs WHERE status = 'succeeded' AND completed_at < now() - _older_than;
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END; $$;

DO $$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'public.enqueue_job(text, jsonb, text, uuid, timestamptz, integer)',
    'public.claim_jobs(text, integer, integer)',
    'public.complete_job(uuid, text, jsonb)',
    'public.fail_job(uuid, text, text, boolean)',
    'public.requeue_dead_job(uuid)',
    'public.job_queue_stats()',
    'public.prune_jobs(interval)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
  END LOOP;
END $$;
