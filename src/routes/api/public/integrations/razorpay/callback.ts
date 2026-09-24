import { createFileRoute } from "@tanstack/react-router";

/**
 * Razorpay OAuth callback — the browser lands here directly from
 * Razorpay's consent screen. Public route (no session cookie required to
 * reach it — Razorpay's redirect is a plain browser navigation), but
 * tenant identity for what gets connected NEVER comes from this request's
 * query string: it comes exclusively from the oauth_states row that
 * startRazorpayConnection/reconnectRazorpayConnection (razorpay.functions.ts)
 * created when the already-authenticated user clicked "Connect Razorpay" —
 * closing exactly the "?organization_id=... establishes tenant identity"
 * hole spec section 58 warns against. Mirrors
 * google-calendar/callback.ts's structure exactly.
 *
 * GET /api/public/integrations/razorpay/callback
 *   ?code=<Razorpay authorization code>   (present on success)
 *   &state=<state issued by startRazorpayConnection>   (always present)
 *   &error=<Razorpay's own error code>    (present if the user denied consent)
 *
 * Always ends in a redirect back into the dashboard (never a raw JSON
 * response — this is a browser navigation, not an API call), carrying a
 * ?razorpay=connected|error query param the /app/integrations page reads
 * to show a result banner.
 */
export const Route = createFileRoute("/api/public/integrations/razorpay/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const razorpayError = url.searchParams.get("error");

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { consumeOAuthState, OAuthStateError } =
          await import("@/lib/google-calendar/oauth-state.server");

        let redirectTo = "/app/integrations";
        try {
          const stateContext = await consumeOAuthState(supabaseAdmin, "razorpay", state ?? "");
          redirectTo = stateContext.redirectTo ?? redirectTo;

          if (razorpayError) {
            return redirectWith(
              redirectTo,
              "error",
              razorpayError === "access_denied" ? "denied" : "razorpay_error",
            );
          }
          if (!code) {
            return redirectWith(redirectTo, "error", "missing_code");
          }
          if (!stateContext.businessId) {
            return redirectWith(redirectTo, "error", "missing_business");
          }

          const { completeRazorpayOAuth } =
            await import("@/lib/razorpay/razorpay-connection.server");
          const { connectionId } = await completeRazorpayOAuth(supabaseAdmin, {
            organizationId: stateContext.organizationId,
            businessId: stateContext.businessId,
            code,
          });

          return redirectWith(redirectTo, "connected", undefined, connectionId);
        } catch (err) {
          if (err instanceof OAuthStateError) {
            return redirectWith(redirectTo, "error", "invalid_state");
          }
          console.error("razorpay_callback:failed", err instanceof Error ? err.message : err);
          return redirectWith(redirectTo, "error", "connection_failed");
        }
      },
    },
  },
});

function redirectWith(
  basePath: string,
  status: "connected" | "error",
  reason?: string,
  connectionId?: string,
): Response {
  const url = new URL(basePath, "https://placeholder.invalid");
  url.searchParams.set("razorpay", status);
  if (reason) url.searchParams.set("reason", reason);
  if (connectionId) url.searchParams.set("connection_id", connectionId);
  // Only the path + query is used (Location can be relative); the
  // placeholder origin above exists solely so URL() can parse/normalize
  // the query string safely.
  return new Response(null, { status: 302, headers: { Location: url.pathname + url.search } });
}
