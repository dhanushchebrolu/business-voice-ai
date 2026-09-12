import { createFileRoute } from "@tanstack/react-router";
import { constantTimeEquals } from "@/lib/constant-time-equals.server";

/**
 * The Sarvam client-context endpoint (Task #94) — what a Sarvam agent calls
 * mid-call to learn which business it's speaking for. See
 * sarvam-client-context.server.ts's module doc for the full security model
 * (tenant resolution, never a caller-supplied organization_id) and the
 * documented response schema; this file is only the HTTP boundary: auth,
 * rate limiting, and parameter parsing.
 *
 * GET /api/public/sarvam/client-context
 *   ?verify_token=<SARVAM_CONTEXT_SECRET>   (required)
 *   &phone_number=<E.164>                   (one of these three required)
 *   &connection_id=<sarvam connection id>
 *   &deployment_id=<sarvam deployment id>
 *
 * Responses:
 *   200 { ...SarvamClientContext }
 *   400 missing/invalid parameters
 *   401 verify_token missing or wrong
 *   404 no organization resolves from the supplied identifier(s), or the
 *       resolved organization has no business record yet
 *   429 rate limited
 *   503 SARVAM_CONTEXT_SECRET not configured on this deployment
 */
export const Route = createFileRoute("/api/public/sarvam/client-context")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const secret = process.env["SARVAM_CONTEXT_SECRET"];
        if (!secret) {
          console.error("sarvam_context:secret_not_configured");
          return new Response("Not configured", { status: 503 });
        }

        const url = new URL(request.url);
        const provided = url.searchParams.get("verify_token") ?? "";
        if (!provided || !constantTimeEquals(provided, secret)) {
          return new Response("Unauthorized", { status: 401 });
        }

        const phoneNumber = url.searchParams.get("phone_number") ?? undefined;
        const connectionId = url.searchParams.get("connection_id") ?? undefined;
        const deploymentId = url.searchParams.get("deployment_id") ?? undefined;
        if (!phoneNumber && !connectionId && !deploymentId) {
          return new Response("One of phone_number, connection_id, or deployment_id is required", {
            status: 400,
          });
        }

        const { checkSarvamContextRateLimit } = await import("@/lib/rate-limit.server");
        const rateLimitKey = deploymentId ?? connectionId ?? phoneNumber ?? "unknown";
        const decision = await checkSarvamContextRateLimit(rateLimitKey);
        if (!decision.allowed) {
          return new Response("Rate limited", {
            status: 429,
            headers: { "retry-after": String(decision.retryAfterSeconds) },
          });
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { resolveOrganizationForSarvamContext, buildSarvamClientContext } =
          await import("@/lib/sarvam-client-context.server");

        const organizationId = await resolveOrganizationForSarvamContext(supabaseAdmin, {
          phoneNumber,
          connectionId,
          deploymentId,
        });
        // Logged without secrets: the resolved organization id and which
        // identifier resolved it, never the verify_token.
        console.log(
          "sarvam_context:resolve",
          organizationId ?? "unresolved",
          phoneNumber ? "phone_number" : connectionId ? "connection_id" : "deployment_id",
        );
        if (!organizationId) {
          return new Response("Not found", { status: 404 });
        }

        const context = await buildSarvamClientContext(supabaseAdmin, organizationId);
        if (!context) {
          return new Response("Not found", { status: 404 });
        }

        return new Response(JSON.stringify(context), {
          headers: { "content-type": "application/json" },
        });
      },
    },
  },
});
