import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { CAMPAIGN_CONTEXT_VERSION } from "./campaign-context.ts";
import { CAMPAIGN_IDEMPOTENCY_KEY_PATTERN } from "./campaign-create-key.ts";
import type { CampaignSchedule } from "./campaign-schedule.ts";
import {
  CONFIG_EDITABLE_STATUSES,
  campaignConfigRow,
  configEditBlockedReason,
  isEligibleCallerNumber,
  parseWizardState,
  validateWizardConfig,
} from "./campaign-wizard.ts";

/**
 * Saves a campaign's whole configuration from the wizard (create or edit) in
 * one write. The caller's organization is already authorized
 * (campaigns.functions.ts); this re-checks everything else server-side:
 *   - every value is validated with the wizard's own rules;
 *   - the agent and caller number must be this organization's own (the
 *     number also active and outbound-enabled);
 *   - an edit only changes draft, scheduled or paused campaigns, and never
 *     organization, status, launch timestamps or dispatch fields;
 *   - "confirm" decides whether the call instructions count as reviewed; a
 *     draft keeps them, unreviewed, so the campaign stays non-launchable.
 * Nothing here places a call or touches dispatch.
 */

type Admin = SupabaseClient<Database>;

export interface SaveCampaignConfigInput {
  campaignId?: string | undefined;
  wizard: unknown;
  confirm: boolean;
  /** Create only: the creation session's key. A repeat with the same key returns the first campaign. */
  idempotencyKey?: string | undefined;
  /**
   * Edit only (required): the campaign's updated_at when the editor loaded it. The save
   * applies only if nobody changed the campaign since; otherwise it is refused (conflict).
   */
  expectedUpdatedAt?: string | undefined;
}

export type SaveCampaignConfigResult = {
  campaignId: string;
  /** true only when this request inserted the campaign. */
  created: boolean;
  /** created: new row; existing: same creation key, the earlier campaign; updated: an edit. */
  outcome: "created" | "existing" | "updated";
  /** The campaign's version after this save: the next edit sends it as expectedUpdatedAt. */
  updatedAt: string;
};

/** Marks a stale edit, so the editor can tell it apart from other errors. */
export const CAMPAIGN_EDIT_CONFLICT_MESSAGE =
  "This campaign was changed elsewhere (another tab or person) after you opened it. Nothing was saved. Reload to see the latest version, then make your changes again.";

const KEY_INDEX = "idx_campaigns_org_idempotency_key";

/** A unique violation of the creation-key index, and nothing else. */
function isCreationKeyConflict(error: unknown): boolean {
  const e = error as { code?: string; message?: string; details?: string } | null;
  return e?.code === "23505" && `${e.message ?? ""} ${e.details ?? ""}`.includes(KEY_INDEX);
}

