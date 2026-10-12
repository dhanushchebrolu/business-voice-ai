/**
 * Shared timing/outcome diagnostics for every Supabase REST/RPC/Auth fetch
 * in the app (wired into client.ts, client.server.ts and auth-middleware.ts
 * — the three places that build the Supabase fetch implementation). This is
 * what lets a future "this page is stuck loading" report be diagnosed from
 * logs instead of re-derived from scratch: which operation, how long it
 * took, and whether it succeeded, errored, or timed out.
 *
 * Deliberately logs the URL PATH only, never the query string — PostgREST
 * filters (?phone=eq.+91..., ?email=eq....) live in the query string and can
 * carry contact/patient details that must never reach a log line.
 *
 * Response bodies, headers (including apikey/Authorization), and request
 * bodies are never logged. For failed responses, only the structured
 * error code, message, and hint are logged. These fields should not contain
 * credentials or request payloads.
 */

const SLOW_REQUEST_MS = 3_000;

function safeOperationLabel(input: RequestInfo | URL): string {
  try {
    const raw = typeof input === "string" || input instanceof URL ? input : input.url;

    return new URL(raw).pathname;
  } catch {
    return "unknown";
  }
}

export async function fetchWithTiming(
  label: string,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): Promise<Response> {
  const correlationId = Math.random().toString(36).slice(2, 10);
  const operation = safeOperationLabel(input);
  const startedAt = Date.now();

  try {
    const response = await fetch(input, init);
    const durationMs = Date.now() - startedAt;

    if (!response.ok) {
      let errorDetails:
        | {
            code?: string;
            message?: string;
            hint?: string;
          }
        | string;

      try {
        const body = (await response.clone().json()) as {
          code?: unknown;
          message?: unknown;
          hint?: unknown;
        };

        errorDetails = {
          ...(typeof body.code === "string" ? { code: body.code } : {}),
          ...(typeof body.message === "string" ? { message: body.message } : {}),
          ...(typeof body.hint === "string" ? { hint: body.hint } : {}),
        };
      } catch {
        errorDetails = "Could not parse Supabase error response";
      }

      console.error(`${label}:error`, {
        correlationId,
        operation,
        status: response.status,
        durationMs,
        errorDetails,
      });
    } else if (durationMs > SLOW_REQUEST_MS) {
      console.warn(`${label}:slow`, {
        correlationId,
        operation,
        durationMs,
      });
    }

    return response;
  } catch (err) {
    const durationMs = Date.now() - startedAt;

    const isAbort =
      err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");

    console.error(`${label}:${isAbort ? "timeout" : "network_error"}`, {
      correlationId,
      operation,
      durationMs,
    });

    throw err;
  }
}
