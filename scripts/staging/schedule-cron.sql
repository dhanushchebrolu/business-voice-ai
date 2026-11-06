-- ClickAI WhatsApp sandbox: schedule the Worker's cron routes from the
-- hosted STAGING Supabase project (pg_cron + pg_net), per
-- docs/whatsapp-integration.md ("Cron").
--
-- STAGING ONLY. Never run this in the production project. It is deliberately
-- NOT a migration (it lives outside supabase/migrations), so no migration run
-- can ever apply it anywhere.
--
-- Before running, store two secrets in the staging project's Vault
-- (Dashboard > Project Settings > Vault, or vault.create_secret):
--   clickai_staging_base_url     exactly https://clickai-staging.<subdomain>.workers.dev
--                                (no path, no trailing slash; any other host is refused)
--   clickai_staging_cron_secret  LOVABLE_CRON_SECRET from .env.staging.local
--   clickai_staging_voice_cron_secret  VOICE_AGENT_CRON_SECRET of the staging Worker
--                                (>= 32 chars; the voice routes reconcile-sip-calls and
--                                sweep-sip-rooms accept only this, signed per request)
-- The job bodies read them at run time, so none appears in cron.job.
--
-- Undo:
--   select cron.unschedule(jobname) from cron.job
--   where jobname like 'clickai-staging-%';

create extension if not exists pg_cron;
create extension if not exists pg_net;
create extension if not exists pgcrypto with schema extensions;

do $$
declare
  base text;
  bearer text;
begin
  select decrypted_secret into base
    from vault.decrypted_secrets where name = 'clickai_staging_base_url';
  select decrypted_secret into bearer
    from vault.decrypted_secrets where name = 'clickai_staging_cron_secret';
  if base is null or base !~ '^https://clickai-staging\.[a-z0-9-]+\.workers\.dev$' then
    raise exception 'refusing: Vault secret clickai_staging_base_url must be https://clickai-staging.<subdomain>.workers.dev';
  end if;
  if bearer is null or length(bearer) < 32 then
    raise exception 'refusing: Vault secret clickai_staging_cron_secret is missing or too short';
  end if;
  if coalesce(length((select decrypted_secret from vault.decrypted_secrets
                      where name = 'clickai_staging_voice_cron_secret')), 0) < 32 then
    raise exception 'refusing: Vault secret clickai_staging_voice_cron_secret is missing or too short';
  end if;
end $$;

-- The voice cron signature (src/lib/voice-agent/cron-auth.server.ts):
-- hex(HMAC-SHA256(secret, 'v1' \n ts \n 'POST' \n '/api/public/cron/' || route)).
-- Pure function of its arguments; tested against the Worker's own
-- implementation in supabase/migrations/voice_agent_room_sweep.pg.test.ts.
create or replace function public.clickai_staging_voice_cron_signature(
  route text, ts bigint, secret text)
returns text
language sql
immutable
set search_path = ''
as $$
  select encode(
    extensions.hmac(
      convert_to('v1' || chr(10) || ts::text || chr(10) || 'POST' || chr(10)
                 || '/api/public/cron/' || route, 'UTF8'),
      convert_to(secret, 'UTF8'),
      'sha256'),
    'hex');
$$;
revoke all on function public.clickai_staging_voice_cron_signature(text, bigint, text)
  from public, anon, authenticated;

-- One helper so each job is a single call. It re-reads the URL and bearer
-- from Vault on EVERY run and re-checks both, so a later edit of the Vault
-- secret can never point these jobs at another host (the job run fails
-- instead; see cron.job_run_details). Only known cron routes are allowed.
create or replace function public.clickai_staging_call_cron(route text)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  base text;
  bearer text;
  voice_secret text;
  ts bigint;
  hdrs jsonb;
begin
  if route is null or route not in (
    'whatsapp-dispatch', 'whatsapp-replies', 'expire-payments', 'reconcile-sip-calls',
    'sweep-sip-rooms'
  ) then
    raise exception 'refusing: unknown cron route %', route;
  end if;
  select decrypted_secret into base
    from vault.decrypted_secrets where name = 'clickai_staging_base_url';
  select decrypted_secret into bearer
    from vault.decrypted_secrets where name = 'clickai_staging_cron_secret';
  if base is null or base !~ '^https://clickai-staging\.[a-z0-9-]+\.workers\.dev$' then
    raise exception 'refusing: clickai_staging_base_url is not the clickai-staging Worker';
  end if;
  if bearer is null or length(bearer) < 32 then
    raise exception 'refusing: clickai_staging_cron_secret is missing or too short';
  end if;
  if route in ('reconcile-sip-calls', 'sweep-sip-rooms') then
    -- Voice routes: their own secret, a fresh signature per run (replay-protected).
    select decrypted_secret into voice_secret
      from vault.decrypted_secrets where name = 'clickai_staging_voice_cron_secret';
    if voice_secret is null or length(voice_secret) < 32 then
      raise exception 'refusing: clickai_staging_voice_cron_secret is missing or too short';
    end if;
    ts := extract(epoch from now())::bigint;
    hdrs := jsonb_build_object(
      'X-Voice-Cron-Timestamp', ts::text,
      'X-Voice-Cron-Signature', public.clickai_staging_voice_cron_signature(route, ts, voice_secret),
      'Content-Type', 'application/json');
  else
    hdrs := jsonb_build_object(
      'Authorization', 'Bearer ' || bearer,
      'Content-Type', 'application/json');
  end if;
  return net.http_post(
    url := base || '/api/public/cron/' || route,
    headers := hdrs,
    body := '{}'::jsonb,
    timeout_milliseconds := 25000);
end;
$$;
revoke all on function public.clickai_staging_call_cron(text) from public, anon, authenticated;

-- Re-running replaces the jobs (cron.schedule updates a job of the same name).
select cron.schedule('clickai-staging-whatsapp-dispatch', '* * * * *',
  $$select public.clickai_staging_call_cron('whatsapp-dispatch')$$);
select cron.schedule('clickai-staging-whatsapp-replies', '*/3 * * * *',
  $$select public.clickai_staging_call_cron('whatsapp-replies')$$);
select cron.schedule('clickai-staging-expire-payments', '*/5 * * * *',
  $$select public.clickai_staging_call_cron('expire-payments')$$);
-- LiveKit SIP voice agent: close calls whose signed end event never arrived
-- (never billed), prune replay records and rate-limit windows. Idempotent.
select cron.schedule('clickai-staging-reconcile-sip-calls', '*/15 * * * *',
  $$select public.clickai_staging_call_cron('reconcile-sip-calls')$$);
-- Independent maximum-duration backstop: deletes the LiveKit room of inbound
-- calls the voice agent could not end (agent crashed / partitioned / its
-- room cleanup failed). Idempotent; never bills.
select cron.schedule('clickai-staging-sweep-sip-rooms', '*/5 * * * *',
  $$select public.clickai_staging_call_cron('sweep-sip-rooms')$$);
