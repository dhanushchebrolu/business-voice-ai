import { createFileRoute } from "@tanstack/react-router";
import { mintMediaSessionToken } from "@/lib/telephony/media-session-token";

/**
 * Optional endpoint for an Exotel call-flow's Passthru applet step to call
 * mid-flow (before reaching the Voicebot Applet), so that applet's WSS URL
 * can carry a signed media-session token as one of its (max 3, ≤256-char)
 * custom parameters — see exotel-media-route.server.ts's header comment
 * and PHASE_D1_EXOTEL_FINAL_REPORT.md §20/§24 for the full design and its
 * verification status.
 *
 * KNOWN ORDERING RISK, stated plainly: a Passthru step commonly runs before
 * the call reaches "answered", but this endpoint can only mint a token for
 * a call_logs row that already exists (created by the Phase D telephony
 * webhook's own "ringing"/"answered" event). Whether a given Exotel
 * account's call-flow reaches this Passthru step late enough for that row
 * to already exist was NOT verified against a live account. If it hasn't,
 * this returns `{ token: null }` and the media route's mandatory
 * CallSid+`call_logs` check (which does not depend on this endpoint at
 * all) is still the actual authorization — this token is always an
 * additional factor, never a required one.
 */
export const Route = createFileRoute("/api/public/webhooks/exotel/media-token")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secret = process.env["EXOTEL_WEBHOOK_SECRET"];
        if (!secret) return new Response("Not configured", { status: 503 });

        const url = new URL(request.url);
        // Authenticated the same way the Exotel status webhook is (spec:
        // Exotel does not sign requests; a shared value configured in the
        // call-flow is the documented mechanism — see exotel-provider.ts).
        const provided = url.searchParams.get("verify_token");
        if (provided !== secret) return new Response("Unauthorized", { status: 401 });

        const callSid = url.searchParams.get("CallSid") ?? url.searchParams.get("call_sid");
        if (!callSid) return new Response(JSON.stringify({ token: null }), { status: 200 });

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { data: call } = await supabaseAdmin
          .from("call_logs")
          .select("id, organization_id")
          .eq("provider", "exotel")
          .eq("provider_call_id", callSid)
          .maybeSingle();
        if (!call) return new Response(JSON.stringify({ token: null }), { status: 200 });

        const token = mintMediaSessionToken({
          callId: call.id,
          providerCallId: callSid,
          organizationId: call.organization_id,
          exp: Math.floor(Date.now() / 1000) + 300,
        });
        return new Response(JSON.stringify({ token }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    },
  },
});
