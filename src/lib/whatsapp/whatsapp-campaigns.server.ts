/**
 * WhatsApp Message Templates (synced from Meta) and template campaigns.
 *
 * Templates: synced read-only from the number's WABA. Meta decides status
 * and category; a template is only ever used while APPROVED.
 *
 * Campaigns (policy, enforced here, not by the UI):
 *   - MARKETING-category, APPROVED templates only — checked at launch and
 *     again before every send (a paused/rejected template pauses the
 *     campaign).
 *   - Recipients need an explicit marketing opt-in as their latest
 *     marketing consent, and must not be suppressed — checked when the
 *     campaign launches AND again right before each message. Ineligible
 *     numbers are recorded as 'skipped' with the reason (auditable), never
 *     messaged.
 *   - Rate-limited per campaign (max_per_minute, ≤ 80), sent only inside
 *     the campaign's schedule window, bounded per cron tick.
 *   - One message per (campaign, number): the recipient row is unique, it
 *     is claimed before sending, and the message carries the idempotency
 *     key campaign:<id>:<wa_id>.
 *   - Failures retried only when Meta didn't accept the message (429/5xx),
 *     at most MAX_RECIPIENT_ATTEMPTS times; a tick with a high failure rate
 *     pauses the campaign for a person to look at.
 *   - Every launch, pause, resume and cancel is written to the audit log.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { MetaWhatsAppClient } from "./meta-client.server.ts";
import { resolveMetaWhatsAppConfig } from "./meta-config.server.ts";
import { decryptCredential } from "./whatsapp-token-crypto.server.ts";
import type { DeliveryDeps } from "./whatsapp-outbound.server.ts";
import {
  countBodyParams,
  sendBusinessWhatsAppMessage,
} from "./whatsapp-business-message.server.ts";
import {
  latestConsent,
  latestConsentForBusiness,
  suppressedWaIds,
  toWaId,
  writeAuditLog,
} from "./whatsapp-consent.server.ts";
import {
  isValidTimeZone,
  isWithinCallingWindow,
  type CampaignSchedule,
} from "../campaign-schedule.ts";

type Client = SupabaseClient<Database>;
type CampaignRow = Database["public"]["Tables"]["whatsapp_campaigns"]["Row"];
type RecipientRow = Database["public"]["Tables"]["whatsapp_campaign_recipients"]["Row"];

export const MAX_RECIPIENTS = 10_000;
const ANALYTICS_PAGE_SIZE = 1000;
export const MAX_RECIPIENT_ATTEMPTS = 3;
export const MAX_SENDS_PER_TICK = 80;
export const RECIPIENT_CLAIM_TIMEOUT_MS = 5 * 60_000;
/** Campaigns dispatched per cron tick, and at most this many from one organization. */
export const MAX_CAMPAIGNS_PER_TICK = 20;
export const MAX_CAMPAIGNS_PER_ORG_PER_TICK = 5;
const PAUSE_MIN_FAILURES = 10;
const PAUSE_FAILURE_RATE = 0.5;

export class CampaignError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Templates

// One definition, shared with the sender's own template verification.
export { countBodyParams };

