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
--   clickai_staging_base_url     e.g. https://clickai-staging.<subdomain>.workers.dev
--   clickai_staging_cron_secret  LOVABLE_CRON_SECRET from .env.staging.local
-- The job bodies read both at run time, so neither appears in cron.job.
--
-- Undo:
--   select cron.unschedule(jobname) from cron.job
--   where jobname like 'clickai-staging-%';

create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$
declare
  base text;
  bearer text;
begin
  select decrypted_secret into base
    from vault.decrypted_secrets where name = 'clickai_staging_base_url';
  select decrypted_secret into bearer
    from vault.decrypted_secrets where name = 'clickai_staging_cron_secret';
  if base is null or base !~ '^https://clickai-staging\.' then
    raise exception 'refusing: Vault secret clickai_staging_base_url must point at the clickai-staging Worker';
  end if;
  if bearer is null or length(bearer) < 32 then
    raise exception 'refusing: Vault secret clickai_staging_cron_secret is missing or too short';
  end if;
end $$;

-- One helper so each job is a single call; reads the URL and bearer from
-- Vault on every run.
create or replace function public.clickai_staging_call_cron(route text)
returns bigint
language sql
security definer
set search_path = ''
as $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets
            where name = 'clickai_staging_base_url') || '/api/public/cron/' || route,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets
                                      where name = 'clickai_staging_cron_secret'),
      'Content-Type', 'application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 25000);
$$;
revoke all on function public.clickai_staging_call_cron(text) from public, anon, authenticated;

-- Re-running replaces the jobs (cron.schedule updates a job of the same name).
select cron.schedule('clickai-staging-whatsapp-dispatch', '* * * * *',
  $$select public.clickai_staging_call_cron('whatsapp-dispatch')$$);
select cron.schedule('clickai-staging-whatsapp-replies', '*/3 * * * *',
  $$select public.clickai_staging_call_cron('whatsapp-replies')$$);
select cron.schedule('clickai-staging-expire-payments', '*/5 * * * *',
  $$select public.clickai_staging_call_cron('expire-payments')$$);
