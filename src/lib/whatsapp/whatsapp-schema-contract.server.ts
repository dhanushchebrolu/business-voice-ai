/**
 * The database contract the WhatsApp (Vobiz) code depends on.
 *
 * Production incident (2026-10-27): the Vobiz code was deployed before
 * migration 20261027090000_whatsapp_vobiz_channels, so every query naming
 * whatsapp_connections.number_onboarding_mode / provider / vobiz_channel_id
 * failed with PostgreSQL 42703 ("column … does not exist"), surfaced to the
 * browser as a raw database error.
 *
 * This turns that class of failure — a column or table the code expects is
 * missing — into one clear, customer-safe error plus a log line naming the
 * missing object (never row data, secrets or codes). It does not hide the
 * problem or fall back to a weaker behaviour: the action still fails; the
 * fix is applying the migrations (see docs/whatsapp-integration.md).
 */

/** PostgreSQL / PostgREST codes for "the schema doesn't have what the query names". */
const SCHEMA_MISMATCH_CODES = new Set([
  "42703", // undefined_column
  "42P01", // undefined_table
  "42883", // undefined_function
  "PGRST204", // PostgREST: column not found in the schema cache
  "PGRST205", // PostgREST: table not found in the schema cache
  "PGRST202", // PostgREST: function not found in the schema cache
]);

export const WHATSAPP_SCHEMA_MISMATCH_MESSAGE =
  "WhatsApp isn't fully set up on this deployment yet (a database update is pending). Please contact support.";

export function isSchemaMismatch(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" && SCHEMA_MISMATCH_CODES.has(code);
}

export class WhatsAppSchemaMismatchError extends Error {
  readonly code = "schema_mismatch";
  constructor() {
    super(WHATSAPP_SCHEMA_MISMATCH_MESSAGE);
  }
}

/** Logs the missing object (PostgreSQL's own message names it) — nothing else. */
export function logSchemaMismatch(where: string, err: unknown): void {
  const e = err as { code?: string; message?: string };
  console.error("whatsapp:schema_mismatch", {
    where,
    code: e.code ?? null,
    message: typeof e.message === "string" ? e.message.slice(0, 200) : null,
  });
}

/** Runs `fn`; a schema mismatch becomes WhatsAppSchemaMismatchError, anything else is rethrown unchanged. */
export async function withSchemaContract<T>(where: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isSchemaMismatch(err)) {
      logSchemaMismatch(where, err);
      throw new WhatsAppSchemaMismatchError();
    }
    throw err;
  }
}