export async function syncTemplates(
  supabaseAdmin: Client,
  input: { organizationId: string; connectionId: string },
  deps: { fetchImpl?: typeof fetch | undefined } = {},
): Promise<{ synced: number; missing: number }> {
  const { data: connection, error } = await supabaseAdmin
    .from("whatsapp_connections")
    .select("id, organization_id, waba_id, status, access_token_ciphertext")
    .eq("id", input.connectionId)
    .eq("organization_id", input.organizationId)
    .maybeSingle();
  if (error) throw error;
  if (!connection || connection.status !== "connected" || !connection.access_token_ciphertext) {
    throw new CampaignError("This WhatsApp number isn't connected.", "NOT_CONNECTED");
  }
  const config = resolveMetaWhatsAppConfig();
  if (!config)
    throw new CampaignError("WhatsApp is not configured on this deployment.", "NOT_CONFIGURED");
  const client = new MetaWhatsAppClient({
    appId: config.appId,
    appSecret: config.appSecret,
    graphApiVersion: config.graphApiVersion,
    fetchImpl: deps.fetchImpl,
  });
  const templates = await client.listMessageTemplates(
    connection.waba_id,
    decryptCredential(connection.access_token_ciphertext),
  );

  const now = new Date().toISOString();
  const seen = new Set<string>();
  for (const t of templates) {
    seen.add(`${t.name}|${t.language}`);
    const params = countBodyParams(t.bodyText);
    const { error: upsertError } = await supabaseAdmin.from("whatsapp_templates").upsert(
      {
        organization_id: input.organizationId,
        whatsapp_connection_id: connection.id,
        meta_template_id: t.id,
        name: t.name,
        language: t.language,
        status: t.status,
        category: t.category,
        body_text: t.bodyText,
        body_param_count: params.count,
        synced_at: now,
      },
      { onConflict: "whatsapp_connection_id,name,language" },
    );
    if (upsertError) throw upsertError;
  }
  // Templates deleted at Meta: never usable again, but kept for history.
  const { data: existing, error: existingError } = await supabaseAdmin
    .from("whatsapp_templates")
    .select("id, name, language")
    .eq("whatsapp_connection_id", connection.id);
  if (existingError) throw existingError;
  let missing = 0;
  for (const row of existing ?? []) {
    if (seen.has(`${row.name}|${row.language}`)) continue;
    missing++;
    await supabaseAdmin
      .from("whatsapp_templates")
      .update({ status: "NOT_FOUND_AT_META", synced_at: now })
      .eq("id", row.id);
  }
  return { synced: templates.length, missing };
}

/** How many body parameters each notification purpose sends (see bookingNotificationText / payment messages). */
export const PURPOSE_PARAM_COUNT: Record<string, number> = {
  booking_confirmed: 3,
  booking_rescheduled: 3,
  booking_cancelled: 3,
  booking_reminder: 3,
  payment_link: 1,
  payment_confirmation: 1,
  payment_failed: 1,
  payment_expired: 1,
};

