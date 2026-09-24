import { createFileRoute } from "@tanstack/react-router";

/**
 * Instagram OAuth callback — the browser lands here directly from Meta's
 * consent screen. Public route (no session cookie required — this is a
 * plain browser navigation), but tenant identity for what gets connected
 * NEVER comes from this request's query string: it comes exclusively from
 * the oauth_states row startInstagramConnection created when the
 * already-authenticated user clicked "Connect Instagram" — byte-for-byte
 * the same pattern as the Google Calendar callback route (which this file
 * mirrors), reusing the same generic oauth_states table with
 * provider="instagram".
 *
 * GET /api/public/integrations/instagram/callback
 *   ?code=<Meta authorization code>   (present on success)
 *   &state=<state issued by startInstagramConnection>   (always present)
 *   &error=<Meta's own error code>    (present if the user denied consent)
 *
 * Always ends in a redirect back into the dashboard, carrying an
 * ?instagram=connected|error query param the /app/integrations page reads
 * to show a result banner.
 */
export const Route = createFileRoute("/api/public/integrations/instagram/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const metaError = url.searchParams.get("error");

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { consumeOAuthState, OAuthStateError } =
          await import("@/lib/google-calendar/oauth-state.server");

        let redirectTo = "/app/integrations";
        try {
          const stateContext = await consumeOAuthState(supabaseAdmin, "instagram", state ?? "");
          redirectTo = stateContext.redirectTo ?? redirectTo;

          if (metaError) {
            return redirectWith(
              redirectTo,
              "error",
              metaError === "access_denied" ? "denied" : "meta_error",
            );
          }
          if (!code) {
            return redirectWith(redirectTo, "error", "missing_code");
          }

          const { completeInstagramOAuth } =
            await import("@/lib/instagram/instagram-connection.server");
          const result = await completeInstagramOAuth(supabaseAdmin, {
            organizationId: stateContext.organizationId,
            businessId: stateContext.businessId,
            code,
          });

          await supabaseAdmin.from("customer_events").insert({
            organization_id: stateContext.organizationId,
            kind:
              result.status === "connected" ? "instagram_connected" : "instagram_connect_attempted",
            title:
              result.status === "connected"
                ? "Instagram connected"
                : "Instagram connection needs attention",
            detail: `${result.username ?? result.instagramBusinessAccountId} — status: ${result.status}`,
            actor_email: null,
            metadata: { connection_id: result.connectionId },
          });

          return redirectWith(
            redirectTo,
            result.status === "error" ? "error" : "connected",
            result.status === "needs_attention" ? "needs_attention" : undefined,
            result.connectionId,
          );
        } catch (err) {
          if (err instanceof OAuthStateError) {
            return redirectWith(redirectTo, "error", "invalid_state");
          }
          const { InstagramConnectionError } =
            await import("@/lib/instagram/instagram-connection.server");
          if (err instanceof InstagramConnectionError) {
            return redirectWith(redirectTo, "error", err.code.toLowerCase());
          }
          console.error("instagram_callback:failed", err instanceof Error ? err.message : err);
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
  url.searchParams.set("instagram", status);
  if (reason) url.searchParams.set("reason", reason);
  if (connectionId) url.searchParams.set("connection_id", connectionId);
  return new Response(null, { status: 302, headers: { Location: url.pathname + url.search } });
}