export async function saveCampaignConfigurationFor(
  admin: Admin,
  organizationId: string,
  userId: string,
  input: SaveCampaignConfigInput,
  now: Date = new Date(),
): Promise<SaveCampaignConfigResult> {
  const wizard = parseWizardState(input.wizard);
  if (!wizard) throw new Error("The campaign configuration is missing.");
  // Edits never use (or write) a creation key.
  const idempotencyKey = input.campaignId ? undefined : input.idempotencyKey;
  if (idempotencyKey !== undefined && !CAMPAIGN_IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey))
    throw new Error("This request has an invalid request id.");

  let savedSchedule: CampaignSchedule | null = null;
  if (input.campaignId && !input.expectedUpdatedAt)
    throw new Error("This edit has no campaign version. Reload the campaign and try again.");
  if (input.campaignId) {
    const { data: existing, error } = await admin
      .from("campaigns")
      .select("id, organization_id, status, schedule")
      .eq("id", input.campaignId)
      .maybeSingle();
    if (error) throw error;
    if (!existing || existing.organization_id !== organizationId)
      throw new Error("Campaign not found.");
    const blocked = configEditBlockedReason(existing.status);
    if (blocked) throw new Error(blocked);
    savedSchedule = (existing.schedule ?? null) as CampaignSchedule | null;
  }

  const checked = validateWizardConfig(wizard, { draft: !input.confirm, now, savedSchedule });
  if (checked.errors.length) throw new Error(`Please fix: ${checked.errors.join(" ")}`);
  if (!checked.context || !checked.compiled) throw new Error("The call instructions are invalid.");

  if (wizard.instructions.agentConfigId) {
    const { data: agent, error } = await admin
      .from("agent_configs")
      .select("id, organization_id")
      .eq("id", wizard.instructions.agentConfigId)
      .maybeSingle();
    if (error) throw error;
    if (!agent || agent.organization_id !== organizationId)
      throw new Error("That AI agent does not belong to this workspace.");
  }
  if (wizard.phoneNumberId) {
    const { data: number, error } = await admin
      .from("phone_numbers")
      .select("id, organization_id, status, outbound_enabled")
      .eq("id", wizard.phoneNumberId)
      .maybeSingle();
    if (error) throw error;
    if (!number || number.organization_id !== organizationId)
      throw new Error("That caller number does not belong to this workspace.");
    if (!isEligibleCallerNumber(number))
      throw new Error("That number is not enabled for outbound calls.");
  }

  const row: Record<string, unknown> = {
    ...campaignConfigRow(wizard),
    objective: checked.compiled.objective,
    call_instructions: checked.compiled.instructions,
    context: checked.context,
    context_version: CAMPAIGN_CONTEXT_VERSION,
    context_reviewed_at: input.confirm ? now.toISOString() : null,
    context_reviewed_by: input.confirm ? userId : null,
  };

  if (!input.campaignId) {
    const { data: business } = await admin
      .from("businesses")
      .select("id")
      .eq("organization_id", organizationId)
      .limit(1)
      .maybeSingle();
    const { data, error } = await admin
      .from("campaigns")
      .insert({
        ...row,
        organization_id: organizationId,
        business_id: business?.id ?? null,
        created_by: userId,
        ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
      } as never)
      .select("id, updated_at")
      .single();
    if (!error) {
      const created = data as { id: string; updated_at: string };
      return {
        campaignId: created.id,
        created: true,
        outcome: "created",
        updatedAt: created.updated_at,
      };
    }
    // The same creation already succeeded (a retry, a lost response, a resubmission, or a
    // concurrent twin that won the race): return that campaign, unchanged. Only this
    // organization's row with this key can match.
    if (!idempotencyKey || !isCreationKeyConflict(error)) throw error;
    const { data: earlier, error: lookupError } = await admin
      .from("campaigns")
      .select("id, updated_at")
      .eq("organization_id", organizationId)
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle();
    if (lookupError) throw lookupError;
    if (!earlier) throw error;
    const found = earlier as { id: string; updated_at: string };
    return {
      campaignId: found.id,
      created: false,
      outcome: "existing",
      updatedAt: found.updated_at,
    };
  }

  // Applies only to the version the editor loaded, and only from an editable status: a
  // save from another tab, a launch or a cancel that landed meanwhile wins, never silently
  // overwritten. (trg_campaigns_updated moves updated_at on every change.)
  const { data: updated, error } = await admin
    .from("campaigns")
    .update(row as never)
    .eq("id", input.campaignId)
    .eq("organization_id", organizationId)
    .eq("updated_at", input.expectedUpdatedAt!)
    .in("status", [...CONFIG_EDITABLE_STATUSES])
    .select("id, updated_at");
  if (error) throw error;
  if (updated?.length)
    return {
      campaignId: input.campaignId,
      created: false,
      outcome: "updated",
      updatedAt: (updated[0] as { updated_at: string }).updated_at,
    };
  // Nothing matched: say why (status first, then a newer version).
  const { data: now2, error: rereadError } = await admin
    .from("campaigns")
    .select("status, updated_at")
    .eq("id", input.campaignId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (rereadError) throw rereadError;
  if (!now2) throw new Error("Campaign not found.");
  const blocked = configEditBlockedReason(now2.status);
  if (blocked) throw new Error(blocked);
  throw new Error(CAMPAIGN_EDIT_CONFLICT_MESSAGE);
}
