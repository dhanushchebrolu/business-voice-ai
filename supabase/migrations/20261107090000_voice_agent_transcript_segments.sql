-- Atomic transcript persistence for LiveKit SIP calls (voice agent).
--
-- Problem: klyro stored a call's transcript by reading call_logs.transcript,
-- merging the reporting agent job's turns in application code, and writing
-- the result back with an unconditional UPDATE. Two writers for the same
-- call (two checkpoints, a checkpoint and the final report, or two agent
-- jobs after a reconnect) could both read the same transcript and the later
-- write silently dropped the other's turns.
--
-- Fix: each agent job's turns are stored as one row of
-- call_transcript_segments (call_id, segment = LiveKit job id), and every
-- write goes through store_voice_agent_transcript_segment, which in ONE
-- transaction:
--   1. locks the call_logs row (SELECT ... FOR UPDATE), so all transcript
--      writes for a call are serialized while different calls never wait
--      for each other;
--   2. re-checks the call under that lock: a livekit_sip call, and the SIP
--      call id must match (a checkpoint must name the call's recorded SIP
--      call id; a final report may omit it, as before);
--   3. applies the segment rules:
--        - a longer snapshot of a segment replaces a shorter one;
--        - an identical, shorter or equal-length snapshot changes nothing
--          (retries, duplicates, late out-of-order checkpoints);
--        - a final report marks its segment final; afterwards checkpoints
--          for that segment change nothing (a stale checkpoint can never
--          overwrite the final transcript), and a repeated final report
--          replaces it only with more turns;
--        - a final report shorter than a stored checkpoint marks the
--          segment final but keeps the stored turns (nothing is lost);
--   4. rebuilds call_logs.transcript from ALL of the call's segments, in a
--      deterministic order (turn time, then segment id, then position in
--      the segment), in the dashboard's existing shape
--      {role, text, at, seg?, n}, at most 800 turns, and the Worker
--      runtime's summary line "<n> turns · <language>" (or "No conversation
--      recorded."), counting every segment's turns.
-- Nothing is written when nothing changed, so retries are idempotent.
--
-- Turns are validated (role user/assistant, non-empty text of at most 4000
-- characters, a parseable timestamp, at most 400 per segment) and stored
-- with only role/text/at: anything else in the input is dropped. Invalid
-- input raises (SQLSTATE 22023) and writes nothing; the caller reports the
-- failure, never success.
--
-- Only service_role (server code) may execute the function. service_role
-- may also read the table (every public table must be readable by the
-- server role: server_role_grants.pg.test.ts); all writes go through the
-- function. The table is not readable or writable by anon/authenticated
-- (RLS on, no policies, and privileges revoked). The dashboard keeps
-- reading call_logs.transcript under call_logs' existing policies.
--
-- Idempotent: safe to run more than once.
--
-- Rollback: first deploy Worker code that no longer calls the function,
-- then:
--   DROP FUNCTION IF EXISTS public.store_voice_agent_transcript_segment(uuid, text, text, jsonb, boolean, text);
--   DROP TABLE IF EXISTS public.call_transcript_segments;
-- call_logs.transcript keeps the last transcript written; nothing else is
-- affected.

CREATE TABLE IF NOT EXISTS public.call_transcript_segments (
  call_id uuid NOT NULL REFERENCES public.call_logs (id) ON DELETE CASCADE,
  segment text NOT NULL CHECK (segment ~ '^[A-Za-z0-9_-]{0,64}$'),
  turns jsonb NOT NULL CHECK (
    jsonb_typeof(turns) = 'array' AND jsonb_array_length(turns) <= 400
  ),
  final boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (call_id, segment)
);

ALTER TABLE public.call_transcript_segments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.call_transcript_segments FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.call_transcript_segments TO service_role;

