import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { applyVariableMapping, type ContactImportSummary } from "./contacts-import.ts";

type Admin = SupabaseClient<Database>;

/** One validated row as the import function receives it. */
export interface ImportRow {
  phone: string;
  /** The contact's name from this row, or null when the row has none (a saved name is kept). */
  name: string | null;
  /** The row's CSV cells; only non-empty ones are merged into the contact. */
  fields: Record<string, string>;
  /** The agent variables for this campaign membership. */
  variables: Record<string, string>;
}

/** The import's result, exactly as the database recorded it. */
export interface ImportResult {
  uploadId: string;
  /** true when this key was already imported: the first import's result, nothing written. */
  replayed: boolean;
  totalRows: number;
  valid: number;
  invalid: number;
  duplicatesInFile: number;
  /** New campaign memberships created by this import. */
  enrolled: number;
  /** Valid rows whose contact was already in this campaign. */
  alreadyInCampaign: number;
  /** Valid rows whose contact is on do-not-call: never enrolled, never cleared. */
  optedOut: number;
}

/** Rows for the database from the server's own validation (unique phones, normalized). */
export function buildImportRows(
  valid: ContactImportSummary["valid"],
  mapping: Record<string, string>,
): ImportRow[] {
  return valid.map((row) => {
    const variables = applyVariableMapping(row.fields, mapping);
    const raw = variables["customer_name"] ?? row.fields["name"] ?? row.fields["Name"] ?? "";
    return {
      phone: row.phone!,
      name: raw.trim() ? raw.trim() : null,
      fields: row.fields,
      variables,
    };
  });
}

/**
 * Writes the contacts, their memberships and the history row in one database
 * transaction (public.import_campaign_contacts): all of it or none of it. The
 * same idempotency key again returns the first import's result. Throws when
 * the database refuses or the answer is incomplete, so a count is never guessed.
 */
export async function importContactsAtomically(
  admin: Admin,
  input: {
    organizationId: string;
    campaignId: string;
    userId: string;
    idempotencyKey: string | null;
    filename: string;
    summary: Pick<ContactImportSummary, "totalRows" | "invalid" | "duplicates">;
    rows: ImportRow[];
  },
): Promise<ImportResult> {
  const rpc = admin.rpc.bind(admin) as unknown as (
    fn: string,
    args: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>;
  const { data, error } = await rpc("import_campaign_contacts", {
    _org: input.organizationId,
    _campaign: input.campaignId,
    _user: input.userId,
    _idempotency_key: input.idempotencyKey,
    _filename: input.filename,
    _total_rows: input.summary.totalRows,
    _invalid_rows: input.summary.invalid.length,
    _duplicate_rows: input.summary.duplicates.length,
    _rows: input.rows,
  });
  if (error) throw error;
  const d = (data ?? {}) as Record<string, unknown>;
  const n = (k: string) => {
    const v = d[k];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0)
      throw new Error("The import finished but its result could not be read. Reload the page.");
    return v;
  };
  if (typeof d["upload_id"] !== "string")
    throw new Error("The import finished but its result could not be read. Reload the page.");
  return {
    uploadId: d["upload_id"],
    replayed: d["replayed"] === true,
    totalRows: n("total_rows"),
    valid: n("valid_rows"),
    invalid: n("invalid_rows"),
    duplicatesInFile: n("duplicate_rows"),
    enrolled: n("enrolled"),
    alreadyInCampaign: n("already_in_campaign"),
    optedOut: n("opted_out"),
  };
}
