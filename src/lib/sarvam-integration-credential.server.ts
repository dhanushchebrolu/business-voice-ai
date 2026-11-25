import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import type { AgentRole } from "./agent-roles.ts";

type Admin = SupabaseClient<Database>;

/**
 * Creates a customer agent's integration credential, or rotates it (the old
 * token stops working at once). Returns the raw token, which exists only in
 * this return value: only its hash and a display prefix are stored. Shared by
 * the admin screen and the operator bridge; callers own authorization + audit.
 */
export async function issueIntegrationCredential(
  admin: Admin,
  input: {
    organizationId: string;
    agentConfigId: string;
    role: AgentRole;
    expiresInDays?: number | undefined;
    createdBy: string | null;
  },
): Promise<{
  token: string;
  prefix: string;
  rotated: boolean;
  expiresAt: string | null;
  integrationId: string;
}> {
  const { generateIntegrationToken } = await import("./sarvam-agent-api.server.ts");
  const { token, hash, prefix } = await generateIntegrationToken();
  const expiresAt = input.expiresInDays
    ? new Date(Date.now() + input.expiresInDays * 86_400_000).toISOString()
    : null;
  const { data: active } = await admin
    .from("sarvam_agent_integrations")
    .select("id")
    .eq("agent_config_id", input.agentConfigId)
    .eq("role", input.role)
    .eq("status", "active")
    .maybeSingle();
  let integrationId: string;
  if (active) {
    const { error } = await admin
      .from("sarvam_agent_integrations")
      .update({
        token_hash: hash,
        token_prefix: prefix,
        rotated_at: new Date().toISOString(),
        expires_at: expiresAt,
      })
      .eq("id", active.id)
      .eq("role", input.role)
      .eq("status", "active");
    if (error) throw error;
    integrationId = active.id;
  } else {
    const { data: created, error } = await admin
      .from("sarvam_agent_integrations")
      .insert({
        organization_id: input.organizationId,
        agent_config_id: input.agentConfigId,
        token_hash: hash,
        token_prefix: prefix,
        expires_at: expiresAt,
        created_by: input.createdBy,
        role: input.role,
      })
      .select("id")
      .single();
    if (error) throw error;
    integrationId = created.id;
  }
  return { token, prefix, rotated: Boolean(active), expiresAt, integrationId };
}
