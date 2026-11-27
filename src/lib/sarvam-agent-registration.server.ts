import type { SupabaseClient } from "@supabase/supabase-js";
import { withOrganizationDeploymentLock } from "./sarvam-deployment-lock.server.ts";
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

import {
  DEFAULT_MASTER_AGENT_APP_ID,
  DEFAULT_MASTER_AGENT_VERSION,
} from "./sarvam-agent-tools-spec.ts";

type Admin = SupabaseClient<Database>;

/** Sarvam agent ids look like "Conversatio-9c6a04cd-3334". */
export const SARVAM_APP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{2,80}$/;

/**
 * The ClickAI master template customers are cloned from. The environment
 * variable overrides the built-in default (the committed master) so the
 * "never map a customer to the master" rules hold even before it is set.
 */
export function masterAgentAppId(): string | null {
  return process.env["SARVAM_MASTER_AGENT_APP_ID"]?.trim() || DEFAULT_MASTER_AGENT_APP_ID;
}

/** The COMMITTED master version customers are cloned from (never the mutable draft). */
export function masterAgentVersion(): number {
  const v = Number(process.env["SARVAM_MASTER_AGENT_VERSION"]?.trim());
  return Number.isInteger(v) && v >= 1 ? v : DEFAULT_MASTER_AGENT_VERSION;
}

/** The outbound master template's Sarvam app id; never a customer's agent either. */
export function outboundMasterAgentAppId(): string | null {
  return process.env["SARVAM_OUTBOUND_MASTER_AGENT_APP_ID"]?.trim() || null;
}

/** Whether any customer already uses this Sarvam app as its OUTBOUND agent. */
async function usedAsOutboundAgent(admin: Admin, appId: string): Promise<boolean> {
  const { data, error } = await admin
    .from("agent_configs")
    .select("id")
    .eq("sarvam_outbound_app_id", appId)
    .limit(1);
  if (error) throw error;
  return (data ?? []).length > 0;
}

export interface ApplyMappingInput {
  agentConfigId: string;
  sarvamAppId: string;
  sarvamAppVersion: number;
  /** When set, the agent must belong to this organization. */
  organizationId?: string;
  masterAgentAppId: string | null;
  /** The live version move, after Sarvam confirmed this version (sarvam-live-remap.server.ts). */
  verifiedWithSarvam?: boolean;
}

/**
 * A number that is live, or was verified and is now suspended, keeps the agent and version it
 * was verified on: mapping anything else would cut off its business data or move it unchecked.
 */
