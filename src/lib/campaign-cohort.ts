import type { CohortTransformation } from "./telephony/sarvam-api-client.server.ts";

/**
 * Builds the CSV + transformation-mapping payload for the (experimental)
 * `sarvam_campaign` dispatch mode's cohort upload — pure, no I/O, so the
 * exact final payload sent to Sarvam can be asserted in a test without a
 * network call or a live API key (spec "FOURTH" — provider contract test).
 *
 * Klyro always generates this CSV itself from campaign_contacts rows it
 * already validated at enrollment time (contacts-import.ts) — this is never
 * fed a customer's raw uploaded file directly, so there is no need to
 * re-validate phone numbers or column names here. Because Klyro controls
 * every column name, `appVariableColumns` is always an identity mapping
 * (variable name -> identically-named CSV column) — this sidesteps any
 * ambiguity about the transformation file's exact column-reference syntax,
 * which was not independently confirmed (see uploadCohort's doc).
 */

export interface CohortRow {
  /** campaign_contacts.id — becomes the row's user_identifier, which Sarvam's webhook is expected to echo back (per extractClientReference's existing, already-verified user_identifier handling). */
  campaignContactId: string;
  /** E.164 destination number. */
  phone: string;
  /** Resolved per-contact agent variables (campaign_contacts.variables, already mapped at enrollment time). */
  variables: Record<string, string>;
}

export interface CohortPayload {
  csvText: string;
  transformation: CohortTransformation;
}

const PHONE_COLUMN = "phone";
const USER_IDENTIFIER_COLUMN = "user_identifier";

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export function buildCohortPayload(rows: CohortRow[]): CohortPayload {
  const variableNames = Array.from(new Set(rows.flatMap((r) => Object.keys(r.variables)))).sort();
  const headers = [PHONE_COLUMN, USER_IDENTIFIER_COLUMN, ...variableNames];

  const lines = [headers.map(csvEscape).join(",")];
  for (const row of rows) {
    const line = [
      row.phone,
      row.campaignContactId,
      ...variableNames.map((name) => row.variables[name] ?? ""),
    ];
    lines.push(line.map(csvEscape).join(","));
  }

  const appVariableColumns: Record<string, string> = {};
  for (const name of variableNames) appVariableColumns[name] = name;

  return {
    csvText: lines.join("\n"),
    transformation: {
      phoneNumberColumn: PHONE_COLUMN,
      userIdentifierColumn: USER_IDENTIFIER_COLUMN,
      appVariableColumns,
    },
  };
}
