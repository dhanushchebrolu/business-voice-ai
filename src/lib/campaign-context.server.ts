/**
 * Campaign context: drafting, saving the reviewed context, and the eligibility
 * preview. The server-function wrappers (campaign-context.functions.ts) do the
 * authorization; these take an already-authorized organization.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import {
  CAMPAIGN_CONTEXT_VERSION,
  buildDraftRequest,
  compileCampaignContext,
  draftCampaignContext,
  parseDraftResponse,
  validateCampaignContext,
  type CampaignContext,
  type CompiledContext,
} from "./campaign-context.ts";
import { evaluateEligibility, type ExclusionReason } from "./campaign-results.ts";
import { normalizeCustomerPhone } from "./phone-number.ts";

type Admin = SupabaseClient<Database>;

/** The statuses in which a campaign's context may still be changed. */
export const CONTEXT_EDITABLE_STATUSES = ["draft", "scheduled", "paused"];

async function campaignRow(admin: Admin, organizationId: string, campaignId: string) {
  const { data, error } = await admin
    .from("campaigns")
    .select("id, organization_id, business_id, status, description")
    .eq("id", campaignId)
    .maybeSingle();
  if (error) throw error;
  if (!data || data.organization_id !== organizationId) throw new Error("Campaign not found.");
  return data;
}

export type DraftFn = (request: { system: string; user: string }) => Promise<string>;

/**
 * A draft context for review. Uses the LLM when one is configured; if it is not,
 * or it fails, or its answer does not validate, a deterministic draft is used.
 * Nothing is saved.
 */
export async function prepareCampaignContextFor(
  admin: Admin,
  organizationId: string,
  campaignId: string,
  description: string,
  draft: DraftFn | null,
): Promise<{ context: CampaignContext; source: "llm" | "rules" }> {
  const campaign = await campaignRow(admin, organizationId, campaignId);
  const text = description.trim() || campaign.description || "";
  if (!text) throw new Error("Describe the campaign first.");
  if (draft) {
    const business = await businessFacts(admin, organizationId, campaign.business_id);
    try {
      const parsed = parseDraftResponse(await draft(buildDraftRequest(text, business)));
      if (parsed) return { context: parsed, source: "llm" };
    } catch (err) {
      console.error("campaign_context:draft_failed", campaignId, (err as Error).message);
    }
  }
  return { context: draftCampaignContext(text), source: "rules" };
}

async function businessFacts(admin: Admin, organizationId: string, businessId: string | null) {
  if (!businessId) return { name: null, services: [] };
  const [{ data: business }, { data: services }] = await Promise.all([
    admin.from("businesses").select("name, organization_id").eq("id", businessId).maybeSingle(),
    admin.from("services").select("name").eq("business_id", businessId),
  ]);
  if (!business || business.organization_id !== organizationId) return { name: null, services: [] };
  return {
    name: business.name as string | null,
    services: ((services ?? []) as { name: string | null }[])
      .map((s) => s.name ?? "")
      .filter(Boolean),
  };
}

/**
 * Validates and stores the customer-reviewed context, and the text compiled from
 * it, which is what the dispatcher sends. Only while the campaign is not running.
 */
export async function saveCampaignContextFor(
  admin: Admin,
  organizationId: string,
  campaignId: string,
  userId: string,
  input: { context: unknown; description?: string },
): Promise<{ compiled: CompiledContext }> {
  const campaign = await campaignRow(admin, organizationId, campaignId);
  if (!CONTEXT_EDITABLE_STATUSES.includes(campaign.status))
    throw new Error(
      `The campaign is ${campaign.status}; pause it before changing what the AI says.`,
    );
  const result = validateCampaignContext(input.context);
  if (!result.ok) throw new Error(`Please fix: ${result.errors.join("; ")}`);
  const compiled = compileCampaignContext(result.context);
  const update: Record<string, unknown> = {
    context: result.context,
    context_version: CAMPAIGN_CONTEXT_VERSION,
    context_reviewed_at: new Date().toISOString(),
    context_reviewed_by: userId,
    objective: compiled.objective,
    call_instructions: compiled.instructions,
  };
  if (typeof input.description === "string")
    update["description"] = input.description.slice(0, 4000);
  const { data, error } = await admin
    .from("campaigns")
    .update(update as never)
    .eq("id", campaignId)
    .eq("organization_id", organizationId)
    .in("status", CONTEXT_EDITABLE_STATUSES)
    .select("id");
  if (error) throw error;
  if (!data || data.length === 0)
    throw new Error("The campaign changed status; reload and try again.");
  return { compiled };
}

export interface EligibilityPreview {
  total: number;
  eligible: number;
  excluded: Partial<Record<ExclusionReason, number>>;
  /** Already dialled, finished or cancelled; not counted above. */
  alreadyHandled: number;
}

/** Who would be called if the campaign launched now, and who would not and why. Read-only. */
export async function campaignEligibilityFor(
  admin: Admin,
  organizationId: string,
  campaignId: string,
  isCountryAllowed: (e164: string) => boolean,
): Promise<EligibilityPreview> {
  await campaignRow(admin, organizationId, campaignId);
  const { data, error } = await admin
    .from("campaign_contacts")
    .select("status, contacts(phone, opted_out)")
    .eq("campaign_id", campaignId)
    .eq("organization_id", organizationId)
    .order("created_at");
  if (error) throw error;
  const rows = (data ?? []) as {
    status: string;
    contacts: { phone: string; opted_out: boolean } | null;
  }[];
  const due = rows.filter((r) => r.status === "pending" || r.status === "retry_scheduled");
  const verdicts = evaluateEligibility(
    due.map((r) => ({
      e164: r.contacts ? normalizeCustomerPhone(r.contacts.phone, null) : null,
      optedOut: r.contacts?.opted_out ?? true,
    })),
    isCountryAllowed,
  );
  const excluded: Partial<Record<ExclusionReason, number>> = {};
  for (const v of verdicts) if (!v.eligible) excluded[v.reason] = (excluded[v.reason] ?? 0) + 1;
  return {
    total: due.length,
    eligible: verdicts.filter((v) => v.eligible).length,
    excluded,
    alreadyHandled: rows.length - due.length,
  };
}
