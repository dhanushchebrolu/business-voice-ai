import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * Campaign lifecycle transitions (spec §24/§36/§37/§38). Creating or editing a
 * campaign's configuration goes through saveCampaignConfiguration below
 * (organization, agent and caller number checked server-side); it never sets
 * `status`. Every actual
 * status transition goes through one of the functions below instead, so the
 * full authorization/readiness/billing chain from spec §24 step "When
 * clicked" always re-runs server-side, exactly like handoverClient's
 * provisioning-readiness gate for going ACTIVE.
 *
 * Launching does not itself place any call — it only proves the campaign is
 * dialable and flips status to "running". campaign-dispatch.server.ts (run
 * by the cron-authenticated dispatch route) is the only thing that ever
 * calls out to Sarvam, one contact at a time, respecting the campaign's own
 * calling window/retry rules.
 */

/** The campaign's own organization, once the caller may act on it (dial: owner or admin). */
async function campaignOrgId(
  context: { supabase: unknown; userId: string },
  campaignId: string,
  dial: boolean,
): Promise<string> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { campaignOrganizationForCaller } = await import("@/lib/outbound-authorization.server");
  return campaignOrganizationForCaller(
    { supabase: context.supabase as typeof supabaseAdmin, supabaseAdmin },
    context.userId,
    campaignId,
    { dial },
  );
}

interface SaveCampaignConfigurationInput {
  /** New campaign: the workspace to create it in. Edit: omit, the campaign's own is used. */
  organizationId?: string;
  campaignId?: string;
  wizard: unknown;
  /** true: the call instructions are confirmed (reviewed); false: kept as an unreviewed draft. */
  confirm: boolean;
  /** Create only: the creation session's key, so a repeat returns the first campaign. */
  idempotencyKey?: string;
  /** Edit only: the campaign version the editor loaded (optimistic concurrency). */
  expectedUpdatedAt?: string;
}

/**
 * Creates or edits a campaign's configuration (campaign-config.server.ts).
 * The organization is the campaign's own (edit) or one the caller is an owner
 * or admin of (create) — never trusted from the request alone. Places no call.
 */
export const saveCampaignConfiguration = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: SaveCampaignConfigurationInput) => {
    if (!input?.campaignId && !input?.organizationId)
      throw new Error("organizationId or campaignId is required");
    if (typeof input.confirm !== "boolean") throw new Error("confirm is required");
    return input;
  })
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { requireRole } = await import("@/lib/outbound-authorization.server");
    const orgId = data.campaignId
      ? await campaignOrgId(context, data.campaignId, true)
      : await requireRole(
          { supabase: context.supabase as typeof supabaseAdmin, supabaseAdmin },
          context.userId,
          data.organizationId!,
          true,
          "Workspace not found.",
        );
    const { saveCampaignConfigurationFor } = await import("@/lib/campaign-config.server");
    return saveCampaignConfigurationFor(supabaseAdmin, orgId, context.userId, {
      campaignId: data.campaignId,
      wizard: data.wizard,
      confirm: data.confirm,
      idempotencyKey: data.idempotencyKey,
      expectedUpdatedAt: data.expectedUpdatedAt,
    });
  });

interface LaunchCampaignInput {
  campaignId: string;
}

/** Every launch condition for the campaign page's checklist (read-only; any workspace member). */
export const getCampaignLaunchReadiness = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: LaunchCampaignInput) => {
    if (!input?.campaignId) throw new Error("campaignId is required");
    return input;
  })
  .handler(async ({ data, context }) => {
    const orgId = await campaignOrgId(context, data.campaignId, false);
    const { defaultReadinessDeps, evaluateCampaignLaunchReadiness } =
      await import("@/lib/campaign-launch-readiness.server");
    const readiness = await evaluateCampaignLaunchReadiness(
      await defaultReadinessDeps("view"),
      orgId,
      data.campaignId,
    );
    if (!readiness) throw new Error("Campaign not found.");
    return readiness;
  });

/**
 * Starts (or resumes) a campaign: every check in campaign-launch-readiness.server.ts
 * runs server-side; any failure returns them all and changes nothing. Launching
 * places no call itself, it only lets the dispatcher pick the campaign up.
 * Idempotent: a campaign that is already running answers ok.
 */
export const launchCampaign = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: LaunchCampaignInput) => {
    if (!input?.campaignId) throw new Error("campaignId is required");
    return input;
  })
  .handler(async ({ data, context }) => {
    const orgId = await campaignOrgId(context, data.campaignId, true);
    const { launchCampaignFor } = await import("@/lib/campaign-launch.server");
    const { defaultReadinessDeps } = await import("@/lib/campaign-launch-readiness.server");
    return launchCampaignFor(
      await defaultReadinessDeps("launch"),
      orgId,
      context.userId,
      data.campaignId,
    );
  });

interface CampaignActionInput {
  campaignId: string;
}

function simpleTransition(
  fromStatuses: string[],
  toStatus: string,
  timestampColumn: string | null,
  dial: boolean,
) {
  return createServerFn({ method: "POST" })
    .middleware([requireSupabaseAuth])
    .inputValidator((input: CampaignActionInput) => {
      if (!input?.campaignId) throw new Error("campaignId is required");
      return input;
    })
    .handler(async ({ data, context }) => {
      const orgId = await campaignOrgId(context, data.campaignId, dial);
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { data: campaign } = await supabaseAdmin
        .from("campaigns")
        .select("id, organization_id, status")
        .eq("id", data.campaignId)
        .maybeSingle();
      if (!campaign || campaign.organization_id !== orgId) throw new Error("Campaign not found.");
      if (!fromStatuses.includes(campaign.status))
        throw new Error(`Campaign is ${campaign.status}, not ${fromStatuses.join(" or ")}.`);

      const patch: Record<string, unknown> = { status: toStatus };
      if (timestampColumn) patch[timestampColumn] = new Date().toISOString();
      // Only from the allowed statuses: a cancel that landed meanwhile is never undone.
      const { data: moved, error } = await supabaseAdmin
        .from("campaigns")
        .update(patch as never)
        .eq("id", data.campaignId)
        .in("status", fromStatuses)
        .select("id");
      if (error) throw error;
      if (!moved?.length) throw new Error("The campaign changed status; reload and try again.");
      return { ok: true };
    });
}