/** Why a template can't serve a notification purpose, or null if it can. */
export function templatePurposeProblem(
  template: {
    status: string;
    category: string;
    body_text: string | null;
    body_param_count: number;
  },
  purpose: string,
): string | null {
  const expected = PURPOSE_PARAM_COUNT[purpose];
  if (expected === undefined) return "Unknown purpose.";
  if (template.status !== "APPROVED") return "Only an APPROVED template can be used.";
  if (template.category !== "UTILITY") {
    return "Booking and payment notifications need a UTILITY-category template.";
  }
  if (countBodyParams(template.body_text).named) {
    return "Templates with named parameters aren't supported; use {{1}}, {{2}}… .";
  }
  if (template.body_param_count !== expected) {
    return `This purpose sends ${expected} body parameter(s); the template has ${template.body_param_count}.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Campaign parameters

export type TemplateParamSpec =
  | { source: "static"; value: string }
  | { source: "contact_first_name"; fallback: string }
  | { source: "business_name" };

export function parseParamSpecs(raw: unknown): TemplateParamSpec[] {
  if (!Array.isArray(raw))
    throw new CampaignError("Template parameters must be a list.", "INVALID_INPUT");
  return raw.map((p) => {
    const spec = (p ?? {}) as Record<string, unknown>;
    if (spec["source"] === "static" && typeof spec["value"] === "string" && spec["value"].trim()) {
      if (spec["value"].length > 500) {
        throw new CampaignError(
          "A parameter value is too long (500 characters max).",
          "INVALID_INPUT",
        );
      }
      return { source: "static", value: spec["value"] };
    }
    if (spec["source"] === "contact_first_name") {
      const fallback =
        typeof spec["fallback"] === "string" && spec["fallback"].trim()
          ? spec["fallback"]
          : "there";
      return { source: "contact_first_name", fallback: fallback.slice(0, 40) };
    }
    if (spec["source"] === "business_name") return { source: "business_name" };
    throw new CampaignError("Unknown template parameter.", "INVALID_INPUT");
  });
}

export function resolveParams(
  specs: TemplateParamSpec[],
  values: { contactName: string | null; businessName: string },
): string[] {
  return specs.map((spec) => {
    switch (spec.source) {
      case "static":
        return spec.value;
      case "business_name":
        return values.businessName.slice(0, 60);
      case "contact_first_name": {
        const first = (values.contactName ?? "").trim().split(/\s+/)[0];
        return first ? first.slice(0, 40) : spec.fallback;
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Launch: materialize the audience

async function loadCampaign(
  supabaseAdmin: Client,
  organizationId: string,
  campaignId: string,
): Promise<CampaignRow> {
  const { data, error } = await supabaseAdmin
    .from("whatsapp_campaigns")
    .select("*")
    .eq("id", campaignId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new CampaignError("Campaign not found.", "NOT_FOUND");
  return data;
}

async function loadTemplate(supabaseAdmin: Client, campaign: CampaignRow) {
  const { data, error } = await supabaseAdmin
    .from("whatsapp_templates")
    .select("id, name, language, status, category, body_param_count, body_text")
    .eq("id", campaign.template_id)
    .eq("whatsapp_connection_id", campaign.whatsapp_connection_id)
    .eq("organization_id", campaign.organization_id)
    .maybeSingle();
  if (error) throw error;
  return data;
}

function campaignTemplateProblem(
  template: Awaited<ReturnType<typeof loadTemplate>>,
  paramCount: number,
): string | null {
  if (!template) return "The campaign's template no longer exists.";
  if (template.status !== "APPROVED") return `The template is ${template.status}, not APPROVED.`;
  if (template.category !== "MARKETING") return "Campaigns must use a MARKETING-category template.";
  if (countBodyParams(template.body_text).named)
    return "Templates with named parameters aren't supported.";
  if (template.body_param_count !== paramCount) {
    return `The template has ${template.body_param_count} body parameter(s); the campaign supplies ${paramCount}.`;
  }
  return null;
}

/** The audience's numbers, before consent filtering. */
async function audienceNumbers(
  supabaseAdmin: Client,
  campaign: CampaignRow,
  country: string | null,
): Promise<{ waId: string; contactId: string | null }[]> {
  const audience = (campaign.audience ?? {}) as { type?: string; contactIds?: unknown };
  if (audience.type === "contacts") {
    const ids = Array.isArray(audience.contactIds)
      ? audience.contactIds
          .filter((v): v is string => typeof v === "string")
          .slice(0, MAX_RECIPIENTS)
      : [];
    const out: { waId: string; contactId: string | null }[] = [];
    for (let i = 0; i < ids.length; i += 200) {
      const { data, error } = await supabaseAdmin
        .from("contacts")
        .select("id, phone")
        .eq("organization_id", campaign.organization_id)
        .in("id", ids.slice(i, i + 200));
      if (error) throw error;
      for (const c of data ?? []) {
        const waId = toWaId(c.phone, country);
        if (waId) out.push({ waId, contactId: c.id });
      }
    }
    return out;
  }
  // "all_consented": everyone whose latest marketing consent is an opt-in —
  // every consent row is read (paged), so an older opt-in can never hide a
  // newer opt-out, and a same-instant opt-in/opt-out counts as an opt-out.
  const latest = await latestConsentForBusiness(supabaseAdmin, campaign.business_id, "marketing");
  return [...latest.entries()]
    .filter(([, v]) => v.action === "opt_in")
    .slice(0, MAX_RECIPIENTS)
    .map(([waId, v]) => ({ waId, contactId: v.contactId }));
}

export async function launchCampaign(
  supabaseAdmin: Client,
  input: { organizationId: string; campaignId: string; actorUserId: string; now?: Date },
): Promise<{ eligible: number; skipped: number; status: string }> {
  const now = input.now ?? new Date();
  const campaign = await loadCampaign(supabaseAdmin, input.organizationId, input.campaignId);
  if (campaign.status !== "draft") {
    throw new CampaignError(
      `Only a draft campaign can be launched (this one is ${campaign.status}).`,
      "INVALID_STATE",
    );
  }
  const specs = parseParamSpecs(campaign.template_params);
  const problem = campaignTemplateProblem(
    await loadTemplate(supabaseAdmin, campaign),
    specs.length,
  );
  if (problem) throw new CampaignError(problem, "TEMPLATE_NOT_USABLE");

  const { data: business, error: businessError } = await supabaseAdmin
    .from("businesses")
    .select("country")
    .eq("id", campaign.business_id)
    .eq("organization_id", campaign.organization_id)
    .maybeSingle();
  if (businessError) throw businessError;

  const numbers = await audienceNumbers(supabaseAdmin, campaign, business?.country ?? null);
  const unique = [...new Map(numbers.map((n) => [n.waId, n])).values()];
  const waIds = unique.map((n) => n.waId);
  const consent = await latestConsent(supabaseAdmin, campaign.business_id, "marketing", waIds);
  const suppressed = await suppressedWaIds(supabaseAdmin, campaign.business_id, waIds);

  let eligible = 0;
  let skipped = 0;
  const rows = unique.map((n) => {
    const reason = suppressed.has(n.waId)
      ? "suppressed"
      : consent.get(n.waId) === "opt_out"
        ? "opted_out"
        : consent.get(n.waId) !== "opt_in"
          ? "no_consent"
          : null;
    if (reason) skipped++;
    else eligible++;
    return {
      organization_id: campaign.organization_id,
      campaign_id: campaign.id,
      contact_id: n.contactId,
      wa_id: n.waId,
      status: reason ? "skipped" : "pending",
      skip_reason: reason,
    };
  });
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await supabaseAdmin
      .from("whatsapp_campaign_recipients")
      .upsert(rows.slice(i, i + 500), { onConflict: "campaign_id,wa_id", ignoreDuplicates: true });
    if (error) throw error;
  }

  const status =
    campaign.scheduled_at && new Date(campaign.scheduled_at) > now ? "scheduled" : "running";
  const { data: updated, error: updateError } = await supabaseAdmin
    .from("whatsapp_campaigns")
    .update({ status, launched_at: now.toISOString() })
    .eq("id", campaign.id)
    .eq("organization_id", campaign.organization_id)
    .eq("status", "draft")
    .select("id");
  if (updateError) throw updateError;
  if (!updated || updated.length === 0) {
    throw new CampaignError(
      "The campaign changed while launching; reload and try again.",
      "CONFLICT",
    );
  }
  await writeAuditLog(supabaseAdmin, {
    organizationId: campaign.organization_id,
    businessId: campaign.business_id,
    actorType: "user",
    actorUserId: input.actorUserId,
    action: "campaign.launch",
    subjectType: "whatsapp_campaign",
    subjectId: campaign.id,
    details: { eligible, skipped, status },
  });
  return { eligible, skipped, status };
}

const TRANSITIONS: Record<string, { from: string[]; to: string }> = {
  pause: { from: ["running", "scheduled"], to: "paused" },
  resume: { from: ["paused"], to: "running" },
  cancel: { from: ["draft", "scheduled", "running", "paused"], to: "cancelled" },
};

export async function changeCampaignStatus(
  supabaseAdmin: Client,
  input: {
    organizationId: string;
    campaignId: string;
    action: "pause" | "resume" | "cancel";
    actorUserId: string;
  },
): Promise<{ status: string }> {
  const t = TRANSITIONS[input.action]!;
  const campaign = await loadCampaign(supabaseAdmin, input.organizationId, input.campaignId);
  if (!t.from.includes(campaign.status)) {
    throw new CampaignError(
      `A ${campaign.status} campaign can't be ${input.action}d.`,
      "INVALID_STATE",
    );
  }
  if (input.action === "resume") {
    const problem = campaignTemplateProblem(
      await loadTemplate(supabaseAdmin, campaign),
      parseParamSpecs(campaign.template_params).length,
    );
    if (problem) throw new CampaignError(problem, "TEMPLATE_NOT_USABLE");
  }
  const { data, error } = await supabaseAdmin
    .from("whatsapp_campaigns")
    .update({
      status: t.to,
      paused_reason: t.to === "paused" ? "Paused by staff." : null,
      ...(t.to === "cancelled" ? { completed_at: new Date().toISOString() } : {}),
    })
    .eq("id", campaign.id)
    .eq("organization_id", input.organizationId)
    .eq("status", campaign.status)
    .select("id");
  if (error) throw error;
  if (!data || data.length === 0) {
    throw new CampaignError("The campaign changed meanwhile; reload and try again.", "CONFLICT");
  }
  if (t.to === "cancelled") {
    await supabaseAdmin
      .from("whatsapp_campaign_recipients")
      .update({ status: "skipped", skip_reason: "campaign_cancelled" })
      .eq("campaign_id", campaign.id)
      .eq("status", "pending");
  }
  await writeAuditLog(supabaseAdmin, {
    organizationId: input.organizationId,
    businessId: campaign.business_id,
    actorType: "user",
    actorUserId: input.actorUserId,
    action: `campaign.${input.action}`,
    subjectType: "whatsapp_campaign",
    subjectId: campaign.id,
  });
  return { status: t.to };
}

