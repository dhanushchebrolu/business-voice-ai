import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { isValidTimeZone } from "@/lib/campaign-schedule";

/**
 * Dashboard server functions for WhatsApp notifications, templates,
 * consent and campaigns.
 *
 * Tenant rule (as in whatsapp-connection.functions.ts): the organization is
 * always the signed-in user's own membership; ids from the browser are only
 * matched inside it. Reads use the RLS-scoped client. Writes use the
 * service role, re-check the organization on every row, and require a role:
 *   - owner/admin: notification settings, template purposes, suppressions.
 *   - owner/admin/manager: template sync, campaigns.
 *   - any role but viewer: recording a customer's consent.
 * Every write is recorded in whatsapp_audit_log. No credential is ever
 * selected or returned.
 */

type AuthedContext = {
  supabase: import("@supabase/supabase-js").SupabaseClient<
    import("@/integrations/supabase/types").Database
  >;
  userId: string;
};

type Role = "owner" | "admin" | "manager" | "staff" | "viewer";

async function resolveMembership(context: AuthedContext) {
  const { data: membership, error } = await context.supabase
    .from("organization_members")
    .select("organization_id, role")
    .eq("user_id", context.userId)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!membership) throw new Error("No workspace found for your account.");
  return membership as { organization_id: string; role: Role };
}

function requireRole(role: Role, allowed: Role[]) {
  if (!allowed.includes(role)) {
    throw new Error("Your role doesn't allow this change.");
  }
}

const OWNER_ADMIN: Role[] = ["owner", "admin"];
const MANAGERS: Role[] = ["owner", "admin", "manager"];
const WRITERS: Role[] = ["owner", "admin", "manager", "staff"];

function friendly(err: unknown): never {
  if (err && typeof err === "object" && "code" in err && err instanceof Error) {
    throw new Error(err.message);
  }
  throw err;
}

export const getWhatsAppMessagingOverview = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const membership = await resolveMembership(context);
    const org = membership.organization_id;
    const [connections, templates, notifications, campaigns, audit, contacts] = await Promise.all([
      context.supabase
        .from("whatsapp_connections")
        .select(
          "id, business_id, display_phone_number, status, notifications_enabled, transactional_consent_basis, notifications_enabled_at",
        )
        .eq("organization_id", org)
        .neq("status", "disconnected"),
      context.supabase
        .from("whatsapp_templates")
        .select(
          "id, whatsapp_connection_id, name, language, category, status, body_text, body_param_count, purpose, synced_at",
        )
        .eq("organization_id", org)
        .order("name"),
      context.supabase
        .from("whatsapp_notifications")
        .select("id, kind, status, skip_reason, last_error, attempts, created_at, sent_at")
        .eq("organization_id", org)
        .order("created_at", { ascending: false })
        .limit(50),
      context.supabase
        .from("whatsapp_campaigns")
        .select(
          "id, name, status, paused_reason, template_id, scheduled_at, launched_at, completed_at, max_per_minute, created_at",
        )
        .eq("organization_id", org)
        .order("created_at", { ascending: false })
        .limit(50),
      context.supabase
        .from("whatsapp_audit_log")
        .select("id, actor_type, action, subject_type, details, created_at")
        .eq("organization_id", org)
        .order("created_at", { ascending: false })
        .limit(50),
      context.supabase
        .from("contacts")
        .select("id, name, phone")
        .eq("organization_id", org)
        .order("name")
        .limit(500),
    ]);
    for (const r of [connections, templates, notifications, campaigns, audit, contacts]) {
      if (r.error) throw r.error;
    }
    const { campaignAnalytics } = await import("@/lib/whatsapp/whatsapp-campaigns.server");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const withStats = await Promise.all(
      (campaigns.data ?? []).map(async (c) => ({
        ...c,
        analytics: await campaignAnalytics(supabaseAdmin, org, c.id),
      })),
    );
    return {
      role: membership.role,
      connections: connections.data ?? [],
      templates: templates.data ?? [],
      notifications: notifications.data ?? [],
      campaigns: withStats,
      audit: audit.data ?? [],
      contacts: contacts.data ?? [],
    };
  });

const notificationSettingsSchema = z.object({
  connectionId: z.string().uuid(),
  enabled: z.boolean(),
  consentBasis: z.string().trim().max(500).optional(),
});

