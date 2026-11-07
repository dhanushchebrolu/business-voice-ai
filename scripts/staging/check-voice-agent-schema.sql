-- READ-ONLY compatibility check for the LiveKit SIP voice agent
-- (services/voice-agent/STAGING_DEPLOYMENT.md §6). Run it in the SQL
-- editor of the STAGING project (and later production) BEFORE deploying.
-- It only SELECTs: it changes nothing, creates nothing, needs no approval.
--
-- Every row must say ok = true, except the two rows marked
-- "optional / pending approval", which only show whether the untracked
-- migrations have been applied.

with expected_columns(table_name, column_name) as (
  values
    ('call_logs', 'organization_id'), ('call_logs', 'business_id'),
    ('call_logs', 'phone_number_id'), ('call_logs', 'provider'),
    ('call_logs', 'provider_call_id'), ('call_logs', 'direction'),
    ('call_logs', 'caller_number'), ('call_logs', 'destination_number'),
    ('call_logs', 'status'), ('call_logs', 'failure_reason'),
    ('call_logs', 'started_at'), ('call_logs', 'answered_at'),
    ('call_logs', 'ended_at'), ('call_logs', 'duration_seconds'),
    ('call_logs', 'provider_metadata'), ('call_logs', 'summary'),
    ('call_logs', 'language'), ('call_logs', 'outcome'),
    ('webhook_events', 'provider'), ('webhook_events', 'event_id'),
    ('webhook_events', 'payload'), ('webhook_events', 'processed_at'),
    ('webhook_events', 'created_at'),
    ('public_assistant_rate_limits', 'client_key'),
    ('public_assistant_rate_limits', 'window_start'),
    ('public_assistant_rate_limits', 'request_count'),
    ('phone_numbers', 'e164'), ('phone_numbers', 'organization_id')
),
expected_functions(fn) as (
  values ('increment_rate_limit'), ('debit_wallet_for_call'),
         ('record_call_usage'), ('wallet_can_afford')
)
select 'column ' || e.table_name || '.' || e.column_name as check_name,
       exists (
         select 1 from information_schema.columns c
         where c.table_schema = 'public' and c.table_name = e.table_name
           and c.column_name = e.column_name
       ) as ok
from expected_columns e
union all
select 'function public.' || f.fn,
       exists (
         select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = f.fn
       )
from expected_functions f
union all
select 'unique index call_logs(provider, provider_call_id)',
       exists (select 1 from pg_indexes
               where schemaname = 'public' and indexname = 'idx_call_logs_provider_call_id')
union all
select 'unique (provider, event_id) on webhook_events',
       exists (
         select 1 from pg_constraint con
         join pg_class rel on rel.oid = con.conrelid
         join pg_namespace n on n.oid = rel.relnamespace
         where n.nspname = 'public' and rel.relname = 'webhook_events' and con.contype = 'u'
       )
union all
select 'call_logs_status_check allows answered/in_progress/completed/failed',
       exists (
         select 1 from pg_constraint con
         where con.conname = 'call_logs_status_check'
           and pg_get_constraintdef(con.oid) like '%answered%'
           and pg_get_constraintdef(con.oid) like '%in_progress%'
       )
union all
select 'optional / pending approval: reserve_voice_agent_outbound_call (outbound only)',
       exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'public' and p.proname = 'reserve_voice_agent_outbound_call')
union all
select 'optional / pending approval: idx_call_logs_livekit_inbound_answered (room sweep index)',
       exists (select 1 from pg_indexes
               where schemaname = 'public' and indexname = 'idx_call_logs_livekit_inbound_answered')
order by 1;

-- Latest applied migration versions (to detect any unexpected automatic
-- application later). Record the result with the date.
select version, name
from supabase_migrations.schema_migrations
order by version desc
limit 5;
