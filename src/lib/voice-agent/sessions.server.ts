/**
 * klyro's side of a call handled by the LiveKit voice agent (Vobiz SIP ->
 * LiveKit SIP -> services/voice-agent). The agent handles audio and the
 * conversation; everything that decides who the caller may reach, what is
 * true about the business and what happens to bookings and money stays
 * here, reusing the code the answer-URL path already uses:
 *
 *   resolveActivePhoneNumberByDestination + checkTelephonyAccess
 *       the SAME number resolution and entitlement/billing gate as
 *       /api/public/webhooks/vobiz-answer (the SIP path must not bypass it)
 *   loadSnapshot / buildAgentInstructions
 *       business facts the agent may state (services, prices, hours)
 *   resolveAvailableTools + executeAiTool
 *       the tool registry, default-deny per agent capability, tenant ids
 *       ALWAYS from the call row, never from the agent or the model
 *   finalizeCallBilling
 *       idempotent per call; triggered only by a SIGNED LiveKit webhook
 *
 * The call row is call_logs with provider "livekit_sip" and
 * provider_call_id = LiveKit's `sip.callID` (unique per provider, so a
 * retried session start can never create a second row). No schema change:
 * call_logs.provider is free text (20260904120000).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

type Client = SupabaseClient<Database>;
type CallLog = Database["public"]["Tables"]["call_logs"]["Row"];

export const SIP_PROVIDER = "livekit_sip";
const TERMINAL = ["completed", "failed", "busy", "no_answer", "cancelled"];
/** Tools the voice agent may ask for (still filtered by each agent's capabilities). */
export const VOICE_AGENT_TOOLS = [
  "check_calendar_availability",
  "book_appointment",
  "reschedule_appointment",
] as const;
export type VoiceAgentTool = (typeof VOICE_AGENT_TOOLS)[number];

export interface SessionDeps {
  db: Client;
  resolveNumber: (
    provider: string,
    e164: string,
  ) => Promise<{
    id: string;
    organization_id: string | null;
    business_id: string | null;
    agent_config_id: string | null;
    e164: string;
  } | null>;
  checkAccess: (
    orgId: string,
    phoneNumberId: string,
    direction: "inbound" | "outbound",
  ) => Promise<{ allowed: boolean; reason: string | null }>;
  loadBusiness: (businessId: string) => Promise<SessionBusiness>;
  availableTools: (orgId: string, businessId: string) => Promise<string[]>;
  executeTool: (
    ctx: {
      organizationId: string;
      businessId: string;
      agentConfigId: string | null;
      callId: string;
    },
    name: string,
    input: Record<string, unknown>,
  ) => Promise<{ content: string; isError?: boolean }>;
  finalizeBilling: (
    call: Pick<CallLog, "id" | "organization_id" | "direction">,
    seconds: number,
  ) => Promise<unknown>;
  now: () => Date;
}

export interface SessionBusiness {
  name: string;
  timezone: string;
  country: string | null;
  currency: string;
  services: { id: string; name: string; price: number | null; durationMinutes: number | null }[];
  agentName: string;
  primaryLanguage: string;
  extraLanguages: string[];
  greetings: Record<string, string>;
  voiceId: string;
  speakingPace: number;
  instructions: string;
}

export interface StartSessionInput {
  sipCallId: string;
  roomName: string;
  /** The number the caller dialled (LiveKit `sip.trunkPhoneNumber`), E.164. */
  calledNumber: string;
  /** Caller ID as LiveKit received it (`sip.phoneNumber`), or null when withheld. */
  callerNumber: string | null;
  direction: "inbound" | "outbound";
  /** Outbound only: the call_logs row klyro created when it authorised the dial. */
  outboundCallLogId?: string | undefined;
}

export type StartSessionResult =
  | {
      allowed: true;
      callId: string;
      business: SessionBusiness;
      tools: string[];
      callerNumber: string | null;
    }
  | {
      allowed: false;
      reason: "unknown_number" | "not_entitled" | "invalid_outbound" | "call_ended";
      callId: string | null;
    };

const E164 = /^\+[1-9]\d{6,14}$/;