CREATE OR REPLACE FUNCTION public.store_voice_agent_transcript_segment(
  _call_id uuid,
  _sip_call_id text,
  _segment text,
  _turns jsonb,
  _final boolean,
  _language text
)
RETURNS TABLE (outcome text, total_turns integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  c record;
  existing record;
  incoming jsonb;
  n integer;
  old_n integer;
  turns_changed boolean := false;
  merged jsonb;
  total integer;
BEGIN
  IF _call_id IS NULL OR _segment IS NULL OR _final IS NULL OR _turns IS NULL
     OR jsonb_typeof(_turns) <> 'array'
     OR _segment !~ '^[A-Za-z0-9_-]{0,64}$'
     OR jsonb_array_length(_turns) > 400 THEN
    RAISE EXCEPTION 'invalid transcript segment' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(_turns) AS e(t)
    WHERE jsonb_typeof(e.t) IS DISTINCT FROM 'object'
       OR (e.t ->> 'role') IS NULL
       OR (e.t ->> 'role') NOT IN ('user', 'assistant')
       OR jsonb_typeof(e.t -> 'text') IS DISTINCT FROM 'string'
       OR length(e.t ->> 'text') NOT BETWEEN 1 AND 4000
       OR jsonb_typeof(e.t -> 'at') IS DISTINCT FROM 'string'
  ) THEN
    RAISE EXCEPTION 'invalid transcript turn' USING ERRCODE = '22023';
  END IF;
  -- Every timestamp must parse (an unparseable one raises here).
  PERFORM (e.t ->> 'at')::timestamptz FROM jsonb_array_elements(_turns) AS e(t);

  SELECT coalesce(
           jsonb_agg(
             jsonb_build_object('role', e.t ->> 'role', 'text', e.t ->> 'text', 'at', e.t ->> 'at')
             ORDER BY e.i
           ),
           '[]'::jsonb
         )
    INTO incoming
    FROM jsonb_array_elements(_turns) WITH ORDINALITY AS e(t, i);
  n := jsonb_array_length(incoming);

  -- The serialization point: every transcript write for this call waits here.
  SELECT l.id, l.provider, l.provider_call_id
    INTO c
    FROM public.call_logs l
   WHERE l.id = _call_id
     FOR UPDATE;
  IF NOT FOUND OR c.provider IS DISTINCT FROM 'livekit_sip' THEN
    RETURN QUERY SELECT 'unknown_call'::text, NULL::integer;
    RETURN;
  END IF;
  IF (NOT _final AND (_sip_call_id IS NULL OR c.provider_call_id IS DISTINCT FROM _sip_call_id))
     OR (_sip_call_id IS NOT NULL AND c.provider_call_id IS NOT NULL
         AND c.provider_call_id <> _sip_call_id) THEN
    RETURN QUERY SELECT 'binding_mismatch'::text, NULL::integer;
    RETURN;
  END IF;

  SELECT s.turns, s.final
    INTO existing
    FROM public.call_transcript_segments s
   WHERE s.call_id = _call_id AND s.segment = _segment;

  IF NOT FOUND THEN
    INSERT INTO public.call_transcript_segments (call_id, segment, turns, final)
    VALUES (_call_id, _segment, incoming, _final);
    turns_changed := true;
  ELSE
    old_n := jsonb_array_length(existing.turns);
    IF existing.final THEN
      IF _final AND n > old_n THEN
        UPDATE public.call_transcript_segments
           SET turns = incoming, updated_at = now()
         WHERE call_id = _call_id AND segment = _segment;
        turns_changed := true;
      END IF;
    ELSIF n > old_n OR (_final AND n = old_n AND incoming <> existing.turns) THEN
      UPDATE public.call_transcript_segments
         SET turns = incoming, final = _final, updated_at = now()
       WHERE call_id = _call_id AND segment = _segment;
      turns_changed := true;
    ELSIF _final THEN
      UPDATE public.call_transcript_segments
         SET final = true, updated_at = now()
       WHERE call_id = _call_id AND segment = _segment;
    END IF;
  END IF;

  IF NOT turns_changed THEN
    RETURN QUERY SELECT 'unchanged'::text, NULL::integer;
    RETURN;
  END IF;

  SELECT count(*)::integer,
         coalesce(jsonb_agg(x.turn ORDER BY x.at, x.segment, x.pos), '[]'::jsonb)
    INTO total, merged
    FROM (
      SELECT CASE WHEN s.segment = '' THEN e.t ELSE e.t || jsonb_build_object('seg', s.segment) END
               || jsonb_build_object('n', e.i - 1) AS turn,
             (e.t ->> 'at')::timestamptz AS at,
             s.segment,
             e.i AS pos
        FROM public.call_transcript_segments s
       CROSS JOIN LATERAL jsonb_array_elements(s.turns) WITH ORDINALITY AS e(t, i)
       WHERE s.call_id = _call_id
       ORDER BY 2, 3, 4
       LIMIT 800
    ) x;

  UPDATE public.call_logs
     SET transcript = merged,
         summary = CASE
           WHEN total = 0 THEN 'No conversation recorded.'
           ELSE total || ' turns · ' || coalesce(_language, 'unknown')
         END
   WHERE id = _call_id;

  RETURN QUERY SELECT 'stored'::text, total;
END;
$$;

REVOKE ALL ON FUNCTION public.store_voice_agent_transcript_segment(uuid, text, text, jsonb, boolean, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.store_voice_agent_transcript_segment(uuid, text, text, jsonb, boolean, text)
  TO service_role;
