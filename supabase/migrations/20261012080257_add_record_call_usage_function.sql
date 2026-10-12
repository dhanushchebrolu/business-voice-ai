
CREATE OR REPLACE FUNCTION public.record_call_usage(
  p_organization_id uuid,
  p_call_id uuid,
  p_kind text,
  p_provider text,
  p_quantity numeric,
  p_unit text,
  p_provider_cost numeric,
  p_billable_cost numeric
)
RETURNS void
LANGUAGE sql
SET search_path TO ''
AS $function$
  INSERT INTO public.usage_records (
    organization_id,
    call_id,
    kind,
    provider,
    quantity,
    unit,
    provider_cost,
    billable_cost
  )
  VALUES (
    p_organization_id,
    p_call_id,
    p_kind,
    p_provider,
    p_quantity,
    p_unit,
    p_provider_cost,
    p_billable_cost
  )
  ON CONFLICT (call_id, kind)
    WHERE call_id IS NOT NULL
  DO NOTHING;
$function$;

GRANT EXECUTE ON FUNCTION public.record_call_usage(
  uuid, uuid, text, text, numeric, text, numeric, numeric
) TO service_role;