export async function assertMappingMayChange(
  admin: Admin,
  organizationId: string,
  appId: string | null,
  version: number | null,
) {
  const { data, error } = await admin
    .from("phone_numbers")
    .select(
      "organization_id, status, provider_deployment_id, verified_deployment_id, verified_sarvam_app_id, verified_sarvam_app_version",
    )
    .eq("organization_id", organizationId)
    .eq("provider", "sarvam");
  if (error) throw error;
  const held = (data ?? []).some(
    (n) =>
      n.organization_id === organizationId &&
      n.provider_deployment_id &&
      (n.status === "active" || (n.status === "suspended" && n.verified_deployment_id)) &&
      (n.verified_sarvam_app_id !== appId || n.verified_sarvam_app_version !== version),
  );
  if (held)
    throw new Error(
      'This customer\'s number is live or suspended, so its agent changes only after it is checked with Sarvam: switch the number on, then register the new version of the same agent (or "Re-verify live deployment"). Nothing was changed.',
    );
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

  // An outbound agent must never answer inbound calls (agent-roles.ts).
  if (await usedAsOutboundAgent(admin, appId))
    throw new Error(
      "That Sarvam agent is registered as an outbound agent. An inbound agent must be a different agent.",
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
  const write = async () => {
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
  };
  // The live version move already holds the lock and has checked Sarvam; confirming the
  // mapping already in place (a replaced credential) changes nothing. Any other change must
  // not land in the middle of an activation or another deployment change.
  const unchanged =
    before.sarvam_app_id === appId && before.sarvam_app_version === input.sarvamAppVersion;
  if (input.verifiedWithSarvam || unchanged) await write();
  else
    await withOrganizationDeploymentLock(admin, before.organization_id, async () => {
      await assertMappingMayChange(admin, before.organization_id, appId, input.sarvamAppVersion);
      await write();
    });

  return {
    organizationId: before.organization_id,
    before: { sarvam_app_id: before.sarvam_app_id, sarvam_app_version: before.sarvam_app_version },
  };
}

export interface ApplyOutboundMappingInput {
  agentConfigId: string;
  organizationId: string;
  sarvamAppId: string;
  sarvamAppVersion: number;
  masterAgentAppIds: (string | null)[];
  registeredBy: string | null;
  now: Date;
}

export interface ApplyOutboundMappingResult {
  before: { sarvam_outbound_app_id: string | null; sarvam_outbound_app_version: number | null };
  /** True when the version confirmed for outbound calling no longer matches (it must be re-confirmed). */
  outboundConfirmationCleared: boolean;
}

/**
 * Registers the customer's OUTBOUND agent (created by an operator in Sarvam
 * from the outbound template). Rules, also enforced by the database
 * (20261120090000_dual_agent_provisioning.sql):
 *   - the agent belongs to the given customer;
 *   - never a master template (inbound or outbound);
 *   - never the customer's own inbound agent, never any customer's inbound
 *     agent or shared application, never another customer's outbound agent.
 * Re-registering the same id and version is a no-op (safe retry). A change of
 * agent or version leaves outbound calling unconfirmed: ClickAI dials only
 * when sarvam_outbound_ready_* equals this mapping (isOutboundReady).
 */
export async function applySarvamOutboundAgentMapping(
  admin: Admin,
  input: ApplyOutboundMappingInput,
): Promise<ApplyOutboundMappingResult> {
  const appId = input.sarvamAppId.trim();
  if (!SARVAM_APP_ID_PATTERN.test(appId))
    throw new Error("That does not look like a Sarvam agent id.");
  if (!Number.isInteger(input.sarvamAppVersion) || input.sarvamAppVersion < 1)
    throw new Error("The Sarvam agent version must be a positive whole number.");
  if (input.masterAgentAppIds.some((m) => m && m === appId))
    throw new Error("That is a master template. Register the customer's own outbound agent.");

  const { data: agent, error: readError } = await admin
    .from("agent_configs")
    .select(
      "id, organization_id, sarvam_app_id, sarvam_outbound_app_id, sarvam_outbound_app_version, sarvam_outbound_ready_app_id, sarvam_outbound_ready_version",
    )
    .eq("id", input.agentConfigId)
    .maybeSingle();
  if (readError) throw readError;
  if (!agent || agent.organization_id !== input.organizationId)
    throw new Error("That agent does not belong to this customer.");
  if (agent.sarvam_app_id === appId)
    throw new Error(
      "That is this customer's inbound agent. The outbound agent must be a separate Sarvam agent.",
    );
  const before = {
    sarvam_outbound_app_id: agent.sarvam_outbound_app_id,
    sarvam_outbound_app_version: agent.sarvam_outbound_app_version,
  };
  if (
    agent.sarvam_outbound_app_id === appId &&
    agent.sarvam_outbound_app_version === input.sarvamAppVersion
  )
    return { before, outboundConfirmationCleared: false };

  const { data: inbound, error: inboundError } = await admin
    .from("agent_configs")
    .select("id")
    .eq("sarvam_app_id", appId)
    .limit(1);
  if (inboundError) throw inboundError;
  const { data: shared, error: sharedError } = await admin
    .from("sarvam_applications")
    .select("id")
    .eq("sarvam_app_id", appId)
    .limit(1);
  if (sharedError) throw sharedError;
  if ((inbound ?? []).length || (shared ?? []).length)
    throw new Error("That Sarvam agent already answers inbound calls. Register a separate agent.");
  const { data: other, error: otherError } = await admin
    .from("agent_configs")
    .select("id")
    .eq("sarvam_outbound_app_id", appId)
    .neq("id", agent.id)
    .limit(1);
  if (otherError) throw otherError;
  if ((other ?? []).length)
    throw new Error("That Sarvam agent is already another customer's outbound agent.");

  const { data: saved, error } = await admin
    .from("agent_configs")
    .update({
      sarvam_outbound_app_id: appId,
      sarvam_outbound_app_version: input.sarvamAppVersion,
      sarvam_outbound_registered_at: input.now.toISOString(),
      sarvam_outbound_registered_by: input.registeredBy,
    })
    .eq("id", agent.id)
    .eq("organization_id", input.organizationId)
    .select("id");
  if (error) {
    const code = (error as { code?: string }).code;
    // idx_agent_configs_sarvam_outbound_app_id / agent_configs_sarvam_role_guard.
    if (code === "23505")
      throw new Error("That Sarvam agent is already another customer's outbound agent.");
    if (code === "23514") throw new Error("That Sarvam agent is already used as an inbound agent.");
    throw error;
  }
  if (!saved?.length) throw new Error("The customer's agent changed; try again.");
  return {
    before,
    outboundConfirmationCleared: Boolean(
      agent.sarvam_outbound_ready_app_id &&
      (agent.sarvam_outbound_ready_app_id !== appId ||
        agent.sarvam_outbound_ready_version !== input.sarvamAppVersion),
    ),
  };
}
