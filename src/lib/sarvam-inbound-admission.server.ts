import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { normalizeCustomerPhone } from "./phone-number.ts";

/**
 * Inbound admission gate (Phase 5). Every Sarvam request that could reveal a
 * customer's business data (the on-start context, get_business_info and every
 * tool, plus the older shared-secret client-context route) must pass this
 * check first. It fails closed: any missing row, mismatch or database error
 * denies.
 *
 * What it protects, and what it does not: it stops ClickAI from serving
 * business context or running tools for a number that is not ACTIVE with a
 * verified deployment mapping. It cannot stop Sarvam from answering the
 * phone. Sarvam creates deployments in "active" status (documented), so a
 * new customer's number can ring through to the agent in the seconds
 * between deployment creation and the pipeline pausing it; during that
 * window the agent gets no ClickAI data. Pausing narrows the window; this
 * gate makes sure nothing leaks inside it.
 *
 * Sarvam's documented tool requests carry no dialled number or deployment
 * id, so ClickAI cannot tell which of a customer's numbers a call came in
 * on. The gate therefore enforces the invariant it can check: the customer
 * has EXACTLY ONE non-released Sarvam number, it is linked to the
 * credential's agent, and it is admitted. A second number (verified or not)
 * denies the whole customer, so an unverified number can never ride on a
 * verified one. Identifiers a request supplies (deployment_id, phone_number
 * on the legacy route) only narrow the check; they must equal the verified
 * values and can never widen it.
 */

type Admin = SupabaseClient<Database>;

export type AdmissionDenial =
  | "agent_not_found"
  | "agent_not_mapped"
  | "organization_inactive"
  | "no_number"
  | "multiple_numbers"
  | "number_not_linked"
  | "number_not_active"
  | "inbound_disabled"
  | "no_deployment"
  | "not_verified"
  | "deployment_mismatch"
  | "agent_mismatch"
  | "version_mismatch"
  | "blocked"
  | "deployment_shared"
  | "identifier_mismatch"
  | "lookup_failed";

export type AdmissionResult =
  | { admitted: true; numberIds: string[]; deploymentIds: string[] }
  | { admitted: false; reason: AdmissionDenial };

export interface AdmissionInput {
  organizationId: string;
  agentConfigId: string;
  /** Untrusted, request-supplied: must match a verified number exactly. */
  deploymentId?: string | undefined;
  /** Untrusted, request-supplied: must match a verified number exactly. */
  phoneNumber?: string | undefined;
}

const INACTIVE_ORG = ["suspended", "cancelled", "archived"];
const canonical = (n: string) => normalizeCustomerPhone(n, null) ?? n;

export async function checkInboundAdmission(
  admin: Admin,
  input: AdmissionInput,
): Promise<AdmissionResult> {
  try {
    return await evaluate(admin, input);
  } catch {
    return { admitted: false, reason: "lookup_failed" };
  }
}

/**
 * The older shared-secret client-context route identifies the customer only
 * by request-supplied deployment_id / phone_number. The organization they
 * resolved to must have exactly one agent, and the same identifiers must
 * match that agent's admitted, verified number.
 */
export async function checkLegacyContextAdmission(
  admin: Admin,
  organizationId: string,
  ids: { deploymentId?: string | undefined; phoneNumber?: string | undefined },
): Promise<AdmissionResult> {
  try {
    if (!ids.deploymentId && !ids.phoneNumber)
      return { admitted: false, reason: "identifier_mismatch" };
    const { data: agents, error } = await admin
      .from("agent_configs")
      .select("id, organization_id")
      .eq("organization_id", organizationId);
    if (error || !Array.isArray(agents)) return { admitted: false, reason: "lookup_failed" };
    const own = agents.filter((a) => a.organization_id === organizationId);
    if (own.length !== 1) return { admitted: false, reason: "agent_not_found" };
    return await evaluate(admin, { organizationId, agentConfigId: own[0]!.id, ...ids });
  } catch {
    return { admitted: false, reason: "lookup_failed" };
  }
}

/**
 * Called for every Sarvam inbound call result. Sarvam's after-call webhook
 * names the agent (app_id) and the deployment that handled the call. If the
 * agent is a ClickAI customer's and the deployment is not one ClickAI has
 * on file for that customer's numbers, someone routed the customer's agent
 * through a deployment ClickAI never verified: block admission for that
 * customer until an admin reviews and clears it. Deployments ClickAI has
 * recorded (including one created moments ago and not yet verified) never
 * trigger a block.
 */
