import { createFileRoute } from "@tanstack/react-router";
import { constantTimeEquals } from "@/lib/constant-time-equals.server";

/**
 * TEMPORARY diagnostic endpoint for Sarvam's on_start API Tool — see
 * src/lib/sarvam-call-start-diagnostic.ts. Logs masked call metadata and
 * whether `agent_phone_number` matches an active Sarvam number on file.
 * Read-only: never writes to the database.
 *
 * POST /api/public/sarvam/diagnostic-call-start
 *   Authorization: Bearer <SARVAM_CONTEXT_SECRET>
 *   Content-Type: application/json
 *   { agent_phone_number, app_id, app_version, interaction_id,
 *     campaign_id, user_identifier, user_identifier_type }
 *
 * 200 {"status":"ok"} · 400 bad body · 401 bad token · 413 too large ·
 * 503 SARVAM_CONTEXT_SECRET not configured
 */
const MAX_BODY_BYTES = 16 * 1024;

export const Route = createFileRoute("/api/public/sarvam/diagnostic-call-start")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secret = process.env["SARVAM_CONTEXT_SECRET"];
        if (!secret) {
          console.error("sarvam_call_start_diag:secret_not_configured");
          return new Response("Not configured", { status: 503 });
        }

        const auth = request.headers.get("authorization") ?? "";
        const provided = auth.startsWith("Bearer ") ? auth.slice(7) : "";
        if (!provided || !constantTimeEquals(provided, secret)) {
          return new Response("Unauthorized", { status: 401 });
        }

        const raw = await request.text();
        if (raw.length > MAX_BODY_BYTES) return new Response("Payload too large", { status: 413 });

        const { summarizeCallStart } = await import("@/lib/sarvam-call-start-diagnostic");
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = null;
        }
        const summary = summarizeCallStart(parsed);
        if (!summary) return new Response("Body must be a JSON object", { status: 400 });

        // The actual question: does the value resolve to a number we own?
        let matchedOrganizationId: string | null = null;
        if (summary.agent_phone_e164) {
          const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
          const { resolveOrganizationForSarvamContext } =
            await import("@/lib/sarvam-client-context.server");
          matchedOrganizationId = await resolveOrganizationForSarvamContext(supabaseAdmin, {
            phoneNumber: (parsed as { agent_phone_number: string }).agent_phone_number.trim(),
          });
        }

        console.log(
          "sarvam_call_start_diag",
          JSON.stringify({
            ...summary,
            matched_active_sarvam_number: matchedOrganizationId !== null,
            matched_organization_id: matchedOrganizationId,
          }),
        );

        return new Response(JSON.stringify({ status: "ok" }), {
          headers: { "content-type": "application/json" },
        });
      },
    },
  },
});
