import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * Starts an AI (LiveKit SIP) outbound call for the signed-in user. All
 * authorization lives in startOutboundAgentCall (outbound.server.ts): the
 * organization comes from the number row, the caller must be owner/admin of
 * that organization, then rate limits, wallet, entitlement gate, call row,
 * dispatch. This wrapper only supplies the authenticated user id and the
 * production dependencies.
 */
interface StartAgentOutboundCallInput {
  phoneNumberId: string;
  toE164: string;
  /** A UUID the client generates once per user action and reuses on retry. */
  idempotencyKey: string;
}

export const startAgentOutboundCall = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: StartAgentOutboundCallInput) => {
    if (
      typeof input?.phoneNumberId !== "string" ||
      typeof input?.toE164 !== "string" ||
      typeof input?.idempotencyKey !== "string"
    )
      throw new Error("phoneNumberId, toE164 and idempotencyKey are required");
    // Only these three fields reach the handler; anything else is dropped.
    return {
      phoneNumberId: input.phoneNumberId,
      toE164: input.toE164,
      idempotencyKey: input.idempotencyKey,
    };
  })
  .handler(async ({ data, context }) => {
    const [{ startOutboundAgentCall }, { defaultSessionDeps }, rl, lk, guard] = await Promise.all([
      import("@/lib/voice-agent/outbound.server"),
      import("@/lib/voice-agent/sessions.server"),
      import("@/lib/voice-agent/rate-limits"),
      import("@/lib/voice-agent/livekit-api"),
      import("@/lib/telephony-guard.server"),
    ]);
    const session = await defaultSessionDeps();
    const limiter = await rl.defaultVoiceAgentLimiter();
    const env = (n: string) => process.env[n];
    const result = await startOutboundAgentCall(
      {
        session,
        env,
        memberRole: async (userId, organizationId) => {
          const { data: m, error } = await session.db
            .from("organization_members")
            .select("role")
            .eq("user_id", userId)
            .eq("organization_id", organizationId)
            .maybeSingle();
          if (error) throw error;
          return m?.role ?? null;
        },
        canAfford: (orgId) => guard.walletCanAffordOutbound(orgId),
        rateLimit: (scope, key) => limiter.shared(scope, key),
        dispatch: async (p) => {
          await lk.createAgentDispatch({
            url: env("LIVEKIT_URL")!,
            apiKey: env("LIVEKIT_API_KEY")!,
            apiSecret: env("LIVEKIT_API_SECRET")!,
            allowedHosts: lk.allowedLiveKitHosts(env("LIVEKIT_ALLOWED_HOSTS")),
            ...p,
          });
        },
      },
      // userId last: it always comes from the verified session, never input.
      { ...data, userId: context.userId },
    );
    if (!result.ok) throw new Error(result.message);
    // status "pending": the dispatch outcome is unknown; the call may still
    // start. Retrying with the SAME idempotencyKey is safe.
    return { callId: result.callId, status: result.status, replayed: result.replayed };
  });