export async function startSipSession(
  deps: SessionDeps,
  input: StartSessionInput,
): Promise<StartSessionResult> {
  const caller = input.callerNumber && E164.test(input.callerNumber) ? input.callerNumber : null;

  if (input.direction === "outbound") {
    // Outbound: klyro authorised this dial earlier (prepareOutboundSipCall);
    // the row is the only proof. It must be ours, outbound, and unanswered.
    if (!input.outboundCallLogId)
      return { allowed: false, reason: "invalid_outbound", callId: null };
    const { data: call } = await deps.db
      .from("call_logs")
      .select("*")
      .eq("id", input.outboundCallLogId)
      .eq("provider", SIP_PROVIDER)
      .eq("direction", "outbound")
      .maybeSingle();
    if (!call || !call.business_id)
      return { allowed: false, reason: "invalid_outbound", callId: null };
    if (TERMINAL.includes(call.status))
      return { allowed: false, reason: "call_ended", callId: call.id };
    await deps.db
      .from("call_logs")
      .update({
        provider_call_id: input.sipCallId,
        status: "answered",
        answered_at: deps.now().toISOString(),
      })
      .eq("id", call.id)
      .is("provider_call_id", null);
    const business = await deps.loadBusiness(call.business_id);
    const tools = await deps.availableTools(call.organization_id, call.business_id);
    return { allowed: true, callId: call.id, business, tools, callerNumber: caller };
  }

  const number = E164.test(input.calledNumber)
    ? await deps.resolveNumber("vobiz", input.calledNumber)
    : null;
  if (!number || !number.organization_id || !number.business_id) {
    return { allowed: false, reason: "unknown_number", callId: null };
  }
  const gate = await deps.checkAccess(number.organization_id, number.id, "inbound");
  const nowIso = deps.now().toISOString();

  // Idempotent on (provider, provider_call_id): a retried session start for
  // the same SIP call returns the same row.
  const { data: inserted, error } = await deps.db
    .from("call_logs")
    .insert({
      organization_id: number.organization_id,
      business_id: number.business_id,
      phone_number_id: number.id,
      provider: SIP_PROVIDER,
      provider_call_id: input.sipCallId,
      direction: "inbound",
      caller_number: caller,
      destination_number: number.e164,
      status: gate.allowed ? "answered" : "failed",
      failure_reason: gate.allowed ? null : gate.reason,
      started_at: nowIso,
      answered_at: gate.allowed ? nowIso : null,
      ended_at: gate.allowed ? null : nowIso,
      provider_metadata: { livekit_room: input.roomName, transport: "sip" } as never,
    })
    .select("*")
    .single();
  let call: CallLog | null = inserted ?? null;
  if (error) {
    if ((error as { code?: string }).code !== "23505") throw error;
    const { data: existing } = await deps.db
      .from("call_logs")
      .select("*")
      .eq("provider", SIP_PROVIDER)
      .eq("provider_call_id", input.sipCallId)
      .maybeSingle();
    call = existing ?? null;
  }
  if (!call) throw new Error("call_log_unavailable");
  if (!gate.allowed || call.status === "failed")
    return { allowed: false, reason: "not_entitled", callId: call.id };
  if (TERMINAL.includes(call.status))
    return { allowed: false, reason: "call_ended", callId: call.id };

  const business = await deps.loadBusiness(number.business_id);
  const tools = await deps.availableTools(number.organization_id, number.business_id);
  return { allowed: true, callId: call.id, business, tools, callerNumber: caller };
}

export type ToolCallResult =
  | { ok: true; content: string; isError: boolean }
  | { ok: false; reason: "unknown_call" | "call_ended" | "tool_not_allowed" | "invalid_input" };

/**
 * Runs one business tool for an active SIP call. The tenant (organization,
 * business, agent) comes from the call row; any tenant-looking field in the
 * input is stripped before the registry sees it, and the registry itself
 * also ignores them (ai-tools.server.ts SECURITY BOUNDARY).
 */
export async function runSessionTool(
  deps: SessionDeps,
  callId: string,
  tool: string,
  input: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!(VOICE_AGENT_TOOLS as readonly string[]).includes(tool))
    return { ok: false, reason: "tool_not_allowed" };
  if (!input || typeof input !== "object" || Array.isArray(input))
    return { ok: false, reason: "invalid_input" };
  const { data: call } = await deps.db
    .from("call_logs")
    .select("*")
    .eq("id", callId)
    .eq("provider", SIP_PROVIDER)
    .maybeSingle();
  if (!call || !call.business_id) return { ok: false, reason: "unknown_call" };
  if (TERMINAL.includes(call.status)) return { ok: false, reason: "call_ended" };
  const allowed = await deps.availableTools(call.organization_id, call.business_id);
  if (!allowed.includes(tool)) return { ok: false, reason: "tool_not_allowed" };
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (/^(organization|org|business|agent|tenant|call)_?id$/i.test(k)) continue;
    clean[k] = v;
  }
  // The agent config is the one currently assigned to the number the call came in on.
  let agentConfigId: string | null = null;
  if (call.phone_number_id) {
    const { data: pn } = await deps.db
      .from("phone_numbers")
      .select("agent_config_id, organization_id")
      .eq("id", call.phone_number_id)
      .maybeSingle();
    if (pn && pn.organization_id === call.organization_id)
      agentConfigId = pn.agent_config_id ?? null;
  }
  const out = await deps.executeTool(
    {
      organizationId: call.organization_id,
      businessId: call.business_id,
      agentConfigId,
      callId: call.id,
    },
    tool,
    clean,
  );
  return { ok: true, content: out.content, isError: out.isError === true };
}

