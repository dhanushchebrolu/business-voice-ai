import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { csvToTable, validateContactRows } from "./contacts-import";
import { CAMPAIGN_IDEMPOTENCY_KEY_PATTERN } from "./campaign-create-key";
import { IMPORT_TOO_LARGE_MESSAGE, MAX_IMPORT_ROWS } from "./campaign-wizard";

/**
 * Enrolling contacts into a campaign (spec §11/§12/§26). The client may
 * parse a CSV locally to show a fast preview, but nothing it computes
 * (valid/invalid/duplicate counts, the mapped variables) is trusted here —
 * this handler re-parses and re-validates the raw CSV text server-side with
 * the exact same shared contacts-import.ts functions, so the numbers shown
 * to the customer always match what was actually written to the database.
 *
 * Pipeline (spec §26): validate -> parse -> map -> validate phone -> dedupe
 * -> one database transaction (import_campaign_contacts): upsert into
 * `contacts` (a blank name never replaces a saved one), create
 * `campaign_contacts` rows, skipping any contact already opted out, and write
 * the history row with exactly what was added. No row is ever sent to Sarvam here — enrollment only
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
  /** One per import attempt (kept across retries): the same key returns the first result. */
  idempotencyKey?: string;
}

export type { ImportResult as ImportCsvResult } from "./campaign-enrollment.server";

type CallerContext = { supabase: unknown; userId: string };

/** The campaign's own organization, once the caller may decide who it calls (owner or admin). */
async function campaignOrgId(context: CallerContext, campaignId: string): Promise<string> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { campaignOrganizationForCaller } = await import("@/lib/outbound-authorization.server");
  return campaignOrganizationForCaller(
    { supabase: context.supabase as typeof supabaseAdmin, supabaseAdmin },
    context.userId,
    campaignId,
    { dial: true, notFoundMessage: "Campaign not found for this organization." },
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
    if (
      input.idempotencyKey !== undefined &&
      !CAMPAIGN_IDEMPOTENCY_KEY_PATTERN.test(input.idempotencyKey)
    )
      throw new Error("This import has an invalid request id.");
    return input;
  })
  .handler(async ({ data, context }) => {
    const orgId = await campaignOrgId(context, data.campaignId);
    await requireOwnCampaign(orgId, data.campaignId);

    // The whole file is parsed and validated before anything is written.
    const table = csvToTable(data.csvText);
    // One import is one database transaction under the Data API's 8 s statement timeout;
    // local load tests ran 5,000 rows in 1.6-3.5 s and timed out (rolled back) at 20,000.
    if (table.rows.length > MAX_IMPORT_ROWS) throw new Error(IMPORT_TOO_LARGE_MESSAGE);
    if (!table.headers.includes(data.phoneColumn)) {
      throw new Error(`Column "${data.phoneColumn}" was not found in the uploaded file.`);
    }
    const summary = validateContactRows(table, data.phoneColumn);

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { buildImportRows, importContactsAtomically } =
      await import("@/lib/campaign-enrollment.server");
    // One transaction: contacts, memberships and the history row, or nothing.
    return importContactsAtomically(supabaseAdmin, {
      organizationId: orgId,
      campaignId: data.campaignId,
      userId: context.userId,
      idempotencyKey: data.idempotencyKey ?? null,
      filename: data.filename,
      summary,
      rows: buildImportRows(summary.valid, data.mapping),
    });
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
