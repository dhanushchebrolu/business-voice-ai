import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertPlatformAdmin } from "@/lib/platform-admin.server";

/**
 * Loads a Sarvam call's recording on demand. Nothing is stored: Sarvam's
 * recordings API returns audio bytes, so the bytes are proxied to the
 * authorized viewer and dropped.
 *
 * Authorization, server-side: the caller must be able to read the call under
 * row-level security (a member of the call's organization), or be a platform
 * admin. The call's organization, number, agent and Sarvam app are then read
 * with the service role and must all belong to that same organization.
 */

const MAX_RECORDING_BYTES = 15 * 1024 * 1024;

export const getCallRecording = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { callId: string }) => {
    if (!input?.callId || !/^[0-9a-f-]{36}$/i.test(input.callId))
      throw new Error("callId is required");
    return input;
  })
  .handler(async ({ data, context }) => {
    const { data: visible } = await context.supabase
      .from("call_logs")
      .select("id")
      .eq("id", data.callId)
      .maybeSingle();
    if (!visible) await assertPlatformAdmin(context.supabase, context.userId, "customers.read");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: call } = await supabaseAdmin
      .from("call_logs")
      .select(
        "id, organization_id, provider, status, provider_call_id, provider_metadata, phone_number_id, started_at",
      )
      .eq("id", data.callId)
      .maybeSingle();
    if (!call) throw new Error("Call not found.");
    if (call.provider !== "sarvam")
      throw new Error("Recordings are only available for Sarvam calls.");
    if (call.status !== "completed")
      return { available: false as const, reason: "Only connected calls have a recording." };

    const { data: number } = call.phone_number_id
      ? await supabaseAdmin
          .from("phone_numbers")
          .select("organization_id, agent_config_id")
          .eq("id", call.phone_number_id)
          .maybeSingle()
      : { data: null };
    const { data: agent } = number?.agent_config_id
      ? await supabaseAdmin
          .from("agent_configs")
          .select("organization_id, sarvam_app_id")
          .eq("id", number.agent_config_id)
          .maybeSingle()
      : { data: null };
    if (
      !agent?.sarvam_app_id ||
      number?.organization_id !== call.organization_id ||
      agent.organization_id !== call.organization_id
    )
      return { available: false as const, reason: "This call's Sarvam agent is no longer mapped." };

    const { getTelephonyAdapter } = await import("@/lib/telephony.server");
    const { SarvamTelephonyAdapter } = await import("@/lib/telephony/sarvam-provider.server");
    const adapter = getTelephonyAdapter("sarvam");
    if (!adapter || !(adapter instanceof SarvamTelephonyAdapter))
      throw new Error("Sarvam is not configured on this server.");

    const meta = (call.provider_metadata ?? {}) as Record<string, unknown>;
    let interactionId = typeof meta["interaction_id"] === "string" ? meta["interaction_id"] : null;
    if (!interactionId && call.provider_call_id) {
      const started = new Date(call.started_at);
      const attempt = await adapter.findAttempt(
        agent.sarvam_app_id,
        call.provider_call_id,
        new Date(started.getTime() - 10 * 60 * 1000),
        new Date(Math.min(Date.now(), started.getTime() + 6 * 60 * 60 * 1000)),
      );
      interactionId = attempt?.interactionId ?? null;
    }
    if (!interactionId)
      return { available: false as const, reason: "Sarvam has no conversation id for this call." };

    const recording = await adapter.getRecording(
      agent.sarvam_app_id,
      interactionId,
      MAX_RECORDING_BYTES,
    );
    console.info("call_recording:served", {
      callId: call.id,
      userId: context.userId,
      found: Boolean(recording),
    });
    if (!recording)
      return { available: false as const, reason: "Sarvam has no recording for this call." };
    return {
      available: true as const,
      contentType: recording.contentType,
      base64: Buffer.from(recording.bytes).toString("base64"),
    };
  });