export async function blockAdmissionOnUnknownDeployment(
  admin: Admin,
  params: { appId: string; deploymentId: string; now: Date },
): Promise<{ blocked: boolean; agentConfigId: string | null }> {
  const { data: agent, error } = await admin
    .from("agent_configs")
    .select("id, organization_id")
    .eq("sarvam_app_id", params.appId)
    .maybeSingle();
  if (error) throw error;
  if (!agent) return { blocked: false, agentConfigId: null };
  const { data: rows, error: numbersError } = await admin
    .from("phone_numbers")
    .select("id, status, organization_id, provider_deployment_id, verified_deployment_id")
    .eq("agent_config_id", agent.id)
    .eq("provider", "sarvam");
  if (numbersError) throw numbersError;
  const numbers = (rows ?? []).filter(
    (n) => n.status !== "released" && n.organization_id === agent.organization_id,
  );
  if (numbers.length === 0) return { blocked: false, agentConfigId: agent.id };
  const known = new Set(
    numbers.flatMap((n) => [n.provider_deployment_id, n.verified_deployment_id]).filter(Boolean),
  );
  if (known.has(params.deploymentId)) return { blocked: false, agentConfigId: agent.id };
  const { error: blockError } = await admin
    .from("phone_numbers")
    .update({
      admission_blocked_at: params.now.toISOString(),
      admission_blocked_reason: `A call reached this customer's agent through deployment ${params.deploymentId}, which ClickAI has not verified.`,
    })
    .in(
      "id",
      numbers.map((n) => n.id),
    )
    .is("admission_blocked_at", null);
  if (blockError) throw blockError;
  return { blocked: true, agentConfigId: agent.id };
}

async function evaluate(admin: Admin, input: AdmissionInput): Promise<AdmissionResult> {
  const deny = (reason: AdmissionDenial): AdmissionResult => ({ admitted: false, reason });

  const { data: agent, error: agentError } = await admin
    .from("agent_configs")
    .select("id, organization_id, sarvam_app_id, sarvam_app_version")
    .eq("id", input.agentConfigId)
    .maybeSingle();
  if (agentError) return deny("lookup_failed");
  if (!agent || agent.organization_id !== input.organizationId) return deny("agent_not_found");
  if (!agent.sarvam_app_id || !agent.sarvam_app_version) return deny("agent_not_mapped");

  const { data: org, error: orgError } = await admin
    .from("organizations")
    .select("id, lifecycle_status")
    .eq("id", input.organizationId)
    .maybeSingle();
  if (orgError) return deny("lookup_failed");
  if (!org || INACTIVE_ORG.includes(org.lifecycle_status)) return deny("organization_inactive");

  // Every Sarvam number of the organization, whatever agent it is linked to.
  const { data: rows, error: numbersError } = await admin
    .from("phone_numbers")
    .select(
      "id, e164, status, provider, organization_id, agent_config_id, inbound_enabled, provider_deployment_id, verified_deployment_id, verified_sarvam_app_id, verified_sarvam_app_version, admission_blocked_at",
    )
    .eq("organization_id", input.organizationId)
    .eq("provider", "sarvam");
  if (numbersError || !Array.isArray(rows)) return deny("lookup_failed");
  // Re-check ownership in code too: never trust that the filter ran.
  const numbers = rows.filter(
    (n) =>
      n.status !== "released" &&
      n.provider === "sarvam" &&
      n.organization_id === input.organizationId,
  );
  if (numbers.length === 0) return deny("no_number");
  if (numbers.length > 1) return deny("multiple_numbers");
  const n = numbers[0]!;
  if (n.agent_config_id !== input.agentConfigId) return deny("number_not_linked");
  if (n.admission_blocked_at) return deny("blocked");
  if (n.status !== "active") return deny("number_not_active");
  if (!n.inbound_enabled) return deny("inbound_disabled");
  if (!n.provider_deployment_id) return deny("no_deployment");
  if (!n.verified_deployment_id || !n.verified_sarvam_app_id || !n.verified_sarvam_app_version)
    return deny("not_verified");
  if (n.verified_deployment_id !== n.provider_deployment_id) return deny("deployment_mismatch");
  if (n.verified_sarvam_app_id !== agent.sarvam_app_id) return deny("agent_mismatch");
  if (n.verified_sarvam_app_version !== agent.sarvam_app_version) return deny("version_mismatch");

  const deploymentIds = [...new Set(numbers.map((n) => n.provider_deployment_id as string))];
  if (input.deploymentId !== undefined && !deploymentIds.includes(input.deploymentId))
    return deny("identifier_mismatch");
  if (
    input.phoneNumber !== undefined &&
    !numbers.some((n) => canonical(n.e164) === canonical(input.phoneNumber!))
  )
    return deny("identifier_mismatch");

  // A deployment this customer uses must not be recorded for anyone else.
  const { data: others, error: othersError } = await admin
    .from("phone_numbers")
    .select("id, organization_id, status")
    .in("provider_deployment_id", deploymentIds);
  if (othersError || !Array.isArray(others)) return deny("lookup_failed");
  if (others.some((o) => o.id !== n.id && o.status !== "released"))
    return deny("deployment_shared");

  return { admitted: true, numberIds: numbers.map((n) => n.id), deploymentIds };
}