/** Turning notifications on requires recording how customers agreed to them. */
export const setWhatsAppNotificationSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { connectionId: unknown; enabled: unknown; consentBasis?: unknown }) =>
    notificationSettingsSchema.parse(input),
  )
  .handler(async ({ data, context }) => {
    const membership = await resolveMembership(context);
    requireRole(membership.role, OWNER_ADMIN);
    if (data.enabled && (!data.consentBasis || data.consentBasis.length < 20)) {
      throw new Error(
        "Describe how customers agree to booking and payment messages on WhatsApp (at least 20 characters).",
      );
    }
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const now = new Date().toISOString();
    const { data: updated, error } = await supabaseAdmin
      .from("whatsapp_connections")
      .update(
        data.enabled
          ? {
              notifications_enabled: true,
              transactional_consent_basis: data.consentBasis!,
              notifications_enabled_at: now,
              notifications_enabled_by: context.userId,
            }
          : { notifications_enabled: false },
      )
      .eq("id", data.connectionId)
      .eq("organization_id", membership.organization_id)
      .select("id, business_id");
    if (error) throw error;
    if (!updated || updated.length === 0) throw new Error("WhatsApp number not found.");
    const { writeAuditLog } = await import("@/lib/whatsapp/whatsapp-consent.server");
    await writeAuditLog(supabaseAdmin, {
      organizationId: membership.organization_id,
      businessId: updated[0]!.business_id,
      actorType: "user",
      actorUserId: context.userId,
      action: data.enabled ? "notifications.enable" : "notifications.disable",
      subjectType: "whatsapp_connection",
      subjectId: data.connectionId,
      details: data.enabled ? { consentBasis: data.consentBasis } : {},
    });
    return { ok: true as const };
  });

export const syncWhatsAppTemplates = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { connectionId: unknown }) =>
    z.object({ connectionId: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const membership = await resolveMembership(context);
    requireRole(membership.role, MANAGERS);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { syncTemplates } = await import("@/lib/whatsapp/whatsapp-campaigns.server");
    try {
      return await syncTemplates(supabaseAdmin, {
        organizationId: membership.organization_id,
        connectionId: data.connectionId,
      });
    } catch (err) {
      friendly(err);
    }
  });

const purposes = [
  "booking_confirmed",
  "booking_rescheduled",
  "booking_cancelled",
  "booking_reminder",
  "payment_link",
  "payment_confirmation",
  "payment_failed",
  "payment_expired",
] as const;

export const setWhatsAppTemplatePurpose = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { templateId: unknown; purpose: unknown }) =>
    z.object({ templateId: z.string().uuid(), purpose: z.enum(purposes).nullable() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const membership = await resolveMembership(context);
    requireRole(membership.role, OWNER_ADMIN);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: template, error } = await supabaseAdmin
      .from("whatsapp_templates")
      .select("id, whatsapp_connection_id, status, category, body_text, body_param_count")
      .eq("id", data.templateId)
      .eq("organization_id", membership.organization_id)
      .maybeSingle();
    if (error) throw error;
    if (!template) throw new Error("Template not found.");
    if (data.purpose) {
      const { templatePurposeProblem } = await import("@/lib/whatsapp/whatsapp-campaigns.server");
      const problem = templatePurposeProblem(template, data.purpose);
      if (problem) throw new Error(problem);
      // One template per purpose per number: release it from any other template first.
      await supabaseAdmin
        .from("whatsapp_templates")
        .update({ purpose: null })
        .eq("whatsapp_connection_id", template.whatsapp_connection_id)
        .eq("organization_id", membership.organization_id)
        .eq("purpose", data.purpose);
    }
    const { error: updateError } = await supabaseAdmin
      .from("whatsapp_templates")
      .update({ purpose: data.purpose })
      .eq("id", template.id)
      .eq("organization_id", membership.organization_id);
    if (updateError) throw updateError;
    const { writeAuditLog } = await import("@/lib/whatsapp/whatsapp-consent.server");
    await writeAuditLog(supabaseAdmin, {
      organizationId: membership.organization_id,
      actorType: "user",
      actorUserId: context.userId,
      action: "template.set_purpose",
      subjectType: "whatsapp_template",
      subjectId: template.id,
      details: { purpose: data.purpose },
    });
    return { ok: true as const };
  });

