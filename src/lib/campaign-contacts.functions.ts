import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { csvToTable, validateContactRows, applyVariableMapping } from "./contacts-import";

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

async function resolveOrgId(context: { supabase: unknown; userId: string }): Promise<string> {
  const supabase = context.supabase as import("@supabase/supabase-js").SupabaseClient;
  const { data: membership } = await supabase
    .from("organization_members")
    .select("organization_id")
    .eq("user_id", context.userId)
    .order("created_at")
    .limit(1)
    .maybeSingle();
  if (!membership) throw new Error("No workspace found for this account");
  return membership.organization_id as string;
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
    const orgId = await resolveOrgId(context);
    await requireOwnCampaign(orgId, data.campaignId);

    const table = csvToTable(data.csvText);
    if (!table.headers.includes(data.phoneColumn)) {
      throw new Error(`Column "${data.phoneColumn}" was not found in the uploaded file.`);
    }
    const summary = validateContactRows(table, data.phoneColumn);

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    let enrolled = 0;
    let alreadyInCampaign = 0;
    let optedOut = 0;

    for (const row of summary.valid) {
      const mappedFields = applyVariableMapping(row.fields, data.mapping);
      const name =
        mappedFields["customer_name"] ?? row.fields["name"] ?? row.fields["Name"] ?? null;

      // Upsert into Klyro's own CRM (unique on organization_id+phone) — never
      // overwrites opted_out state, so a re-upload of a number that opted
      // out previously cannot silently re-enable it.
      const { data: existing } = await supabaseAdmin
        .from("contacts")
        .select("id, opted_out, custom_fields")
        .eq("organization_id", orgId)
        .eq("phone", row.phone!)
        .maybeSingle();

      let contactId: string;
      if (existing) {
        contactId = existing.id;
        await supabaseAdmin
          .from("contacts")
          .update({
            name,
            custom_fields: {
              ...(existing.custom_fields as Record<string, unknown>),
              ...row.fields,
            } as never,
          })
          .eq("id", contactId);
        if (existing.opted_out) {
          optedOut++;
          continue;
        }
      } else {
        const { data: created, error: createError } = await supabaseAdmin
          .from("contacts")
          .insert({
            organization_id: orgId,
            name,
            phone: row.phone!,
            custom_fields: row.fields,
            source: "csv_import",
          })
          .select("id")
          .single();
        if (createError) throw createError;
        contactId = created.id;
      }

      const { error: enrollError } = await supabaseAdmin.from("campaign_contacts").insert({
        campaign_id: data.campaignId,
        organization_id: orgId,
        contact_id: contactId,
        variables: mappedFields,
      });
      if (enrollError) {
        // Unique (campaign_id, contact_id) violation = already enrolled — not an error.
        if ((enrollError as { code?: string }).code === "23505") {
          alreadyInCampaign++;
          continue;
        }
        throw enrollError;
      }
      enrolled++;
    }

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
    const orgId = await resolveOrgId(context);
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
    const orgId = await resolveOrgId(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: contact } = await supabaseAdmin
      .from("contacts")
      .select("id, organization_id")
      .eq("id", data.contactId)
      .maybeSingle();
    if (!contact || contact.organization_id !== orgId) throw new Error("Contact not found.");

    await supabaseAdmin
      .from("contacts")
      .update({
        opted_out: data.optedOut,
        opted_out_at: data.optedOut ? new Date().toISOString() : null,
        opted_out_reason: data.optedOut ? (data.reason ?? "Manually marked do-not-call") : null,
      })
      .eq("id", data.contactId);

    // Pull the contact out of any not-yet-dialed enrollment across every
    // campaign it's in — an opt-out must stop future dialing immediately,
    // not just block new enrollment.
    if (data.optedOut) {
      await supabaseAdmin
        .from("campaign_contacts")
        .update({ status: "opted_out", next_attempt_at: null })
        .eq("contact_id", data.contactId)
        .in("status", ["pending", "retry_scheduled"]);
    }

    return { ok: true };
  });
