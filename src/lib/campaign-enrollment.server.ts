import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { applyVariableMapping } from "./contacts-import.ts";

type Admin = SupabaseClient<Database>;

/**
 * Upserts validated CSV rows into the organization's contacts and enrols them
 * in one campaign. A contact on do-not-call is never enrolled, and an upload
 * never clears do-not-call (opted_out is not written here at all).
 */
export async function enrollContactRows(
  admin: Admin,
  input: {
    organizationId: string;
    campaignId: string;
    rows: { phone?: string | null; fields: Record<string, string> }[];
    mapping: Record<string, string>;
  },
): Promise<{ enrolled: number; alreadyInCampaign: number; optedOut: number }> {
  let enrolled = 0;
  let alreadyInCampaign = 0;
  let optedOut = 0;

  for (const row of input.rows) {
    const mappedFields = applyVariableMapping(row.fields, input.mapping);
    const name = mappedFields["customer_name"] ?? row.fields["name"] ?? row.fields["Name"] ?? null;

    // Upsert into Klyro's own CRM (unique on organization_id+phone) — never
    // overwrites opted_out state, so a re-upload of a number that opted
    // out previously cannot silently re-enable it.
    const { data: existing } = await admin
      .from("contacts")
      .select("id, opted_out, custom_fields")
      .eq("organization_id", input.organizationId)
      .eq("phone", row.phone!)
      .maybeSingle();

    let contactId: string;
    if (existing) {
      contactId = existing.id;
      await admin
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
      const { data: created, error: createError } = await admin
        .from("contacts")
        .insert({
          organization_id: input.organizationId,
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

    const { error: enrollError } = await admin.from("campaign_contacts").insert({
      campaign_id: input.campaignId,
      organization_id: input.organizationId,
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
  return { enrolled, alreadyInCampaign, optedOut };
}