const consentSchema = z.object({
  contactId: z.string().uuid(),
  businessId: z.string().uuid(),
  scope: z.enum(["transactional", "marketing"]),
  action: z.enum(["opt_in", "opt_out"]),
  evidence: z.string().trim().max(1000).optional(),
});

/** Staff-attested consent (e.g. a signed form or a recorded verbal agreement). Opt-ins need evidence. */
export const recordWhatsAppContactConsent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: Record<string, unknown>) => consentSchema.parse(input))
  .handler(async ({ data, context }) => {
    const membership = await resolveMembership(context);
    requireRole(membership.role, WRITERS);
    if (data.action === "opt_in" && (!data.evidence || data.evidence.length < 10)) {
      throw new Error("Record how the customer agreed (at least 10 characters).");
    }
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const org = membership.organization_id;
    const [{ data: contact, error: contactError }, { data: business, error: businessError }] =
      await Promise.all([
        supabaseAdmin
          .from("contacts")
          .select("id, phone, business_id")
          .eq("id", data.contactId)
          .eq("organization_id", org)
          .maybeSingle(),
        supabaseAdmin
          .from("businesses")
          .select("id, country")
          .eq("id", data.businessId)
          .eq("organization_id", org)
          .maybeSingle(),
      ]);
    if (contactError) throw contactError;
    if (businessError) throw businessError;
    if (!contact || !business) throw new Error("Contact or business not found.");
    const { toWaId, recordConsentEvent, writeAuditLog } =
      await import("@/lib/whatsapp/whatsapp-consent.server");
    const waId = toWaId(contact.phone, business.country);
    if (!waId) throw new Error("This contact's phone number isn't a valid WhatsApp number.");
    await recordConsentEvent(supabaseAdmin, {
      organizationId: org,
      businessId: business.id,
      waId,
      scope: data.scope,
      action: data.action,
      source: "staff_attested",
      evidence: data.evidence ?? null,
      contactId: contact.id,
      actorUserId: context.userId,
    });
    await writeAuditLog(supabaseAdmin, {
      organizationId: org,
      businessId: business.id,
      actorType: "user",
      actorUserId: context.userId,
      action: `consent.${data.action}`,
      subjectType: "contact",
      subjectId: contact.id,
      details: { scope: data.scope, source: "staff_attested" },
    });
    return { ok: true as const };
  });

export const setWhatsAppSuppression = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: Record<string, unknown>) =>
    z
      .object({
        businessId: z.string().uuid(),
        phone: z.string().trim().min(5).max(20),
        suppressed: z.boolean(),
        details: z.string().trim().max(500).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const membership = await resolveMembership(context);
    requireRole(membership.role, OWNER_ADMIN);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const org = membership.organization_id;
    const { data: business, error } = await supabaseAdmin
      .from("businesses")
      .select("id, country")
      .eq("id", data.businessId)
      .eq("organization_id", org)
      .maybeSingle();
    if (error) throw error;
    if (!business) throw new Error("Business not found.");
    const { toWaId, writeAuditLog } = await import("@/lib/whatsapp/whatsapp-consent.server");
    const waId = toWaId(data.phone, business.country);
    if (!waId) throw new Error("Not a valid phone number.");
    if (data.suppressed) {
      const { error: insertError } = await supabaseAdmin.from("whatsapp_suppressions").upsert(
        {
          organization_id: org,
          business_id: business.id,
          wa_id: waId,
          reason: "staff",
          details: data.details ?? null,
          created_by: context.userId,
        },
        { onConflict: "business_id,wa_id", ignoreDuplicates: true },
      );
      if (insertError) throw insertError;
    } else {
      const { error: deleteError } = await supabaseAdmin
        .from("whatsapp_suppressions")
        .delete()
        .eq("business_id", business.id)
        .eq("organization_id", org)
        .eq("wa_id", waId);
      if (deleteError) throw deleteError;
    }
    await writeAuditLog(supabaseAdmin, {
      organizationId: org,
      businessId: business.id,
      actorType: "user",
      actorUserId: context.userId,
      action: data.suppressed ? "suppression.add" : "suppression.remove",
      subjectType: "phone",
      details: { last4: waId.slice(-4) },
    });
    return { ok: true as const };
  });

const paramSpec = z.discriminatedUnion("source", [
  z.object({ source: z.literal("static"), value: z.string().trim().min(1).max(500) }),
  z.object({ source: z.literal("contact_first_name"), fallback: z.string().trim().max(40) }),
  z.object({ source: z.literal("business_name") }),
]);

