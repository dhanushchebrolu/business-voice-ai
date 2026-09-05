-- Server-side abuse protection for the unauthenticated public
-- chatbot/voice-assistant endpoints (publicChat, publicVoiceTurn in
-- src/lib/public-assistant.functions.ts). Every call to those endpoints
-- triggers a real, billed Sarvam API request, so the counter backing the
-- rate limit must be a durable, shared store — not per-process memory,
-- which would reset independently on every Cloudflare Worker isolate and
-- provide no real protection in production.
--
-- This repository has no Cloudflare KV namespace or Durable Object binding
-- configured (checked: no such binding exists in wrangler config or
-- anywhere in src/), so Postgres — the one durable, cross-isolate store
-- already used by every other server-side operation in this codebase — is
-- the safest mechanism actually available here. See rate-limit.server.ts.
--
-- This table is service-role only: no anon/authenticated grants at all,
-- since only trusted server code (never the browser) may read or write it.

CREATE TABLE IF NOT EXISTS public.public_assistant_rate_limits (
  client_key text NOT NULL,
  window_start timestamptz NOT NULL,
  request_count integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client_key, window_start)
);

GRANT ALL ON public.public_assistant_rate_limits TO service_role;
ALTER TABLE public.public_assistant_rate_limits ENABLE ROW LEVEL SECURITY;
-- Deliberately no policies: with no grants to anon/authenticated, Postgres
-- rejects those roles before RLS is even evaluated. Only service_role
-- (which bypasses RLS) ever touches this table.

-- Old windows are cheap to keep and simple to prune periodically; an index
-- is enough for an operator (or a future scheduled job) to do so.
CREATE INDEX IF NOT EXISTS idx_public_assistant_rate_limits_window
  ON public.public_assistant_rate_limits (window_start);

-- Atomically increments and returns the new count for (client_key,
-- window_start) in a single statement, so concurrent requests across any
-- number of Worker isolates can never race each other into under-counting.
CREATE OR REPLACE FUNCTION public.increment_rate_limit(_key text, _window_start timestamptz)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  new_count integer;
BEGIN
  INSERT INTO public.public_assistant_rate_limits (client_key, window_start, request_count, updated_at)
  VALUES (_key, _window_start, 1, now())
  ON CONFLICT (client_key, window_start)
  DO UPDATE SET request_count = public.public_assistant_rate_limits.request_count + 1, updated_at = now()
  RETURNING request_count INTO new_count;
  RETURN new_count;
END; $$;

REVOKE ALL ON FUNCTION public.increment_rate_limit(text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.increment_rate_limit(text, timestamptz) TO service_role;