// ---------------------------------------------------------------------------
// Dispatch (cron)

async function pauseCampaign(supabaseAdmin: Client, campaign: CampaignRow, reason: string) {
  await supabaseAdmin
    .from("whatsapp_campaigns")
    .update({ status: "paused", paused_reason: reason })
    .eq("id", campaign.id)
    .eq("status", "running");
  await writeAuditLog(supabaseAdmin, {
    organizationId: campaign.organization_id,
    businessId: campaign.business_id,
    actorType: "system",
    action: "campaign.auto_pause",
    subjectType: "whatsapp_campaign",
    subjectId: campaign.id,
    details: { reason },
  });
}

/** Same two-step claim as the notification worker (no or() on an UPDATE: PostgREST rejects it). */
async function claimRecipient(
  supabaseAdmin: Client,
  row: RecipientRow,
  now: Date,
): Promise<boolean> {
  const staleCutoff = new Date(now.getTime() - RECIPIENT_CLAIM_TIMEOUT_MS).toISOString();
  const update = { status: "sending", locked_at: now.toISOString(), attempts: row.attempts + 1 };
  const fresh = await supabaseAdmin
    .from("whatsapp_campaign_recipients")
    .update(update)
    .eq("id", row.id)
    .eq("attempts", row.attempts)
    .eq("status", "pending")
    .select("id");
  if (fresh.error) throw fresh.error;
  if (fresh.data && fresh.data.length > 0) return true;
  const stale = await supabaseAdmin
    .from("whatsapp_campaign_recipients")
    .update(update)
    .eq("id", row.id)
    .eq("attempts", row.attempts)
    .eq("status", "sending")
    .lt("locked_at", staleCutoff)
    .select("id");
  if (stale.error) throw stale.error;
  return Boolean(stale.data && stale.data.length > 0);
}