const createCampaignSchema = z.object({
  templateId: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  templateParams: z.array(paramSpec).max(10),
  audience: z.discriminatedUnion("type", [
    z.object({ type: z.literal("all_consented") }),
    z.object({
      type: z.literal("contacts"),
      contactIds: z.array(z.string().uuid()).min(1).max(10_000),
    }),
  ]),
  schedule: z
    .object({
      windowStart: z
        .string()
        .regex(/^\d{2}:\d{2}$/)
        .optional(),
      windowEnd: z
        .string()
        .regex(/^\d{2}:\d{2}$/)
        .optional(),
      days: z.array(z.number().int().min(0).max(6)).optional(),
      timezone: z.string().max(64).refine(isValidTimeZone, "Unknown time zone.").optional(),
    })
    .default({}),
  scheduledAt: z.string().datetime().nullable().optional(),
  maxPerMinute: z.number().int().min(1).max(80).default(20),
});

export const createWhatsAppCampaign = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: Record<string, unknown>) => createCampaignSchema.parse(input))
  .handler(async ({ data, context }) => {
    const membership = await resolveMembership(context);
    requireRole(membership.role, MANAGERS);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const org = membership.organization_id;
    // The template decides the number, and the number decides the business.
    const { data: template, error } = await supabaseAdmin
      .from("whatsapp_templates")
      .select("id, whatsapp_connection_id, status, category, body_param_count, body_text")
      .eq("id", data.templateId)
      .eq("organization_id", org)
      .maybeSingle();
    if (error) throw error;
    if (!template) throw new Error("Template not found.");
    if (template.status !== "APPROVED" || template.category !== "MARKETING") {
      throw new Error("Campaigns need an APPROVED, MARKETING-category template.");
    }
    if (template.body_param_count !== data.templateParams.length) {
      throw new Error(`This template needs ${template.body_param_count} parameter(s).`);
    }
    const { data: connection, error: connError } = await supabaseAdmin
      .from("whatsapp_connections")
      .select("id, business_id, status")
      .eq("id", template.whatsapp_connection_id)
      .eq("organization_id", org)
      .maybeSingle();
    if (connError) throw connError;
    if (!connection?.business_id || connection.status !== "connected") {
      throw new Error("The template's WhatsApp number isn't connected to a business.");
    }
    const { data: created, error: insertError } = await supabaseAdmin
      .from("whatsapp_campaigns")
      .insert({
        organization_id: org,
        business_id: connection.business_id,
        whatsapp_connection_id: connection.id,
        template_id: template.id,
        name: data.name,
        template_params: data.templateParams,
        audience: data.audience,
        schedule: data.schedule,
        scheduled_at: data.scheduledAt ?? null,
        max_per_minute: data.maxPerMinute,
        created_by: context.userId,
      })
      .select("id")
      .single();
    if (insertError) throw insertError;
    const { writeAuditLog } = await import("@/lib/whatsapp/whatsapp-consent.server");
    await writeAuditLog(supabaseAdmin, {
      organizationId: org,
      businessId: connection.business_id,
      actorType: "user",
      actorUserId: context.userId,
      action: "campaign.create",
      subjectType: "whatsapp_campaign",
      subjectId: created.id,
      details: { audience: data.audience.type },
    });
    return { id: created.id };
  });

export const changeWhatsAppCampaign = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { campaignId: unknown; action: unknown }) =>
    z
      .object({
        campaignId: z.string().uuid(),
        action: z.enum(["launch", "pause", "resume", "cancel"]),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const membership = await resolveMembership(context);
    requireRole(membership.role, MANAGERS);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { launchCampaign, changeCampaignStatus } =
      await import("@/lib/whatsapp/whatsapp-campaigns.server");
    try {
      if (data.action === "launch") {
        return await launchCampaign(supabaseAdmin, {
          organizationId: membership.organization_id,
          campaignId: data.campaignId,
          actorUserId: context.userId,
        });
      }
      return await changeCampaignStatus(supabaseAdmin, {
        organizationId: membership.organization_id,
        campaignId: data.campaignId,
        action: data.action,
        actorUserId: context.userId,
      });
    } catch (err) {
      friendly(err);
    }
  });
