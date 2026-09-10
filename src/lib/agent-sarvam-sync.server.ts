/**
 * Publish-time Sarvam synchronization for the existing Agent Builder
 * (agent.functions.ts's publishAgentVersion/rollbackAgentVersion). Klyro's
 * agent configuration remains the sole source of truth; this module is the
 * one place that pushes anything to Sarvam as a consequence of a publish.
 *
 * FIELD MAPPING — read before changing this file. There is no verified
 * Sarvam API for agent *content* (persona, voice, greeting, capabilities,
 * objectives, custom personality, after-hours behavior, transfer number,
 * language/pace/multilingual). sarvam-provider.server.ts's own module doc
 * lists a Voice Agent create/update endpoint as explicitly unverified/not
 * implemented, and no such endpoint is used anywhere else in this codebase.
 * A Sarvam-managed call (phone_numbers.provider = 'sarvam') runs against a
 * Sarvam-side "app" configured manually in Sarvam's own dashboard —
 * Klyro's agent_configs fields do not drive that call at all. Per the
 * "keep the field Klyro-side rather than inventing an API field" rule,
 * EVERY one of those fields stays Klyro-only:
 *
 *   Klyro field                  Sarvam field   Verified?   Action
 *   ---------------------------  -------------  ----------  ------------------
 *   agent_name/persona/greeting  (none)         no          Klyro-only
 *   primary_language/pace/multi  (none)         no          Klyro-only
 *   capabilities/objectives      (none)         no          Klyro-only
 *   custom_personality           (none)         no          Klyro-only
 *   after_hours_behavior         (none)         no          Klyro-only
 *   transfer_number              (none)         no          Klyro-only
 *   deployment display metadata  description    code exists,
 *                                                not live-   synchronized below
 *                                                verified    (this file)
 *
 * The ONE real, verified-to-exist (never live-verified — see
 * sarvam-provider.server.ts) operation available is
 * SarvamTelephonyAdapter.updateInboundDeployment, which only accepts
 * name/description/phoneNumbers/inboundConfig — none of which are agent
 * *behavior*. This module updates only `description`, deliberately never
 * `name` (an admin/dashboard-set label a publish should not silently
 * overwrite), with a short, traceable note. This is metadata bookkeeping,
 * not a claim that Sarvam's own call behavior changed.
 *
 * sarvam_app_id/sarvam_app_version/deployment IDs are never taken from the
 * browser here — they are resolved server-side from phone_numbers/
 * agent_configs, the same trusted pattern sarvam-admin.functions.ts already
 * uses.
 */

import { TelephonyAdapterError } from "@/lib/telephony/adapter";

export interface SarvamSyncResult {
  /** false when this agent has no active Sarvam deployment — nothing to sync, not an error. */
  synced: boolean;
  deploymentIds: string[];
}

/**
 * Looks up the active Sarvam deployment(s) associated with this business's
 * agent (via phone_numbers.agent_config_id) and pushes a description update
 * to each. Throws (never returns a fake success) if a deployment exists but
 * the sync call fails — callers MUST NOT commit the Klyro-side version
 * activation unless this resolves without throwing.
 */
export async function syncPublishedAgentToSarvam(
  businessId: string,
  note: string,
): Promise<SarvamSyncResult> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  const { data: agent } = await supabaseAdmin
    .from("agent_configs")
    .select("id")
    .eq("business_id", businessId)
    .maybeSingle();
  if (!agent) return { synced: false, deploymentIds: [] };

  const { data: numbers } = await supabaseAdmin
    .from("phone_numbers")
    .select("provider, status, provider_deployment_id")
    .eq("agent_config_id", agent.id);

  const deploymentIds = [
    ...new Set(
      (numbers ?? [])
        .filter((n) => n.provider === "sarvam" && n.status === "active" && n.provider_deployment_id)
        .map((n) => n.provider_deployment_id as string),
    ),
  ];
  if (deploymentIds.length === 0) return { synced: false, deploymentIds: [] };

  const { getTelephonyAdapter } = await import("@/lib/telephony.server");
  const { SarvamTelephonyAdapter } = await import("@/lib/telephony/sarvam-provider.server");
  const adapter = getTelephonyAdapter("sarvam");
  if (!adapter || !(adapter instanceof SarvamTelephonyAdapter)) {
    throw new TelephonyAdapterError(
      "This agent has an active Sarvam deployment, but Sarvam is not connected (SARVAM_API_KEY not configured). Publish cannot proceed without keeping the deployment in sync.",
      503,
    );
  }

  for (const deploymentId of deploymentIds) {
    // Real HTTP PATCH — see SarvamTelephonyAdapter.updateInboundDeployment's
    // own doc for verification status. A failure here throws and propagates
    // to the caller unmodified; it is never swallowed into a fake success.
    await adapter.updateInboundDeployment(deploymentId, { description: note });
  }

  return { synced: true, deploymentIds };
}