export interface CampaignTickSummary {
  campaignId: string;
  sent: number;
  skipped: number;
  failed: number;
  retried: number;
  status: string;
}

async function dispatchCampaign(
  supabaseAdmin: Client,
  campaign: CampaignRow,
  deps: DeliveryDeps,
  now: Date,
): Promise<CampaignTickSummary> {
  const summary: CampaignTickSummary = {
    campaignId: campaign.id,
    sent: 0,
    skipped: 0,
    failed: 0,
    retried: 0,
    status: campaign.status,
  };
  // Nothing left to send: completed, whatever the send window says.
  const completeIfDone = async () => {
    const { count: remaining, error: remainingError } = await supabaseAdmin
      .from("whatsapp_campaign_recipients")
      .select("id", { count: "exact", head: true })
      .eq("campaign_id", campaign.id)
      .in("status", ["pending", "sending"]);
    if (remainingError) throw remainingError;
    if ((remaining ?? 0) === 0) {
      await supabaseAdmin
        .from("whatsapp_campaigns")
        .update({ status: "completed", completed_at: now.toISOString() })
        .eq("id", campaign.id)
        .eq("status", "running");
      summary.status = "completed";
    }
    return summary;
  };
  const specs = parseParamSpecs(campaign.template_params);
  const template = await loadTemplate(supabaseAdmin, campaign);
  const problem = campaignTemplateProblem(template, specs.length);
  if (problem) {
    await pauseCampaign(supabaseAdmin, campaign, problem);
    summary.status = "paused";
    return summary;
  }
  const schedule = (campaign.schedule ?? {}) as CampaignSchedule;
  if (schedule.timezone && !isValidTimeZone(schedule.timezone)) {
    // The window could never open: say so instead of holding a dispatch slot forever.
    await pauseCampaign(
      supabaseAdmin,
      campaign,
      `Paused: "${schedule.timezone}" isn't a valid time zone. Fix the schedule and resume.`,
    );
    summary.status = "paused";
    return summary;
  }
  if (!isWithinCallingWindow(schedule, now)) return completeIfDone();

  const { count: sentLastMinute, error: countError } = await supabaseAdmin
    .from("whatsapp_campaign_recipients")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", campaign.id)
    .gte("sent_at", new Date(now.getTime() - 60_000).toISOString());
  if (countError) throw countError;
  const budget = Math.min(MAX_SENDS_PER_TICK, campaign.max_per_minute - (sentLastMinute ?? 0));

  const { data: business, error: businessError } = await supabaseAdmin
    .from("businesses")
    .select("name")
    .eq("id", campaign.business_id)
    .eq("organization_id", campaign.organization_id)
    .maybeSingle();
  if (businessError) throw businessError;

  if (budget > 0) {
    const { data: due, error } = await supabaseAdmin
      .from("whatsapp_campaign_recipients")
      .select("*")
      .eq("campaign_id", campaign.id)
      .in("status", ["pending", "sending"])
      .lte("next_attempt_at", now.toISOString())
      .order("next_attempt_at", { ascending: true })
      .limit(budget);
    if (error) throw error;

    for (const row of due ?? []) {
      // Staff can pause or cancel while a batch is running: the campaign is
      // re-read before every send, so at most the message already in
      // flight goes out after they do.
      const { data: live, error: liveError } = await supabaseAdmin
        .from("whatsapp_campaigns")
        .select("status")
        .eq("id", campaign.id)
        .eq("organization_id", campaign.organization_id)
        .maybeSingle();
      if (liveError) throw liveError;
      if (live?.status !== "running") {
        summary.status = live?.status ?? summary.status;
        return summary;
      }
      if (!(await claimRecipient(supabaseAdmin, row, now))) continue;
      const attempts = row.attempts + 1;
      const finish = async (
        update: Database["public"]["Tables"]["whatsapp_campaign_recipients"]["Update"],
      ) => {
        await supabaseAdmin
          .from("whatsapp_campaign_recipients")
          .update({ locked_at: null, ...update })
          .eq("id", row.id)
          .eq("status", "sending");
      };
      // Consent can change after launch (a STOP since): the sender re-checks
      // consent and suppression right before sending.
      let contactName: string | null = null;
      if (row.contact_id) {
        const { data: contact } = await supabaseAdmin
          .from("contacts")
          .select("name")
          .eq("id", row.contact_id)
          .eq("organization_id", campaign.organization_id)
          .maybeSingle();
        contactName = contact?.name ?? null;
      }
      const params = resolveParams(specs, { contactName, businessName: business?.name ?? "" });
      const result = await sendBusinessWhatsAppMessage(
        supabaseAdmin,
        {
          organizationId: campaign.organization_id,
          businessId: campaign.business_id,
          customerPhone: `+${row.wa_id}`,
          purpose: "marketing",
          scope: "marketing",
          idempotencyKey: `campaign:${campaign.id}:${row.wa_id}`,
          bodyText: `[${template!.name}] ${params.join(" | ")}`.slice(0, 1000),
          templateBodyParams: params,
          // The campaign's own number and template: the sender re-verifies
          // both (same organization and business, APPROVED, MARKETING).
          connectionId: campaign.whatsapp_connection_id,
          templateId: campaign.template_id,
          forceTemplate: true,
          metadata: { campaign_id: campaign.id, campaign_recipient_id: row.id },
        },
        deps,
      );
      switch (result.outcome) {
        case "sent":
          await finish({
            status: "sent",
            sent_at: now.toISOString(),
            whatsapp_message_id: result.messageRowId,
            error: null,
          });
          summary.sent++;
          break;
        case "skipped":
          await finish({ status: "skipped", skip_reason: result.reason });
          summary.skipped++;
          break;
        case "skipped_duplicate":
          if (result.existingStatus && result.existingStatus !== "queued") {
            await finish({ status: "sent", sent_at: now.toISOString() });
            summary.sent++;
          } else if (attempts >= MAX_RECIPIENT_ATTEMPTS) {
            // An earlier send is still unconfirmed ('queued'): it may have
            // reached the customer, so it is never sent again — and the
            // campaign can't wait for it forever.
            await finish({
              status: "failed",
              error: "Delivery unknown: an earlier send was never confirmed by WhatsApp.",
            });
            summary.failed++;
          } else {
            await finish({
              status: "pending",
              next_attempt_at: new Date(now.getTime() + RECIPIENT_CLAIM_TIMEOUT_MS).toISOString(),
            });
            summary.retried++;
          }
          break;
        case "failed":
          if (result.retryable && attempts < MAX_RECIPIENT_ATTEMPTS) {
            await finish({
              status: "pending",
              error: result.error.slice(0, 500),
              next_attempt_at: new Date(now.getTime() + 2 ** attempts * 60_000).toISOString(),
            });
            summary.retried++;
          } else {
            await finish({ status: "failed", error: result.error.slice(0, 500) });
            summary.failed++;
          }
          break;
      }
    }
  }

  if (
    summary.failed >= PAUSE_MIN_FAILURES &&
    summary.failed / Math.max(1, summary.sent + summary.failed) > PAUSE_FAILURE_RATE
  ) {
    await pauseCampaign(
      supabaseAdmin,
      campaign,
      "Paused automatically: most messages in the last batch failed.",
    );
    summary.status = "paused";
    return summary;
  }

  return completeIfDone();
}

