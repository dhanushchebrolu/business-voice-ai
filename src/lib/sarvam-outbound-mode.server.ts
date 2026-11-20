import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import {
  OUTBOUND_DISABLED_MESSAGE,
  outboundCallingDisabled,
} from "./outbound-eligibility.server.ts";
import { OUTBOUND_MAX_CALL_SECONDS_CAP, OUTBOUND_TEXT_LIMITS } from "./agent-roles.ts";

/**
 * Every customer has two Sarvam agents (agent-roles.ts): the inbound agent
 * answers the customer's number; the OUTBOUND agent, registered separately
 * (agent_configs.sarvam_outbound_app_id/_version), is the only one ClickAI
 * dials. outboundAgentTarget() is the one place that picks it, and there is
 * no fallback to the inbound agent. The direction is still set explicitly
 * for every outbound call:
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
 * Sarvam drops variables an agent does not declare, so only an outbound agent
 * version confirmed after a supervised call is dialled:
 * agent_configs.sarvam_outbound_ready_app_id/_version must equal the
 * registered outbound agent. See OUTBOUND_AGENT_VARIABLES for what it declares.
 */

type Admin = SupabaseClient<Database>;

export const OUTBOUND_NOT_READY_MESSAGE =
  "This customer's outbound Sarvam agent has not been registered and confirmed for outbound calls yet.";

/** Variables the customer's agent declares for outbound calls (template requirement). */
export const OUTBOUND_AGENT_VARIABLES = {
  /** Declared default "inbound"; not agent-updatable; never saved from a tool reply. */
  call_direction: "inbound | outbound",
  /** ClickAI call_logs id of this outbound call; empty on inbound calls. */
  clickai_call_id: "string",
  campaign_objective: "string, why this call is being made",
  campaign_instructions: "string, extra instructions from the customer",
} as const;

export { OUTBOUND_TEXT_LIMITS };

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

/** agent_configs columns every outbound path reads. */
export const OUTBOUND_AGENT_COLUMNS =
  "sarvam_app_id, sarvam_outbound_app_id, sarvam_outbound_app_version, sarvam_outbound_ready_app_id, sarvam_outbound_ready_version";

export interface OutboundReadiness {
  /** The inbound agent: read only to make sure it is never dialled. */
  sarvam_app_id: string | null;
  sarvam_outbound_app_id: string | null;
  sarvam_outbound_app_version: number | null;
  sarvam_outbound_ready_app_id: string | null;
  sarvam_outbound_ready_version: number | null;
}

/**
 * The Sarvam agent and version an outbound call dials, or null (refuse).
 * Only the customer's registered OUTBOUND agent, only in the version confirmed
 * for outbound, and never an agent that is also the inbound one. There is
 * deliberately no fallback to sarvam_app_id.
 */
export function outboundAgentTarget(
  agent: OutboundReadiness,
): { appId: string; appVersion: number } | null {
  const appId = agent.sarvam_outbound_app_id;
  const appVersion = agent.sarvam_outbound_app_version;
  if (!appId || !appVersion || appVersion < 1) return null;
  if (appId === agent.sarvam_app_id) return null;
  if (agent.sarvam_outbound_ready_app_id !== appId) return null;
  if (agent.sarvam_outbound_ready_version !== appVersion) return null;
  return { appId, appVersion };
}

/** True only when outboundAgentTarget would dial something. */
export function isOutboundReady(agent: OutboundReadiness): boolean {
  return outboundAgentTarget(agent) !== null;
}

/**
 * A Sarvam campaign (created in Sarvam's console) must run the customer's
 * outbound agent in its confirmed version before ClickAI uploads anyone to it.
 * Reads app_id / app_version from Sarvam's campaign record; anything missing
 * or different refuses (fail closed).
 */
export function sarvamCampaignUsesAgent(
  raw: Record<string, unknown>,
  target: { appId: string; appVersion: number },
): boolean {
  const appId = raw["app_id"];
  const version = Number(raw["app_version"]);
  return appId === target.appId && version === target.appVersion;
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
 * The call lengths ClickAI accepts when confirming an outbound agent version:
 * at least 1 minute, at most the platform's hard maximum
 * (OUTBOUND_MAX_CALL_SECONDS_CAP, 5 minutes). Sarvam allows up to 60.
 */
export const OUTBOUND_MAX_CALL_SECONDS = { min: 60, max: OUTBOUND_MAX_CALL_SECONDS_CAP } as const;

/**
 * Records (or clears) the customer's registered OUTBOUND agent version as
 * confirmed for outbound calls. The write is conditional on the outbound
 * mapping it read, so a concurrent re-registration can never be marked ready
 * by mistake. The inbound agent can never be confirmed for outbound.
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
          "Enter the agent version's maximum call length from Sarvam (1 to 5 minutes). Set it in Sarvam first; outbound calls may last at most 5 minutes.",
      };
  }
  const { data: agents, error } = await admin
    .from("agent_configs")
    .select(
      "id, organization_id, sarvam_app_id, sarvam_outbound_app_id, sarvam_outbound_app_version",
    )
    .eq("organization_id", input.organizationId);
  if (error) throw error;
  const own = (agents ?? []).filter((a) => a.organization_id === input.organizationId);
  if (own.length !== 1) return { ok: false, reason: "This customer must have exactly one agent." };
  const agent = own[0]!;
  if (input.ready && (!agent.sarvam_outbound_app_id || !agent.sarvam_outbound_app_version))
    return {
      ok: false,
      reason: "Register this customer's outbound Sarvam agent before confirming outbound calls.",
    };
  if (input.ready && agent.sarvam_outbound_app_id === agent.sarvam_app_id)
    return { ok: false, reason: "The outbound agent must not be the inbound agent." };

  let query = admin
    .from("agent_configs")
    .update(
      input.ready
        ? {
            sarvam_outbound_ready_app_id: agent.sarvam_outbound_app_id,
            sarvam_outbound_ready_version: agent.sarvam_outbound_app_version,
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
      .eq("sarvam_outbound_app_id", agent.sarvam_outbound_app_id!)
      .eq("sarvam_outbound_app_version", agent.sarvam_outbound_app_version!);
  const { data: updated, error: updateError } = await query.select("id");
  if (updateError) throw updateError;
  if (!updated || updated.length === 0)
    return { ok: false, reason: "The agent mapping changed meanwhile. Reload and try again." };
  return input.ready
    ? {
        ok: true,
        ready: true,
        appId: agent.sarvam_outbound_app_id,
        appVersion: agent.sarvam_outbound_app_version,
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
    .select(`organization_id, ${OUTBOUND_AGENT_COLUMNS}`)
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
