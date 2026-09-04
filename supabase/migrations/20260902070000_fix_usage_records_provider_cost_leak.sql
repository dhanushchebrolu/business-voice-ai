-- Security fix: provider_cost was reachable by any org member via a table-level
-- SELECT grant on usage_records (RLS restricted *rows* to the caller's own org,
-- but not *columns* within those rows). The application query has been fixed to
-- stop asking for provider_cost, but that alone is app-level discipline only —
-- enforce it at the database layer too so a future `select("*")` cannot reopen
-- this leak. Admin/service-role access (admin-finance.functions.ts) is unaffected:
-- it uses the service_role client, which is not subject to these grants.

REVOKE SELECT ON public.usage_records FROM authenticated;

GRANT SELECT (
  id,
  organization_id,
  call_id,
  kind,
  provider,
  quantity,
  unit,
  billable_cost,
  occurred_at
) ON public.usage_records TO authenticated;

-- provider_cost intentionally excluded from the authenticated grant above.
-- Only service_role (admin/server-side finance code) can read it.
