import { createFileRoute } from "@tanstack/react-router";
import { constantTimeEquals } from "@/lib/constant-time-equals.server";

/**
 * TEMPORARY diagnostic endpoint for Sarvam's on_start API Tool — see
 * src/lib/sarvam-call-start-diagnostic.ts. Logs masked phone numbers and
 * the app/interaction IDs only. Never touches the database.
 *
 * POST /api/public/sarvam/diagnostic-call-start
 *   Authorization: Bearer <SARVAM_CONTEXT_SECRET>
 *   Content-Type: application/json
 *   { agent_phone_number, user_identifier, app_id, app_version, interaction_id }
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

        console.log("sarvam_call_start_diag", JSON.stringify(summary));

        return new Response(JSON.stringify({ status: "ok" }), {
          headers: { "content-type": "application/json" },
        });
      },
    },
  },
});
