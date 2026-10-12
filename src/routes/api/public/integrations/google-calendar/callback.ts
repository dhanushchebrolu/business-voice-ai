import { createFileRoute } from "@tanstack/react-router";

/**
 * Google Calendar OAuth callback — the browser lands here directly from
 * Google's consent screen. Public route (no session cookie required to
 * reach it — Google's redirect is a plain browser navigation), but tenant
 * identity for what gets connected NEVER comes from this request's query
 * string: it comes exclusively from the oauth_states row that
 * connectGoogleCalendar (google-calendar.functions.ts) created when the
 * already-authenticated user clicked "Connect Google Calendar" — closing
 * exactly the "?organization_id=... establishes tenant identity" hole
 * spec section 58 warns against.
 *
 * GET /api/public/integrations/google-calendar/callback
 *   ?code=<Google authorization code>   (present on success)
 *   &state=<state issued by connectGoogleCalendar>   (always present)
 *   &error=<Google's own error code>    (present if the user denied consent)
 *
 * Browser binding: connectGoogleCalendar also set an HttpOnly state cookie
 * (oauth-state-cookie.server.ts). A state that does not match this
 * browser's cookie is rejected before the state is consumed or the code is
 * exchanged, and the cookie is cleared on every response.
 *
 * Always ends in a redirect back into the dashboard (never a raw JSON
 * response — this is a browser navigation, not an API call), carrying a
 * ?google_calendar=connected|error query param the /app/integrations page
 * reads to show a result banner.
 */
export const Route = createFileRoute("/api/public/integrations/google-calendar/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { clearOAuthStateCookieHeader } =
          await import("@/lib/google-calendar/oauth-state-cookie.server");
        const response = await handleCallback(request);
        // Every outcome, success or failure, clears the single-use state cookie.
        response.headers.append("Set-Cookie", clearOAuthStateCookieHeader());
        return response;
      },
    },
  },
});

async function handleCallback(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const googleError = url.searchParams.get("error");

  const { oauthStateMatchesCookie } =
    await import("@/lib/google-calendar/oauth-state-cookie.server");
  let redirectTo = "/app/integrations";
  if (!oauthStateMatchesCookie(request.headers.get("cookie"), state)) {
    console.warn("google_calendar_callback:state_cookie_mismatch");
    return redirectWith(redirectTo, "error", "invalid_state");
  }

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { consumeOAuthState, OAuthStateError } =
    await import("@/lib/google-calendar/oauth-state.server");

  try {
    const stateContext = await consumeOAuthState(supabaseAdmin, "google_calendar", state ?? "");
    redirectTo = stateContext.redirectTo ?? redirectTo;

    if (googleError) {
      return redirectWith(
        redirectTo,
        "error",
        googleError === "access_denied" ? "denied" : "google_error",
      );
    }
    if (!code) {
      return redirectWith(redirectTo, "error", "missing_code");
    }
    if (!stateContext.businessId) {
      return redirectWith(redirectTo, "error", "missing_business");
    }

    const { completeGoogleCalendarOAuth } =
      await import("@/lib/google-calendar/google-calendar-connection.server");
    const { connectionId } = await completeGoogleCalendarOAuth(supabaseAdmin, {
      organizationId: stateContext.organizationId,
      businessId: stateContext.businessId,
      code,
    });

    return redirectWith(redirectTo, "connected", undefined, connectionId);
  } catch (err) {
    if (err instanceof OAuthStateError) {
      return redirectWith(redirectTo, "error", "invalid_state");
    }
    const errorCode = (err as { code?: unknown } | null)?.code;
    if (errorCode === "NOT_CONFIGURED") {
      return redirectWith(redirectTo, "error", "not_configured");
    }
    // Only a code is logged — a provider message could echo request data.
    console.error("google_calendar_callback:failed", {
      code: typeof errorCode === "string" ? errorCode : "UNKNOWN",
    });
    return redirectWith(redirectTo, "error", "connection_failed");
  }
}

function redirectWith(
  basePath: string,
  status: "connected" | "error",
  reason?: string,
  connectionId?: string,
): Response {
  const url = new URL(basePath, "https://placeholder.invalid");
  url.searchParams.set("google_calendar", status);
  if (reason) url.searchParams.set("reason", reason);
  if (connectionId) url.searchParams.set("connection_id", connectionId);
  // Only the path + query is used (Location can be relative); the
  // placeholder origin above exists solely so URL() can parse/normalize
  // the query string safely.
  return new Response(null, { status: 302, headers: { Location: url.pathname + url.search } });
}
