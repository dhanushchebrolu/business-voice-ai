import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

/**
 * Registers which Sarvam agent (app id + committed version) answers for a
 * ClickAI agent. Shared by the admin "Map Sarvam app" action
 * (sarvam-admin.functions.ts setSarvamAppMapping) and the provisioning
 * checklist (provisioning-admin.functions.ts registerCustomerSarvamAgent),
 * so the rules exist once. Callers own authorization and auditing.
 *
 * Rules: the agent must belong to the expected organization (when given);
 * the universal master agent itself can never be a customer's agent; one
 * Sarvam app maps to one ClickAI agent (idx_agent_configs_sarvam_app_id);
 * only this organization's unlinked numbers are linked to the agent.
 */

type Admin = SupabaseClient<Database>;

/** Sarvam agent ids look like "Conversatio-9c6a04cd-3334". */
export const SARVAM_APP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{2,80}$/;

export function masterAgentAppId(): string | null {
  return process.env["SARVAM_MASTER_AGENT_APP_ID"]?.trim() || null;
}

export interface ApplyMappingInput {
  agentConfigId: string;
  sarvamAppId: string;
  sarvamAppVersion: number;
  /** When set, the agent must belong to this organization. */
  organizationId?: string;
  masterAgentAppId: string | null;
}

export interface ApplyMappingResult {
  organizationId: string;
  before: { sarvam_app_id: string | null; sarvam_app_version: number | null };
}

export async function applySarvamAgentMapping(
  admin: Admin,
  input: ApplyMappingInput,
): Promise<ApplyMappingResult> {
  const appId = input.sarvamAppId.trim();
  if (!SARVAM_APP_ID_PATTERN.test(appId))
    throw new Error("That does not look like a Sarvam agent id.");
  if (!Number.isInteger(input.sarvamAppVersion) || input.sarvamAppVersion < 1)
    throw new Error("The Sarvam agent version must be a positive whole number.");
  if (input.masterAgentAppId && appId === input.masterAgentAppId)
    throw new Error(
      "That is the universal master agent. Register the customer's own copy of it instead.",
    );

  const { data: before, error: readError } = await admin
    .from("agent_configs")
    .select("id, organization_id, sarvam_app_id, sarvam_app_version")
    .eq("id", input.agentConfigId)
    .maybeSingle();
  if (readError) throw readError;
  if (!before) throw new Error("Agent not found");
  if (input.organizationId && before.organization_id !== input.organizationId)
    throw new Error("That agent does not belong to this customer.");

  const { error } = await admin
    .from("agent_configs")
    // A direct mapping replaces any template mapping (the template's
    // trigger would otherwise copy its own app id back over this one).
    .update({
      sarvam_app_id: appId,
      sarvam_app_version: input.sarvamAppVersion,
      sarvam_application_id: null,
    })
    .eq("id", input.agentConfigId)
    .eq("organization_id", before.organization_id);
  if (error) {
    // idx_agent_configs_sarvam_app_id or the template guard trigger.
    if ((error as { code?: string }).code === "23505")
      throw new Error("This Sarvam app is already mapped to a different agent.");
    throw error;
  }

  // Numbers assigned before the agent existed get it now (same org only).
  const { error: linkError } = await admin
    .from("phone_numbers")
    .update({ agent_config_id: input.agentConfigId })
    .eq("organization_id", before.organization_id)
    .is("agent_config_id", null)
    .neq("status", "released");
  if (linkError) throw linkError;

  return {
    organizationId: before.organization_id,
    before: { sarvam_app_id: before.sarvam_app_id, sarvam_app_version: before.sarvam_app_version },
  };
}
