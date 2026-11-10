import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { getBusinessType, getEmployeeType } from "./business-types.ts";

/** The agent_configs columns templateCallVariables needs, read by the caller's own agent query. */
export const TEMPLATE_AGENT_COLUMNS =
  "business_id, sarvam_application_id, employee_type, agent_name";

export interface TemplateAgent {
  organization_id: string;
  business_id: string;
  sarvam_application_id: string | null;
  employee_type: string | null;
  agent_name: string;
}

/**
 * Per-call business variables for an agent mapped to a Sarvam application
 * template (agent_configs.sarvam_application_id). A template app is authored
 * once and used by several customers, so it knows nothing about any one of
 * them: every outbound call carries the calling customer's own business
 * identity as agent variables, read here from that customer's own rows.
 * Templates must declare these variable names in Sarvam's dashboard.
 *
 * Agents mapped directly to their own Sarvam app get no extra variables
 * (an empty object): their app was authored for that one customer, and
 * Sarvam may not accept variables the app does not declare.
 */
export async function templateCallVariables(
  supabaseAdmin: SupabaseClient<Database>,
  agent: TemplateAgent,
  organizationId: string,
): Promise<Record<string, string>> {
  if (!agent.sarvam_application_id) return {};
  // Never mix tenants: the agent must belong to the calling organization.
  if (agent.organization_id !== organizationId)
    throw new Error("This number's agent does not belong to this organization.");

  const { data: business } = await supabaseAdmin
    .from("businesses")
    .select("organization_id, name, business_type, description, primary_phone, timezone")
    .eq("id", agent.business_id)
    .maybeSingle();
  if (!business || business.organization_id !== organizationId)
    throw new Error("This agent's business profile is missing.");

  return {
    business_name: business.name,
    business_type: getBusinessType(business.business_type).label,
    employee_role: getEmployeeType(agent.employee_type).label,
    agent_name: agent.agent_name,
    business_phone: business.primary_phone ?? "",
    business_timezone: business.timezone,
    // shortcut: description only, capped; full context needs the on-start hook once Sarvam's tenant routing is verified.
    business_description: (business.description ?? "").slice(0, 500),
  };
}
