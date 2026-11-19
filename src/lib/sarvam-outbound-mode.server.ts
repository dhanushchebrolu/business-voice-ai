import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import {
  OUTBOUND_DISABLED_MESSAGE,
  outboundCallingDisabled,
} from "./outbound-eligibility.server.ts";

/**
 * One Sarvam agent per customer answers inbound calls and places outbound
 * calls. The direction is set explicitly for every outbound call:
 *
 *   - ClickAI passes call_direction = "outbound", its own call id and the
 *     campaign objective/instructions as agent variables, and overrides the
 *     opening line (app_config.agent_variables and
 *     app_config.app_overrides.initial_bot_message, both in Sarvam's
 *     instant-outbound API reference).
 *   - Inbound calls come through the deployment and pass nothing, so the
 *     agent's declared default call_direction ("inbound") applies. Stored
 *     campaign data never switches an inbound call to outbound.
 *
 * Sarvam drops variables an agent does not declare, so only an agent version
 * confirmed to declare them (and to carry the outbound section) is dialled:
 * agent_configs.sarvam_outbound_ready_app_id/_version must equal the agent's
 * current mapping. See OUTBOUND_AGENT_VARIABLES for what the agent declares.
 */

type Admin = SupabaseClient<Database>;

export const OUTBOUND_NOT_READY_MESSAGE =
  "This customer's Sarvam agent version has not been confirmed for outbound calls yet.";

/** Variables the customer's agent declares for outbound calls (template requirement). */
export const OUTBOUND_AGENT_VARIABLES = {
  /** Declared default "inbound"; not agent-updatable; never saved from a tool reply. */
  call_direction: "inbound | outbound",
  /** ClickAI call_logs id of this outbound call; empty on inbound calls. */
  clickai_call_id: "string",
  campaign_objective: "string, why this call is being made",
  campaign_instructions: "string, extra instructions from the customer",
} as const;

export const OUTBOUND_TEXT_LIMITS = { objective: 300, instructions: 1500, businessName: 120 };

/**
 * The outbound variable names only ClickAI sets. They are removed from any
 * contact or caller-supplied variables, so a contact column can never stand
 * in for the direction, the call id or the campaign's own objective.
 */
export function withoutReservedOutboundVariables<T>(
  vars: Record<string, T> | null | undefined,
): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(vars ?? {})) if (!(k in OUTBOUND_AGENT_VARIABLES)) out[k] = v;
  return out;
}

export interface OutboundReadiness {
  sarvam_app_id: string | null;
  sarvam_app_version: number | null;
  sarvam_outbound_ready_app_id: string | null;
  sarvam_outbound_ready_version: number | null;
}

/** True only when the confirmed outbound version is exactly the agent's current mapping. */
export function isOutboundReady(agent: OutboundReadiness): boolean {
  return (
    Boolean(agent.sarvam_app_id) &&
    Boolean(agent.sarvam_app_version) &&
    agent.sarvam_outbound_ready_app_id === agent.sarvam_app_id &&
    agent.sarvam_outbound_ready_version === agent.sarvam_app_version
  );
}

/** Customer-written text for the model: no control characters, single spaces, capped. */
export function sanitizeOutboundText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return clean ? clean.slice(0, max).trim() : undefined;
}

/**
 * The agent variables for one outbound call. Spread these LAST, so no contact
 * column, template variable or caller-supplied value can change the direction
 * or the call id.
 */
export function outboundCallVariables(input: {
  callId: string;
  objective?: unknown;
  instructions?: unknown;
}): Record<string, string> {
  const vars: Record<string, string> = {
    call_direction: "outbound",
    clickai_call_id: input.callId,
  };
  const objective = sanitizeOutboundText(input.objective, OUTBOUND_TEXT_LIMITS.objective);
  const instructions = sanitizeOutboundText(input.instructions, OUTBOUND_TEXT_LIMITS.instructions);
  if (objective) vars["campaign_objective"] = objective;
  if (instructions) vars["campaign_instructions"] = instructions;
  return vars;
}

/**
 * The outbound opening line (replaces the inbound greeting for this call
 * only). It says who is calling and asks for the moment; nothing about the
 * person or the reason is said before they confirm it is a good time.
 */
export function outboundOpeningLine(businessName: unknown): string {
  const name = sanitizeOutboundText(businessName, OUTBOUND_TEXT_LIMITS.businessName);
  return name
    ? `Hello, this is the virtual assistant calling from ${name}. Is this a good time to talk?`
    : "Hello, this is a virtual assistant calling. Is this a good time to talk?";
}

/** The business name for the opening line, from the agent's own business (same organization only). */
export async function outboundBusinessName(
  admin: Admin,
  agent: { organization_id: string; business_id: string | null },
): Promise<string | null> {
  if (!agent.business_id) return null;
  const { data, error } = await admin
    .from("businesses")
    .select("name, organization_id")
    .eq("id", agent.business_id)
    .maybeSingle();
  if (error) throw error;
  if (!data || data.organization_id !== agent.organization_id) return null;
  return data.name ?? null;
}

export type SetOutboundReadyResult =
  | {
      ok: true;
      ready: boolean;
      appId: string | null;
      appVersion: number | null;
      maxCallSeconds: number | null;
    }
  | { ok: false; reason: string };

/**
 * The longest call ClickAI accepts for an outbound agent version: Sarvam's
 * "Max call length" setting allows at most 60 minutes.
 */
export const OUTBOUND_MAX_CALL_SECONDS = { min: 60, max: 3600 } as const;