/** Pause: stops the dispatcher from claiming any more due contacts for this campaign. In-flight calls finish normally. */
export const pauseCampaign = simpleTransition(["running"], "paused", "paused_at", false);

/** Resume: identical readiness bar as launch is deliberately NOT re-run here — spec §38 only requires pause->edit->resume for fields that need it; resuming without editing should not re-block on transient billing dips the dispatcher itself already re-checks per call. */
/** Resuming re-runs every launch check (kill switch, emergency stop, number, agent, context, wallet, contacts). */
export const resumeCampaign = launchCampaign;

export const cancelCampaign = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: CampaignActionInput) => {
    if (!input?.campaignId) throw new Error("campaignId is required");
    return input;
  })
  .handler(async ({ data, context }) => {
    const orgId = await campaignOrgId(context, data.campaignId, false);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: campaign } = await supabaseAdmin
      .from("campaigns")
      .select("id, organization_id, status")
      .eq("id", data.campaignId)
      .maybeSingle();
    if (!campaign || campaign.organization_id !== orgId) throw new Error("Campaign not found.");
    if (["completed", "cancelled"].includes(campaign.status))
      throw new Error(`Campaign is already ${campaign.status}.`);

    const { data: cancelled, error: cancelError } = await supabaseAdmin
      .from("campaigns")
      .update({ status: "cancelled", cancelled_at: new Date().toISOString() })
      .eq("id", data.campaignId)
      .not("status", "in", "(completed,cancelled)")
      .select("id");
    if (cancelError) throw cancelError;
    if (!cancelled?.length) throw new Error("The campaign changed status; reload and try again.");
    // Never dial a not-yet-attempted contact from a cancelled campaign.
    await supabaseAdmin
      .from("campaign_contacts")
      .update({ status: "cancelled", next_attempt_at: null })
      .eq("campaign_id", data.campaignId)
      .in("status", ["pending", "retry_scheduled", "queued"]);

    return { ok: true };
  });

/** Sets or removes the campaign budget (paise). Not while running: pause first. */
export const setCampaignBudget = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { campaignId: string; budgetLimit: number | null }) => {
    if (!input?.campaignId) throw new Error("campaignId is required");
    const b = input.budgetLimit;
    if (b !== null && !(Number.isInteger(b) && b > 0))
      throw new Error("The budget must be a whole number of paise above zero, or empty.");
    return input;
  })
  .handler(async ({ data, context }) => {
    const orgId = await campaignOrgId(context, data.campaignId, true);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: updated, error } = await supabaseAdmin
      .from("campaigns")
      .update({ budget_limit: data.budgetLimit })
      .eq("id", data.campaignId)
      .eq("organization_id", orgId)
      .in("status", ["draft", "scheduled", "paused"])
      .select("id");
    if (error) throw error;
    if (!updated?.length) throw new Error("Pause the campaign before changing its budget.");
    return { ok: true };
  });

export interface CampaignStats {
  totalContacts: number;
  byStatus: Record<string, number>;
  report: import("@/lib/campaign-results").CampaignReport;
  /** Paise: what billed calls cost, and the worst case still reserved by open calls. */
  spent: number;
  reserved: number;
  budgetLimit: number | null;
  /** Bookings made on campaign calls are not reported here as campaign conversions. */
  bookingCapable: false;
}

export const getCampaignStats = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { campaignId: string }) => {
    if (!input?.campaignId) throw new Error("campaignId is required");
    return input;
  })
  .handler(async ({ data, context }): Promise<CampaignStats> => {
    const orgId = await campaignOrgId(context, data.campaignId, false);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: campaign } = await supabaseAdmin
      .from("campaigns")
      .select("id, organization_id, budget_limit")
      .eq("id", data.campaignId)
      .maybeSingle();
    if (!campaign || campaign.organization_id !== orgId) throw new Error("Campaign not found.");

    const [{ data: rows }, { data: calls }] = await Promise.all([
      supabaseAdmin
        .from("campaign_contacts")
        .select("status, attempts, excluded_reason, output_variables")
        .eq("campaign_id", data.campaignId)
        .eq("organization_id", orgId),
      supabaseAdmin
        .from("call_logs")
        .select(
          "status, customer_charge, billing_applied_at, billing_cap_minutes, billing_rate_per_minute, resolution_source",
        )
        .eq("campaign_id", data.campaignId)
        .eq("organization_id", orgId),
    ]);

    const byStatus: Record<string, number> = {};
    for (const row of rows ?? []) {
      byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
    }
    const { buildCampaignReport } = await import("@/lib/campaign-results");
    const { campaignSpend } = await import("@/lib/campaign-results");
    const spend = campaignSpend(calls ?? []);
    return {
      totalContacts: rows?.length ?? 0,
      byStatus,
      report: buildCampaignReport(rows ?? []),
      spent: spend.spent,
      reserved: spend.reserved,
      budgetLimit: campaign.budget_limit ?? null,
      bookingCapable: false,
    };
  });
