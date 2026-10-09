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
 */

export function newCorrelationId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export class DiagnosedStepError extends Error {
  readonly operation: string;
  readonly correlationId: string;
  readonly code: string | undefined;

  constructor(operation: string, correlationId: string, code: string | undefined) {
    super(
      code
        ? `Could not load this — step "${operation}" failed (code ${code}, ref ${correlationId}).`
        : `Could not load this — step "${operation}" failed (ref ${correlationId}).`,
    );
    this.name = "DiagnosedStepError";
    this.operation = operation;
    this.correlationId = correlationId;
    this.code = code;
  }
}

function sanitizedCode(error: unknown): string | undefined {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0 && code.length <= 20) return code;
  }
  return undefined;
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
    // The full error (name/message/stack) is logged server-side only —
    // never forwarded to the client — so it can carry whatever detail is
    // useful for debugging without that detail ever reaching the browser.
    console.error(`${logPrefix}:step_failed`, {
      correlationId,
      operation,
      durationMs,
      code,
      error,
    });
    throw new DiagnosedStepError(operation, correlationId, code);
  }
}