/**
 * Records (or clears) the customer's CURRENT agent version as confirmed for
 * outbound calls. The write is conditional on the mapping it read, so a
 * concurrent remap can never be marked ready by mistake.
 */
export async function setOutboundReady(
  admin: Admin,
  input: {
    organizationId: string;
    ready: boolean;
    /**
     * The agent version's maximum call length as set in Sarvam ("Max call
     * length" / max_interaction_time_seconds), checked there by the admin.
     * Required to confirm: it bounds every call's charge and the wallet
     * reservation (admit_single_outbound_call, call finalization).
     */
    maxCallSeconds?: number | undefined;
  },
): Promise<SetOutboundReadyResult> {
  if (input.ready) {
    const s = input.maxCallSeconds;
    if (
      typeof s !== "number" ||
      !Number.isInteger(s) ||
      s < OUTBOUND_MAX_CALL_SECONDS.min ||
      s > OUTBOUND_MAX_CALL_SECONDS.max
    )
      return {
        ok: false,
        reason:
          "Enter the agent version's maximum call length from Sarvam (1 to 60 minutes). Set it in Sarvam first if it is not set.",
      };
  }
  const { data: agents, error } = await admin
    .from("agent_configs")
    .select("id, organization_id, sarvam_app_id, sarvam_app_version")
    .eq("organization_id", input.organizationId);
  if (error) throw error;
  const own = (agents ?? []).filter((a) => a.organization_id === input.organizationId);
  if (own.length !== 1) return { ok: false, reason: "This customer must have exactly one agent." };
  const agent = own[0]!;
  if (input.ready && (!agent.sarvam_app_id || !agent.sarvam_app_version))
    return { ok: false, reason: "This customer's agent is not mapped to a Sarvam agent version." };

  let query = admin
    .from("agent_configs")
    .update(
      input.ready
        ? {
            sarvam_outbound_ready_app_id: agent.sarvam_app_id,
            sarvam_outbound_ready_version: agent.sarvam_app_version,
            sarvam_outbound_max_call_seconds: input.maxCallSeconds!,
          }
        : {
            sarvam_outbound_ready_app_id: null,
            sarvam_outbound_ready_version: null,
            sarvam_outbound_max_call_seconds: null,
          },
    )
    .eq("id", agent.id)
    .eq("organization_id", input.organizationId);
  if (input.ready)
    query = query
      .eq("sarvam_app_id", agent.sarvam_app_id!)
      .eq("sarvam_app_version", agent.sarvam_app_version!);
  const { data: updated, error: updateError } = await query.select("id");
  if (updateError) throw updateError;
  if (!updated || updated.length === 0)
    return { ok: false, reason: "The agent mapping changed meanwhile. Reload and try again." };
  return input.ready
    ? {
        ok: true,
        ready: true,
        appId: agent.sarvam_app_id,
        appVersion: agent.sarvam_app_version,
        maxCallSeconds: input.maxCallSeconds!,
      }
    : { ok: true, ready: false, appId: null, appVersion: null, maxCallSeconds: null };
}

/**
 * Sarvam-side campaign statuses that stop dialling. Stopping is always
 * allowed: refusing to stop a campaign would be the unsafe direction.
 */
const STOPPING_CAMPAIGN_STATUSES = new Set([
  "paused",
  "pause",
  "cancelled",
  "canceled",
  "cancel",
  "stopped",
  "stop",
]);

export type SarvamCampaignStatusCheck =
  | { ok: true; organizationId: string | null }
  | { ok: false; organizationId: string | null; reason: string };

/**
 * Before an admin changes a provider-side (Sarvam) campaign's status: any
 * status that could start or resume dialling needs a ClickAI campaign mapped
 * to that Sarvam campaign whose agent (same organization) is outbound-ready
 * in its current version. Unknown campaigns fail closed. Name-only changes
 * and stopping statuses pass.
 */
export async function checkSarvamCampaignStatusChange(
  admin: Admin,
  input: { providerCampaignId: string; status: string | undefined },
): Promise<SarvamCampaignStatusCheck> {
  const status = input.status?.trim().toLowerCase();
  const { data: rows, error } = await admin
    .from("campaigns")
    .select("id, organization_id, agent_config_id")
    .eq("provider_campaign_id", input.providerCampaignId);
  if (error) throw error;
  const organizationId = rows?.length === 1 ? rows[0]!.organization_id : null;
  if (!status || STOPPING_CAMPAIGN_STATUSES.has(status)) return { ok: true, organizationId };
  // Starting or resuming is refused while the global outbound kill switch is on.
  if (outboundCallingDisabled())
    return { ok: false, organizationId, reason: OUTBOUND_DISABLED_MESSAGE };

  if (!rows || rows.length !== 1 || !rows[0]!.agent_config_id)
    return {
      ok: false,
      organizationId,
      reason: "This Sarvam campaign is not mapped to exactly one ClickAI campaign with an agent.",
    };
  const campaign = rows[0]!;
  const { data: agent, error: agentError } = await admin
    .from("agent_configs")
    .select(
      "organization_id, sarvam_app_id, sarvam_app_version, sarvam_outbound_ready_app_id, sarvam_outbound_ready_version",
    )
    .eq("id", campaign.agent_config_id!)
    .maybeSingle();
  if (agentError) throw agentError;
  if (!agent || agent.organization_id !== campaign.organization_id)
    return {
      ok: false,
      organizationId,
      reason: "The campaign's agent does not belong to its organization.",
    };
  if (!isOutboundReady(agent))
    return { ok: false, organizationId, reason: OUTBOUND_NOT_READY_MESSAGE };
  return { ok: true, organizationId };
}