export async function dispatchWhatsAppCampaigns(
  supabaseAdmin: Client,
  deps: DeliveryDeps = {},
): Promise<CampaignTickSummary[]> {
  const now = (deps.now ?? (() => new Date()))();
  // Scheduled campaigns whose time has come start running.
  const { error: startError } = await supabaseAdmin
    .from("whatsapp_campaigns")
    .update({ status: "running" })
    .eq("status", "scheduled")
    .lte("scheduled_at", now.toISOString());
  if (startError) throw startError;

  // Least recently dispatched first, and only a few per organization, so
  // every running campaign gets its turn: one tenant's campaigns (or ones
  // waiting for their send window) can't hold every slot. Each dispatched
  // campaign's updated_at is touched, which moves it to the back.
  const { data: candidates, error } = await supabaseAdmin
    .from("whatsapp_campaigns")
    .select("*")
    .eq("status", "running")
    .order("updated_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(1000);
  if (error) throw error;
  const perOrg = new Map<string, number>();
  const campaigns: CampaignRow[] = [];
  for (const c of candidates ?? []) {
    if (campaigns.length >= MAX_CAMPAIGNS_PER_TICK) break;
    const n = perOrg.get(c.organization_id) ?? 0;
    if (n >= MAX_CAMPAIGNS_PER_ORG_PER_TICK) continue;
    perOrg.set(c.organization_id, n + 1);
    campaigns.push(c);
  }
  const summaries: CampaignTickSummary[] = [];
  for (const campaign of campaigns) {
    try {
      const { error: touchError } = await supabaseAdmin
        .from("whatsapp_campaigns")
        .update({ updated_at: now.toISOString() })
        .eq("id", campaign.id)
        .eq("status", "running");
      if (touchError) throw touchError;
      summaries.push(await dispatchCampaign(supabaseAdmin, campaign, deps, now));
    } catch (err) {
      console.error("whatsapp_campaigns:dispatch_failed", {
        campaignId: campaign.id,
        message:
          err instanceof Error
            ? err.message
            : String((err as { message?: unknown })?.message ?? err),
      });
    }
  }
  return summaries;
}

// ---------------------------------------------------------------------------
// Analytics

export interface CampaignAnalytics {
  total: number;
  pending: number;
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  skipped: Record<string, number>;
}

/** Recipient outcomes plus Meta delivery statuses (from the status webhooks) of the messages sent. */
export async function campaignAnalytics(
  supabaseAdmin: Client,
  organizationId: string,
  campaignId: string,
): Promise<CampaignAnalytics> {
  // Paged: a single read is capped by PostgREST's max-rows.
  const recipients: {
    status: string;
    skip_reason: string | null;
    whatsapp_message_id: string | null;
  }[] = [];
  for (let offset = 0; offset < MAX_RECIPIENTS; offset += ANALYTICS_PAGE_SIZE) {
    const { data, error } = await supabaseAdmin
      .from("whatsapp_campaign_recipients")
      .select("status, skip_reason, whatsapp_message_id")
      .eq("campaign_id", campaignId)
      .eq("organization_id", organizationId)
      .order("id", { ascending: true })
      .range(offset, offset + ANALYTICS_PAGE_SIZE - 1);
    if (error) throw error;
    recipients.push(...(data ?? []));
    if (!data || data.length < ANALYTICS_PAGE_SIZE) break;
  }
  const result: CampaignAnalytics = {
    total: 0,
    pending: 0,
    sent: 0,
    delivered: 0,
    read: 0,
    failed: 0,
    skipped: {},
  };
  const messageIds: string[] = [];
  for (const r of recipients) {
    result.total++;
    if (r.status === "pending" || r.status === "sending") result.pending++;
    else if (r.status === "failed") result.failed++;
    else if (r.status === "skipped") {
      const reason = r.skip_reason ?? "other";
      result.skipped[reason] = (result.skipped[reason] ?? 0) + 1;
    } else if (r.status === "sent") {
      result.sent++;
      if (r.whatsapp_message_id) messageIds.push(r.whatsapp_message_id);
    }
  }
  for (let i = 0; i < messageIds.length; i += 200) {
    const { data, error: msgError } = await supabaseAdmin
      .from("whatsapp_messages")
      .select("status")
      .eq("organization_id", organizationId)
      .in("id", messageIds.slice(i, i + 200));
    if (msgError) throw msgError;
    for (const m of data ?? []) {
      if (m.status === "delivered") result.delivered++;
      else if (m.status === "read") {
        result.delivered++;
        result.read++;
      } else if (m.status === "failed") {
        // Accepted by Meta, then not delivered (from the status webhook).
        result.sent--;
        result.failed++;
      }
    }
  }
  return result;
}
