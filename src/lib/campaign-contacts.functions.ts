import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { csvToTable, validateContactRows } from "./contacts-import";

/**
 * Enrolling contacts into a campaign (spec §11/§12/§26). The client may
 * parse a CSV locally to show a fast preview, but nothing it computes
 * (valid/invalid/duplicate counts, the mapped variables) is trusted here —
 * this handler re-parses and re-validates the raw CSV text server-side with
 * the exact same shared contacts-import.ts functions, so the numbers shown
 * to the customer always match what was actually written to the database.
 *
 * Pipeline (spec §26): validate -> parse -> map -> validate phone -> dedupe
 * -> upsert into `contacts` (Klyro's own CRM, independent of any campaign)
 * -> create `campaign_contacts` rows for this campaign, skipping any contact
 * already opted out. No row is ever sent to Sarvam here — enrollment only
 * ever writes Klyro's own tables; dispatching to Sarvam is
 * campaign-dispatch.server.ts's job, one call at a time, only once the
 * campaign is launched.
 */

interface ImportCsvInput {
  campaignId: string;
  filename: string;
  csvText: string;
  phoneColumn: string;
  /** {csvColumn: agentVariableName} */
  mapping: Record<string, string>;
}

export interface ImportCsvResult {
  totalRows: number;
  enrolled: number;
  alreadyInCampaign: number;
  optedOut: number;
  invalid: number;
  duplicatesInFile: number;
}

type CallerContext = { supabase: unknown; userId: string };

/** The campaign's own organization, once the caller is a member of it. */
async function campaignOrgId(context: CallerContext, campaignId: string): Promise<string> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { campaignOrganizationForCaller } = await import("@/lib/outbound-authorization.server");
  return campaignOrganizationForCaller(
    { supabase: context.supabase as typeof supabaseAdmin, supabaseAdmin },
    context.userId,
    campaignId,
    { dial: false, notFoundMessage: "Campaign not found for this organization." },
  );
}

async function requireOwnCampaign(orgId: string, campaignId: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: campaign } = await supabaseAdmin
    .from("campaigns")
    .select("id, organization_id, status")
    .eq("id", campaignId)
    .maybeSingle();
  if (!campaign || campaign.organization_id !== orgId) {
    throw new Error("Campaign not found for this organization.");
  }
  if (!["draft", "scheduled", "paused"].includes(campaign.status)) {
    throw new Error(`Contacts cannot be added while the campaign is ${campaign.status}.`);
  }
  return campaign;
}

export const importCampaignContactsCsv = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: ImportCsvInput) => {
    if (!input?.campaignId) throw new Error("campaignId is required");
    if (!input.csvText) throw new Error("csvText is required");
    if (!input.phoneColumn) throw new Error("phoneColumn is required");
    return input;
  })
  .handler(async ({ data, context }): Promise<ImportCsvResult> => {
    const orgId = await campaignOrgId(context, data.campaignId);
    await requireOwnCampaign(orgId, data.campaignId);

    const table = csvToTable(data.csvText);
    if (!table.headers.includes(data.phoneColumn)) {
      throw new Error(`Column "${data.phoneColumn}" was not found in the uploaded file.`);
    }
    const summary = validateContactRows(table, data.phoneColumn);

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { enrollContactRows } = await import("@/lib/campaign-enrollment.server");
    const { enrolled, alreadyInCampaign, optedOut } = await enrollContactRows(supabaseAdmin, {
      organizationId: orgId,
      campaignId: data.campaignId,
      rows: summary.valid,
      mapping: data.mapping,
    });

    await supabaseAdmin.from("campaign_uploads").insert({
      campaign_id: data.campaignId,
      organization_id: orgId,
      filename: data.filename,
      total_rows: summary.totalRows,
      valid_rows: summary.valid.length,
      invalid_rows: summary.invalid.length,
      duplicate_rows: summary.duplicates.length,
      created_by: context.userId,
    });

    return {
      totalRows: summary.totalRows,
      enrolled,
      alreadyInCampaign,
      optedOut,
      invalid: summary.invalid.length,
      duplicatesInFile: summary.duplicates.length,
    };
  });

interface EnrollExistingInput {
  campaignId: string;
  contactIds: string[];
}

export const enrollExistingContacts = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: EnrollExistingInput) => {
    if (!input?.campaignId) throw new Error("campaignId is required");
    if (!Array.isArray(input.contactIds) || input.contactIds.length === 0)
      throw new Error("At least one contact is required");
    return input;
  })
  .handler(async ({ data, context }) => {
    const orgId = await campaignOrgId(context, data.campaignId);
    await requireOwnCampaign(orgId, data.campaignId);

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: contacts } = await supabaseAdmin
      .from("contacts")
      .select("id, opted_out")
      .eq("organization_id", orgId)
      .in("id", data.contactIds);

    let enrolled = 0;
    let optedOut = 0;
    let alreadyInCampaign = 0;
    for (const contact of contacts ?? []) {
      if (contact.opted_out) {
        optedOut++;
        continue;
      }
      const { error } = await supabaseAdmin.from("campaign_contacts").insert({
        campaign_id: data.campaignId,
        organization_id: orgId,
        contact_id: contact.id,
        variables: {},
      });
      if (error) {
        if ((error as { code?: string }).code === "23505") {
          alreadyInCampaign++;
          continue;
        }
        throw error;
      }
      enrolled++;
    }

    return { enrolled, optedOut, alreadyInCampaign };
  });

interface SetOptOutInput {
  contactId: string;
  optedOut: boolean;
  reason?: string | undefined;
}

/** Manual do-not-call toggle (spec §40). Always server-side so it can never be bypassed by a stale client cache. */
export const setContactOptOut = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: SetOptOutInput) => {
    if (!input?.contactId) throw new Error("contactId is required");
    return input;
  })
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: contact } = await supabaseAdmin
      .from("contacts")
      .select("id, organization_id")
      .eq("id", data.contactId)
      .maybeSingle();
    if (!contact) throw new Error("Contact not found.");
    // The contact's own organization, once the caller is a member of it.
    const { memberRole } = await import("@/lib/outbound-authorization.server");
    const role = await memberRole(
      context.supabase as typeof supabaseAdmin,
      context.userId,
      contact.organization_id,
    );
    if (!role) throw new Error("Contact not found.");

    // Marking also pulls the contact out of every not-yet-dialled enrolment;
    // clearing needs an owner/admin and a reason, and is audited (audit_logs).
    const { changeContactOptOut } = await import("@/lib/contact-suppression.server");
    // Clearing runs as the signed-in user (their JWT), never as the service role.
    const result = await changeContactOptOut(
      supabaseAdmin,
      context.supabase as typeof supabaseAdmin,
      {
        organizationId: contact.organization_id,
        contactId: data.contactId,
        actorRole: role,
        optedOut: data.optedOut,
        reason: data.reason,
      },
    );

    return { ok: true, changed: result.changed };
  });