export interface EndSessionInput {
  callId: string;
  reason: string;
  /** Short, redacted summary only — never the full transcript. */
  summary?: string | undefined;
  language?: string | undefined;
  outcome?: string | undefined;
}

/**
 * The agent's own report that its session ended. It is NOT trusted for
 * billing (the agent could be wrong or compromised): it only records the
 * summary/outcome. Billing is driven by the signed LiveKit webhook below.
 */
export async function endSipSession(
  deps: SessionDeps,
  input: EndSessionInput,
): Promise<{ ok: boolean }> {
  const { data: call } = await deps.db
    .from("call_logs")
    .select("id, status")
    .eq("id", input.callId)
    .eq("provider", SIP_PROVIDER)
    .maybeSingle();
  if (!call) return { ok: false };
  const patch: Database["public"]["Tables"]["call_logs"]["Update"] = {};
  if (input.summary) patch.summary = input.summary.slice(0, 2000);
  if (input.language) patch.language = input.language.slice(0, 16);
  if (input.outcome) patch.outcome = input.outcome.slice(0, 64);
  if (Object.keys(patch).length) await deps.db.from("call_logs").update(patch).eq("id", call.id);
  return { ok: true };
}

/**
 * The SIP caller left the LiveKit room (signed `participant_left` webhook).
 * Marks the call completed and bills the duration LiveKit measured, once:
 * finalizeCallBilling is idempotent per call (debit_wallet_for_call), and
 * the webhook itself is de-duplicated by the caller (webhook_events).
 */
export async function completeSipCallFromLiveKit(
  deps: SessionDeps,
  p: { sipCallId: string; seconds: number },
): Promise<{ handled: boolean; callId?: string }> {
  const { data: call } = await deps.db
    .from("call_logs")
    .select("*")
    .eq("provider", SIP_PROVIDER)
    .eq("provider_call_id", p.sipCallId)
    .maybeSingle();
  if (!call) return { handled: false };
  const seconds = Math.max(0, Math.min(Math.round(p.seconds), 6 * 3600));
  if (!TERMINAL.includes(call.status)) {
    await deps.db
      .from("call_logs")
      .update({
        status: "completed",
        ended_at: deps.now().toISOString(),
        duration_seconds: seconds,
      })
      .eq("id", call.id);
  }
  if (call.status !== "failed") await deps.finalizeBilling(call, seconds);
  return { handled: true, callId: call.id };
}

/**
 * Safety net for a lost LiveKit webhook: SIP calls still open long after
 * any call could last are closed as failed with failure_reason
 * "livekit_end_event_missing" and are NOT billed — there is no signed
 * duration to bill from. Operations reconcile them by hand (LiveKit's room
 * history / Vobiz CDRs). Run from the cron route; idempotent.
 */
export async function reconcileStaleSipCalls(
  deps: SessionDeps,
  p: { olderThanMinutes: number; limit?: number },
): Promise<{ closed: number }> {
  const cutoff = new Date(deps.now().getTime() - p.olderThanMinutes * 60_000).toISOString();
  const { data } = await (deps.db
    .from("call_logs")
    .select("id, status, started_at")
    .eq("provider", SIP_PROVIDER)
    .in("status", ["initiated", "ringing", "answered", "in_progress"])
    .lt("started_at", cutoff)
    .limit(p.limit ?? 200) as unknown as Promise<{ data: { id: string }[] | null }>);
  let closed = 0;
  for (const row of data ?? []) {
    await deps.db
      .from("call_logs")
      .update({
        status: "failed",
        failure_reason: "livekit_end_event_missing",
        ended_at: deps.now().toISOString(),
      })
      .eq("id", row.id)
      .in("status", ["initiated", "ringing", "answered", "in_progress"]);
    closed++;
  }
  if (closed) console.warn("voice_agent:stale_sip_calls_closed", { closed });
  return { closed };
}

