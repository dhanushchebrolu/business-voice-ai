-- Release checks for production: READ ONLY (a read-only transaction that rolls back). Run before
-- the first migration and again after the deployment, and compare.
-- Run it in the Supabase dashboard SQL editor of project eorazvlmqwunmhwviocn (runbook, step 4).
-- Not with `supabase db query --linked`: that first creates a temporary login role with write rights.
-- Works on the schema as it is before and after 20261204090000-20261206090000. No names, e-mail
-- addresses, full phone numbers or token values are selected.
begin transaction read only;
SELECT json_build_object(
  'identity', json_build_object(
    'system_identifier', (SELECT system_identifier::text FROM pg_control_system()),
    'expected_system_identifier', (SELECT system_identifier::text FROM pg_control_system()) = '7678069749886157684',
    'database', current_database(),
    'latest_migration', (SELECT max(version) FROM supabase_migrations.schema_migrations),
    'recent_versions', (SELECT json_agg(version ORDER BY version) FROM supabase_migrations.schema_migrations
                         WHERE version >= '20261123090000'),
    'transaction_read_only', current_setting('transaction_read_only')),

  'switches', (SELECT json_object_agg(key, value) FROM public.platform_settings
                WHERE key IN ('billing.payment_required', 'outbound.calling_paused')),

  'customers_by_lifecycle', (SELECT json_object_agg(lifecycle_status, n) FROM (
      SELECT lifecycle_status, count(*) AS n FROM public.organizations GROUP BY lifecycle_status) x),

  'multiple_businesses', (SELECT coalesce(json_agg(x), '[]') FROM (
      SELECT organization_id, count(*) AS businesses FROM public.businesses
       GROUP BY organization_id HAVING count(*) > 1 ORDER BY organization_id) x),

  -- Server code reads one receptionist per customer: expect none.
  'multiple_receptionists', (SELECT coalesce(json_agg(x), '[]') FROM (
      SELECT organization_id, count(*) AS receptionists FROM public.agent_configs
       GROUP BY organization_id HAVING count(*) > 1 ORDER BY organization_id) x),

  -- The new build sends these customers back to the setup wizard.
  'business_without_receptionist', (SELECT coalesce(json_agg(DISTINCT b.organization_id), '[]')
      FROM public.businesses b
     WHERE NOT EXISTS (SELECT 1 FROM public.agent_configs a WHERE a.organization_id = b.organization_id)),

  'duplicate_setup_records', json_build_object(
    'services', (SELECT count(*) FROM (SELECT 1 FROM public.services
                  GROUP BY business_id, lower(btrim(name)) HAVING count(*) > 1) d),
    'faqs', (SELECT count(*) FROM (SELECT 1 FROM public.faqs
              GROUP BY business_id, question HAVING count(*) > 1) d),
    'business_rules', (SELECT count(*) FROM (SELECT 1 FROM public.business_rules
                        GROUP BY business_id, rule HAVING count(*) > 1) d)),

  'inbound_agents', (SELECT coalesce(json_agg(x), '[]') FROM (
      SELECT a.organization_id, a.sarvam_app_id, a.sarvam_app_version,
             (SELECT count(*) FROM public.phone_numbers n
               WHERE n.agent_config_id = a.id AND n.provider_deployment_id IS NOT NULL
                 AND n.status <> 'released') AS numbers_with_deployment,
             EXISTS (SELECT 1 FROM public.sarvam_agent_integrations i
                      WHERE i.agent_config_id = a.id AND i.role = 'inbound' AND i.status = 'active') AS credential,
             EXISTS (SELECT 1 FROM public.agent_voice_language_settings v
                      WHERE v.agent_config_id = a.id AND v.status = 'applied'
                        AND v.applied_sarvam_app_id = a.sarvam_app_id
                        AND v.applied_sarvam_app_version = a.sarvam_app_version) AS voice_applied
        FROM public.agent_configs a WHERE a.sarvam_app_id IS NOT NULL ORDER BY a.organization_id) x),

  'outbound_agents', (SELECT coalesce(json_agg(x), '[]') FROM (
      SELECT a.organization_id, a.sarvam_outbound_app_id, a.sarvam_outbound_app_version,
             a.sarvam_outbound_ready_app_id, a.sarvam_outbound_ready_version,
             (a.sarvam_outbound_ready_app_id = a.sarvam_outbound_app_id
               AND a.sarvam_outbound_ready_version = a.sarvam_outbound_app_version) IS TRUE AS confirmed,
             a.sarvam_outbound_registered_at IS NOT NULL AS has_registration_time,
             EXISTS (SELECT 1 FROM public.sarvam_agent_integrations i
                      WHERE i.agent_config_id = a.id AND i.role = 'outbound' AND i.status = 'active') AS credential
        FROM public.agent_configs a
       WHERE a.sarvam_outbound_app_id IS NOT NULL OR a.sarvam_outbound_ready_app_id IS NOT NULL
       ORDER BY a.organization_id) x),

  'shared_agent_ids', (SELECT coalesce(json_agg(x), '[]') FROM (
      SELECT app_id, count(DISTINCT organization_id) AS customers FROM (
        SELECT sarvam_app_id AS app_id, organization_id FROM public.agent_configs
         WHERE sarvam_app_id IS NOT NULL
        UNION ALL
        SELECT sarvam_outbound_app_id, organization_id FROM public.agent_configs
         WHERE sarvam_outbound_app_id IS NOT NULL) u
       GROUP BY app_id HAVING count(*) > 1) x),

  'numbers', (SELECT coalesce(json_agg(x), '[]') FROM (
      SELECT n.organization_id, '....' || right(n.e164, 4) AS number_ending, n.provider, n.status,
             n.inbound_enabled, n.outbound_enabled, n.agent_config_id IS NOT NULL AS agent_linked,
             n.provider_deployment_id, n.verified_deployment_id, n.verified_sarvam_app_id,
             n.verified_sarvam_app_version
        FROM public.phone_numbers n WHERE n.status <> 'released'
       ORDER BY n.organization_id, n.created_at) x),

  -- A provisioning run on one of these can change its live Sarvam deployment. Do not run one.
  'live_mapping_differences', (SELECT coalesce(json_agg(x), '[]') FROM (
      SELECT n.organization_id, '....' || right(n.e164, 4) AS number_ending,
             n.provider_deployment_id IS NULL AS no_deployment,
             n.verified_deployment_id IS DISTINCT FROM n.provider_deployment_id AS deployment_unverified,
             n.verified_sarvam_app_id IS DISTINCT FROM a.sarvam_app_id AS agent_differs,
             n.verified_sarvam_app_version IS DISTINCT FROM a.sarvam_app_version AS version_differs
        FROM public.phone_numbers n LEFT JOIN public.agent_configs a ON a.id = n.agent_config_id
       WHERE n.provider = 'sarvam' AND n.status = 'active'
         AND (n.provider_deployment_id IS NULL
              OR n.verified_deployment_id IS DISTINCT FROM n.provider_deployment_id
              OR n.verified_sarvam_app_id IS DISTINCT FROM a.sarvam_app_id
              OR n.verified_sarvam_app_version IS DISTINCT FROM a.sarvam_app_version)) x),

  'deployments_on_several_numbers', (SELECT coalesce(json_agg(x), '[]') FROM (
      SELECT provider_deployment_id, count(*) AS numbers FROM public.phone_numbers
       WHERE provider_deployment_id IS NOT NULL AND status <> 'released'
       GROUP BY provider_deployment_id HAVING count(*) > 1) x),

  'open_provisioning_jobs', (SELECT coalesce(json_agg(x), '[]') FROM (
      SELECT organization_id, status, current_step, trigger, attempts, next_attempt_at
        FROM public.provisioning_runs WHERE status IN ('pending', 'running', 'waiting')
       ORDER BY organization_id) x),
  'provisioning_jobs_by_status', (SELECT coalesce(json_object_agg(status, n), '{}') FROM (
      SELECT status, count(*) AS n FROM public.provisioning_runs GROUP BY status) x),
  'provisioning_events', (SELECT count(*) FROM public.provisioning_run_events),

  'bridge_tokens', (SELECT json_build_object(
      'total', count(*),
      'live', count(*) FILTER (WHERE revoked_at IS NULL AND expires_at > now()),
      'live_without_scope', count(*) FILTER (WHERE revoked_at IS NULL AND expires_at > now()
          AND (to_jsonb(t) ->> 'organization_id' IS NULL OR to_jsonb(t) ->> 'run_id' IS NULL)))
    FROM public.operator_bridge_tokens t),

  -- Only a "running" campaign in ClickAI's own mode is dialled by the dispatch switch. It keeps
  -- that status while the switch is off and resumes by itself. Draft, scheduled and paused ones
  -- need a launch. A campaign with a provider id is paced by Sarvam, whatever the switch says.
  'campaigns', (SELECT json_build_object(
      'running_or_scheduled', count(*) FILTER (WHERE status::text IN ('running', 'scheduled', 'queued')),
      'with_provider_campaign', count(*) FILTER (WHERE provider_campaign_id IS NOT NULL),
      'dialled_when_switch_on', count(*) FILTER (WHERE status::text = 'running'
          AND dispatch_mode::text = 'instant_outbound_fallback'),
      'can_be_launched_by_customer', count(*) FILTER (WHERE status::text IN ('draft', 'scheduled', 'paused')))
    FROM public.campaigns),
  'campaigns_by_status', (SELECT coalesce(json_agg(x), '[]') FROM (
      SELECT status::text AS status, dispatch_mode::text AS mode, count(*) AS n FROM public.campaigns
       GROUP BY 1, 2 ORDER BY 1, 2) x),
  'contacts_waiting_in_running_campaigns', (SELECT count(*) FROM public.campaign_contacts cc
      JOIN public.campaigns c ON c.id = cc.campaign_id
     WHERE c.status::text = 'running' AND cc.status::text IN ('pending', 'retry_scheduled')),
  'outbound_enabled_numbers', (SELECT coalesce(json_agg(x), '[]') FROM (
      SELECT organization_id, count(*) AS numbers FROM public.phone_numbers
       WHERE outbound_enabled AND status::text = 'active' GROUP BY organization_id ORDER BY organization_id) x),
  'outbound_calls_unfinished', (SELECT count(*) FROM public.call_logs
     WHERE direction::text = 'outbound'
       AND status::text NOT IN ('completed', 'failed', 'busy', 'no_answer', 'cancelled')),

  -- Smile Dental (id starts 5669e43f) and Smile Dental 1: must be identical before and after.
  'protected_fingerprints', (SELECT coalesce(json_agg(x), '[]') FROM (
      SELECT o.id AS organization_id,
        md5(coalesce((SELECT string_agg(to_jsonb(r)::text, '|' ORDER BY r.id) FROM public.agent_configs r WHERE r.organization_id = o.id), '')) AS agents,
        md5(coalesce((SELECT string_agg(to_jsonb(r)::text, '|' ORDER BY r.id) FROM public.phone_numbers r WHERE r.organization_id = o.id), '')) AS numbers,
        md5(coalesce((SELECT string_agg(to_jsonb(r)::text, '|' ORDER BY r.id) FROM public.businesses r WHERE r.organization_id = o.id), '')) AS businesses,
        md5(coalesce((SELECT string_agg(to_jsonb(r)::text, '|' ORDER BY r.id) FROM public.sarvam_agent_integrations r
                       WHERE r.agent_config_id IN (SELECT id FROM public.agent_configs WHERE organization_id = o.id)), '')) AS credentials
      FROM public.organizations o
     WHERE o.id::text LIKE '5669e43f-%' OR o.id = 'ccb6543c-da78-47cf-b32f-7851ddc575ea'
     ORDER BY o.id) x)
) AS clickai_release_checks;
rollback;
