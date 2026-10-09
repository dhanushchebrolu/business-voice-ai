/**
 * Structured diagnostics for a server function's individual steps —
 * written for getCalendarDayView (calendar-dashboard.functions.ts), whose
 * generic "Could not load this day's calendar." client-side fallback gave
 * no way to tell which operation actually failed from a deployed Worker.
 *
 * Every wrapped step gets ONE correlation id (shared across the whole
 * request) logged server-side with the operation name, elapsed time, and
 * a SANITIZED error code (a Postgres SQLSTATE / PostgREST code — never the
 * raw message, which can carry `details`/`hint` text, and never any row
 * data) — safe to search Cloudflare Worker logs for. The error that
 * reaches the client embeds the same operation name + correlation id
 * directly in its `message`, which is the one thing proven (by this
 * session's own serialization testing) to survive the server-function
 * response round trip reliably — so the failing step is always visible in
 * the UI's ErrorState, not just in logs the client can't see.
 *
 * PostgREST's PGRST205 ("Could not find the table '<schema.table>' in the
 * schema cache") names the table in its own message. A table/schema name
 * is structure, never patient or secret data, so — for this one code only
 * — that name is extracted and surfaced in the client-visible message too
 * (every other error stays code-only); this is what let a single, non-
 * granular "fetch_schedule_and_sync_state" step be narrowed to the exact
 * relation once it was split into one timedStep per table (see
 * calendar-dashboard.functions.ts) instead of guessing from the code alone.
 */

export function newCorrelationId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export class DiagnosedStepError extends Error {
  readonly operation: string;
  readonly correlationId: string;
  readonly code: string | undefined;
  readonly missingTable: string | undefined;

  constructor(
    operation: string,
    correlationId: string,
    code: string | undefined,
    missingTable: string | undefined,
  ) {
    const detail = [
      missingTable ? `table "${missingTable}" not in schema cache` : null,
      code ? `code ${code}` : null,
      `ref ${correlationId}`,
    ]
      .filter(Boolean)
      .join(", ");
    super(`Could not load this — step "${operation}" failed (${detail}).`);
    this.name = "DiagnosedStepError";
    this.operation = operation;
    this.correlationId = correlationId;
    this.code = code;
    this.missingTable = missingTable;
  }
}

function sanitizedCode(error: unknown): string | undefined {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0 && code.length <= 20) return code;
  }
  return undefined;
}

/**
 * PostgREST's documented PGRST205 message shape is exactly
 * `Could not find the table '<schema.table>' in the schema cache` — this
 * only ever matches that one, structure-only message; nothing here can
 * capture row/patient data.
 */
function missingTableFromPgrst205(error: unknown, code: string | undefined): string | undefined {
  if (code !== "PGRST205") return undefined;
  if (!error || typeof error !== "object" || !("message" in error)) return undefined;
  const message = (error as { message?: unknown }).message;
  if (typeof message !== "string") return undefined;
  const match = /table '([\w.]+)' in the schema cache/.exec(message);
  return match?.[1];
}

export async function timedStep<T>(
  operation: string,
  correlationId: string,
  logPrefix: string,
  fn: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  try {
    const result = await fn();
    const durationMs = Date.now() - startedAt;
    if (durationMs > 3_000) {
      console.warn(`${logPrefix}:slow_step`, { correlationId, operation, durationMs });
    }
    return result;
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const code = sanitizedCode(error);
    const missingTable = missingTableFromPgrst205(error, code);
    // The full error (name/message/stack) is logged server-side only —
    // never forwarded to the client — so it can carry whatever detail is
    // useful for debugging without that detail ever reaching the browser.
    console.error(`${logPrefix}:step_failed`, {
      correlationId,
      operation,
      durationMs,
      code,
      missingTable,
      error,
    });
    throw new DiagnosedStepError(operation, correlationId, code, missingTable);
  }
}