/**
 * Replay-protection records (webhook_events, provider "voice_agent_request")
 * are only needed for the signature window (60 s); keep one day for audit,
 * then delete them. Touches no other provider's rows.
 */
export async function pruneVoiceAgentNonces(
  deps: SessionDeps,
  p: { olderThanHours: number },
): Promise<void> {
  const cutoff = new Date(deps.now().getTime() - p.olderThanHours * 3_600_000).toISOString();
  await (deps.db
    .from("webhook_events")
    .delete()
    .eq("provider", "voice_agent_request")
    .lt("created_at", cutoff) as unknown as Promise<unknown>);
}

/**
 * Authorises an outbound SIP call before anything is dialled: the same
 * entitlement gate as every other outbound call, and the call row created
 * first so the agent's session start can prove the dial was authorised.
 */
export async function prepareOutboundSipCall(
  deps: SessionDeps,
  p: { organizationId: string; phoneNumberId: string; toNumber: string },
): Promise<{ ok: true; callId: string; fromNumber: string } | { ok: false; reason: string }> {
  if (!E164.test(p.toNumber)) return { ok: false, reason: "invalid_destination" };
  const { data: number } = await deps.db
    .from("phone_numbers")
    .select("id, organization_id, business_id, e164, status")
    .eq("id", p.phoneNumberId)
    .maybeSingle();
  if (!number || number.organization_id !== p.organizationId || number.status !== "active") {
    return { ok: false, reason: "number_not_available" };
  }
  const gate = await deps.checkAccess(p.organizationId, number.id, "outbound");
  if (!gate.allowed) return { ok: false, reason: gate.reason ?? "not_entitled" };
  const { data: call, error } = await deps.db
    .from("call_logs")
    .insert({
      organization_id: p.organizationId,
      business_id: number.business_id,
      phone_number_id: number.id,
      provider: SIP_PROVIDER,
      provider_call_id: null,
      direction: "outbound",
      caller_number: number.e164,
      destination_number: p.toNumber,
      status: "initiated",
      started_at: deps.now().toISOString(),
    })
    .select("id")
    .single();
  if (error || !call) return { ok: false, reason: "call_log_failed" };
  return { ok: true, callId: call.id, fromNumber: number.e164 };
}

/** Production wiring of SessionDeps to the existing modules (lazy, server-only). */
export async function defaultSessionDeps(): Promise<SessionDeps> {
  const [{ supabaseAdmin }, guard, agentService, instr, tools] = await Promise.all([
    import("@/integrations/supabase/client.server"),
    import("@/lib/telephony-guard.server"),
    import("@/lib/agent-service.server"),
    import("@/lib/agent-instructions"),
    import("@/lib/ai-tools.server"),
  ]);
  const db = supabaseAdmin as unknown as Client;
  return {
    db,
    resolveNumber: (provider, e164) => guard.resolveActivePhoneNumberByDestination(provider, e164),
    checkAccess: async (org, pn, dir) => {
      const g = await guard.checkTelephonyAccess(org, pn, dir);
      return { allowed: g.allowed, reason: g.reason };
    },
    loadBusiness: async (businessId) => {
      const snap = await agentService.loadSnapshot(db, businessId);
      const { data: rows } = await db
        .from("services")
        .select("id, name, price, duration_minutes, is_active")
        .eq("business_id", businessId);
      return {
        name: snap.business.name,
        timezone: snap.business.timezone,
        country: snap.business.country ?? null,
        currency: snap.business.currency,
        services: (rows ?? [])
          .filter((r) => r.is_active)
          .map((r) => ({
            id: r.id,
            name: r.name,
            price: r.price ?? null,
            durationMinutes: r.duration_minutes ?? null,
          })),
        agentName: snap.agent.agent_name,
        primaryLanguage: snap.agent.primary_language,
        extraLanguages: snap.agent.extra_languages,
        greetings: snap.agent.greetings,
        voiceId: snap.agent.voice_id,
        speakingPace: snap.agent.speaking_pace,
        instructions: instr.buildAgentInstructions(snap),
      };
    },
    availableTools: async (org, biz) =>
      (await tools.resolveAvailableTools(db, org, biz)).map((t) => t.name),
    executeTool: (ctx, name, input) =>
      tools.executeAiTool(db, { ...ctx, source: "voice" }, name, input),
    finalizeBilling: (call, seconds) => guard.finalizeCallBilling(call, seconds),
    now: () => new Date(),
  };
}
