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
import { bookingNeedsPayment, paymentAmountMinorUnits } from "../payments/payment-policy.ts";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { normalizeInboundNumber } from "./phone.ts";
import {
  DEFAULT_MAX_CALL_SECONDS,
  MAX_CALL_SECONDS_CEILING,
  casUpdateCall,
  checked,
  maxCallSecondsFromEnv,
  mergeCall,
  validMaxCallSeconds,
} from "./call-meta.ts";

type Client = SupabaseClient<Database>;
type CallLog = Database["public"]["Tables"]["call_logs"]["Row"];

export const SIP_PROVIDER = "livekit_sip";
const TERMINAL = ["completed", "failed", "busy", "no_answer", "cancelled"];
/** Statuses of a call that has not ended (call_logs_status_check). */
const ACTIVE = ["initiated", "ringing", "answered", "in_progress"];
/**
 * An outbound row can be claimed for dialling only this long after klyro
 * created it. A dispatch that arrives later (stuck queue, re-dispatch) can
 * never dial, which is what makes an unclaimed row safe to close.
 */
export const OUTBOUND_CLAIM_TTL_SECONDS = 300;
/** The LiveKit room of an outbound call; the agent must be in exactly this room. */
export const outboundRoomName = (callId: string) => `out-${callId}`;
/** Upper bound on any billed duration (also the agent's MAX_CALL_SECONDS ceiling). */
const MAX_BILLED_SECONDS = 7200;

type Meta = Record<string, unknown>;
const meta = (row: { provider_metadata?: unknown } | null | undefined): Meta =>
  row?.provider_metadata &&
  typeof row.provider_metadata === "object" &&
  !Array.isArray(row.provider_metadata)
    ? { ...(row.provider_metadata as Meta) }
    : {};
/** Tools the voice agent may ask for (still filtered by each agent's capabilities). */
export const VOICE_AGENT_TOOLS = [
  "check_calendar_availability",
  "book_appointment",
  "reschedule_appointment",
  // Read-only, klyro-side: the caller's own upcoming bookings (by the call's
  // caller ID). Allowed when the business allows rescheduling.
  "find_my_bookings",
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
  /**
   * The business and the agent configuration the call runs with
   * (agent-config.server.ts: the published version, or a validated live
   * configuration when none is published). Null when the call cannot be
   * served: no valid configuration.
   */
  loadBusiness: (businessId: string) => Promise<SessionBusiness | null>;
  /**
   * A returning caller's first name for the greeting (the Worker runtime's
   * rule, calendar/caller-bookings.server.ts findReturningCallerFirstName):
   * exactly one name known for this number at this business, else null.
   */
  findCallerFirstName?: (q: {
    organizationId: string;
    businessId: string;
    callerE164: string;
    country: string | null;
  }) => Promise<string | null>;
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
  /** G5: one of the business's services (price for the payment rule), scoped to the tenant. */
  loadService?: (
    organizationId: string,
    businessId: string,
    serviceId: string,
  ) => Promise<{
    id: string;
    name: string;
    price: number | null;
    currency: string;
    is_active: boolean;
  } | null>;
  /** G4: the caller's upcoming, movable bookings (calendar/caller-bookings.server.ts). */
  findCallerBookings?: (q: {
    organizationId: string;
    businessId: string;
    callerE164: string | null;
    callId: string;
    country: string | null;
  }) => Promise<
    {
      id: string;
      startAt: string;
      endAt: string;
      serviceId: string | null;
      serviceName: string | null;
    }[]
  >;
  /**
   * G4: the Worker runtime's ownership guard (guardBookingOwnership): a tool
   * that changes an existing booking runs only for the caller who owns it.
   * Null = may proceed; otherwise the NOT_FOUND result to return.
   */
  guardOwnership?: (
    ctx: {
      organizationId: string;
      businessId: string;
      callId: string;
      callerE164: string | null;
      phoneCountry: string | null;
    },
    tool: string,
    input: Record<string, unknown>,
  ) => Promise<{ content: string; isError: boolean } | null>;
  /**
   * Atomic check-and-insert of an outbound call row with the per-organization
   * caps (public.reserve_voice_agent_outbound_call, migration
   * 20261102090000). Absent = outbound is unavailable (fail closed).
   */
  reserveOutbound?: (p: ReserveOutboundInput) => Promise<ReserveOutboundOutcome>;
  /**
   * Atomic store of one agent job's transcript segment and rebuild of
   * call_logs.transcript (public.store_voice_agent_transcript_segment,
   * migration 20261107090000). Absent = transcripts cannot be stored: a
   * report carrying one fails (never reported as stored).
   */
  storeTranscriptSegment?: (p: StoreTranscriptInput) => Promise<StoreTranscriptOutcome>;
  /**
   * klyro's maximum call duration (VOICE_AGENT_MAX_CALL_SECONDS, default
   * 1800). Returned at session start; the agent ends the call at the smaller
   * of this and its own MAX_CALL_SECONDS, so the room sweep
   * (room-sweep.server.ts), which acts after this limit + 5 min, never
   * deletes the room of a call the agent still considers within its limit.
   */
  maxCallSeconds?: number;
  now: () => Date;
}

export interface ReserveOutboundInput {
  callId: string;
  organizationId: string;
  businessId: string | null;
  phoneNumberId: string;
  callerNumber: string;
  destinationNumber: string;
  requestedBy: string;
  nowIso: string;
  maxActive: number;
  maxDaily: number;
  claimTtlSeconds: number;
}
export type ReserveOutboundOutcome =
  | { outcome: "created" | "existing"; callId: string; status: string }
  | { outcome: "conflict" | "limit_active" | "limit_daily"; callId: null; status: null };

export interface StoreTranscriptInput {
  callId: string;
  /** Required for a checkpoint (must equal the call's SIP call id); optional for a final report. */
  sipCallId: string | null;
  /** The reporting LiveKit job; "" = the single unnamed segment (older agents). */
  segment: string;
  turns: TranscriptTurn[];
  /** The final report for this segment (not a checkpoint). */
  final: boolean;
  language: string | null;
}
export type StoreTranscriptOutcome = "stored" | "unchanged" | "unknown_call" | "binding_mismatch";

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
  /** Published agent version the call runs with; null for a validated live configuration. */
  agentVersion?: number | null;
  /** Where the configuration came from (logged; never silent). */
  configSource?: "published_version" | "live_snapshot";
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
  /**
   * The agent's own MAX_CALL_SECONDS (agents from Phase 2.11 on). Absent
   * from older agents, which ignore klyro's limit: their calls are recorded
   * with the 7200 s ceiling so the room sweep never ends them early.
   */
  agentMaxCallSeconds?: number | undefined;
}

export type StartSessionResult =
  | {
      allowed: true;
      callId: string;
      business: SessionBusiness;
      tools: string[];
      callerNumber: string | null;
      /** klyro's maximum call duration for this call (seconds). */
      maxCallSeconds: number;
      /** A returning caller's first name for the greeting, or null (unknown, shared number, withheld). */
      callerFirstName: string | null;
    }
  | {
      allowed: false;
      reason:
        | "unknown_number"
        | "not_entitled"
        | "invalid_outbound"
        | "call_ended"
        | "already_started"
        | "agent_config_unavailable";
      callId: string | null;
    };

const E164 = /^\+[1-9]\d{6,14}$/;

const klyroMax = (deps: SessionDeps) =>
  validMaxCallSeconds(deps.maxCallSeconds) ?? DEFAULT_MAX_CALL_SECONDS;

/** min(klyro's limit, the agent's limit); null when the agent sent none (older agent). */
function agreedMaxCallSeconds(
  deps: SessionDeps,
  input: StartSessionInput,
): { agreed: number | null } {
  const agent = validMaxCallSeconds(input.agentMaxCallSeconds);
  return { agreed: agent === null ? null : Math.min(klyroMax(deps), agent) };
}

export async function startSipSession(
  deps: SessionDeps,
  input: StartSessionInput,
): Promise<StartSessionResult> {
  // Carrier formats differ (E.164, national, leading 0, "91" without "+"):
  // normalize once, here (phone.ts). Unsupported or withheld -> null.
  const caller = normalizeInboundNumber(input.callerNumber);

  if (input.direction === "outbound") {
    // Outbound: the row was created by an authenticated owner/admin
    // (outbound.server.ts) and claimed by exactly one agent job
    // (claimOutboundCall, status "ringing"). Only that call's room may start
    // it, and only once: the conditional update below is the single-use
    // claim on the session (concurrent or duplicate starts lose it).
    const callId = input.outboundCallLogId;
    if (!callId || input.roomName !== outboundRoomName(callId))
      return { allowed: false, reason: "invalid_outbound", callId: null };
    const { data: won } = await deps.db
      .from("call_logs")
      .update({
        provider_call_id: input.sipCallId,
        status: "answered",
        answered_at: deps.now().toISOString(),
      })
      .eq("id", callId)
      .eq("provider", SIP_PROVIDER)
      .eq("direction", "outbound")
      .eq("status", "ringing")
      .is("provider_call_id", null)
      .select("*");
    let call: CallLog | null = (won as CallLog[] | null)?.[0] ?? null;
    if (!call) {
      const { data: existing } = await deps.db
        .from("call_logs")
        .select("*")
        .eq("id", callId)
        .eq("provider", SIP_PROVIDER)
        .eq("direction", "outbound")
        .maybeSingle();
      if (!existing || !existing.business_id)
        return { allowed: false, reason: "invalid_outbound", callId: null };
      if (TERMINAL.includes(existing.status))
        return { allowed: false, reason: "call_ended", callId: existing.id };
      // A retried start for the SAME SIP call is idempotent; any other SIP
      // call on this row (duplicate dispatch, re-dispatch) is refused.
      if (existing.provider_call_id !== input.sipCallId)
        return {
          allowed: false,
          reason: existing.provider_call_id ? "already_started" : "invalid_outbound",
          callId: existing.id,
        };
      call = existing;
    }
    if (!call.business_id) return { allowed: false, reason: "invalid_outbound", callId: null };
    const business = await deps.loadBusiness(call.business_id);
    if (!business) return { allowed: false, reason: "agent_config_unavailable", callId: call.id };
    const tools = await deps.availableTools(call.organization_id, call.business_id);
    return {
      allowed: true,
      callId: call.id,
      business,
      tools,
      callerNumber: call.destination_number ?? caller,
      maxCallSeconds: agreedMaxCallSeconds(deps, input).agreed ?? klyroMax(deps),
      callerFirstName: null,
    };
  }

  const called = normalizeInboundNumber(input.calledNumber);
  const number = called ? await deps.resolveNumber("vobiz", called) : null;
  if (!number || !number.organization_id || !number.business_id) {
    return { allowed: false, reason: "unknown_number", callId: null };
  }
  const gate = await deps.checkAccess(number.organization_id, number.id, "inbound");
  const nowIso = deps.now().toISOString();
  // F2: the limit agreed for THIS call is recorded on the row and never
  // changes afterwards (a later VOICE_AGENT_MAX_CALL_SECONDS change cannot
  // shorten a running call). Older agents (no limit sent) get the ceiling.
  const { agreed } = agreedMaxCallSeconds(deps, input);

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
      provider_metadata: {
        livekit_room: input.roomName,
        transport: "sip",
        max_call_seconds: agreed ?? MAX_CALL_SECONDS_CEILING,
        max_call_source: agreed === null ? "legacy_agent" : "agreed",
      } as never,
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
  if (!business) {
    // No published version and an incomplete live configuration: the call
    // is not served (the Worker runtime refuses the same way).
    await deps.db
      .from("call_logs")
      .update({
        status: "failed",
        failure_reason: "agent_config_incomplete",
        ended_at: deps.now().toISOString(),
      })
      .eq("id", call.id)
      .eq("status", "answered")
      .is("ended_at", null);
    console.warn("voice_agent:agent_config_unavailable", { callId: call.id });
    return { allowed: false, reason: "agent_config_unavailable", callId: call.id };
  }
  // The version the call runs with, recorded once (dashboard and audits).
  if (business.agentVersion !== undefined && call.agent_version !== business.agentVersion) {
    await deps.db
      .from("call_logs")
      .update({ agent_version: business.agentVersion })
      .eq("id", call.id);
  }
  console.info("voice_agent:agent_config", {
    callId: call.id,
    source: business.configSource ?? "unknown",
    agentVersion: business.agentVersion ?? null,
  });
  const tools = await deps.availableTools(number.organization_id, number.business_id);
  // Returning caller: only with a caller ID, only one known name, never fatal.
  let callerFirstName: string | null = null;
  if (caller && deps.findCallerFirstName) {
    try {
      callerFirstName = await deps.findCallerFirstName({
        organizationId: number.organization_id,
        businessId: number.business_id,
        callerE164: caller,
        country: business.country,
      });
    } catch {
      console.warn("voice_agent:returning_caller_lookup_failed", { callId: call.id });
    }
  }
  return {
    allowed: true,
    callId: call.id,
    business,
    tools,
    callerNumber: caller,
    maxCallSeconds: validMaxCallSeconds(meta(call)["max_call_seconds"]) ?? agreed ?? klyroMax(deps),
    callerFirstName,
  };
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
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (/^(organization|org|business|agent|tenant|call)_?id$/i.test(k)) continue;
    clean[k] = v;
  }
  const businessId = call.business_id;
  // The caller's identity is the call row's caller ID (the SIP From klyro
  // normalized at session start), never anything in the tool input.
  const callerE164 = call.caller_number ?? null;
  const country = async () => {
    const { data } = await deps.db
      .from("businesses")
      .select("country")
      .eq("id", businessId)
      .maybeSingle();
    return (data as { country?: string | null } | null)?.country ?? null;
  };

  if (tool === "find_my_bookings") {
    if (!allowed.includes("reschedule_appointment") || !deps.findCallerBookings)
      return { ok: false, reason: "tool_not_allowed" };
    const bookings = await deps.findCallerBookings({
      organizationId: call.organization_id,
      businessId,
      callerE164,
      callId: call.id,
      country: await country(),
    });
    return {
      ok: true,
      content: JSON.stringify({
        success: true,
        data: {
          callerIdentified: callerE164 !== null,
          bookings: bookings.map((b) => ({
            id: b.id,
            startAt: b.startAt,
            endAt: b.endAt,
            serviceId: b.serviceId,
            serviceName: b.serviceName,
          })),
        },
      }),
      isError: false,
    };
  }
  if (tool === "book_appointment") {
    return bookForCall(deps, call, allowed, clean, await agentConfigOf(deps, call));
  }
  if (!allowed.includes(tool)) return { ok: false, reason: "tool_not_allowed" };
  if (tool === "reschedule_appointment") {
    // Fails closed: without the ownership guard nothing is moved.
    if (!deps.guardOwnership) return { ok: false, reason: "tool_not_allowed" };
    const refused = await deps.guardOwnership(
      {
        organizationId: call.organization_id,
        businessId,
        callId: call.id,
        callerE164,
        phoneCountry: await country(),
      },
      tool,
      clean,
    );
    if (refused) return { ok: true, content: refused.content, isError: true };
    return rescheduleForCall(deps, call, clean, await agentConfigOf(deps, call));
  }
  const out = await deps.executeTool(
    {
      organizationId: call.organization_id,
      businessId: call.business_id,
      agentConfigId: await agentConfigOf(deps, call),
      callId: call.id,
    },
    tool,
    clean,
  );
  return { ok: true, content: out.content, isError: out.isError === true };
}

/**
 * G4: moves the caller's booking with the shared reschedule tool
 * (update_calendar_event: atomic DB move with a conflict re-check, then the
 * Google Calendar update) and reports one outcome the agent can say
 * honestly: "confirmed", or "saved_calendar_sync_failed" when the database
 * move succeeded but the calendar copy did not (the booking is then marked
 * CALENDAR_SYNC_FAILED by the booking service; the team confirms it).
 */
async function rescheduleForCall(
  deps: SessionDeps,
  call: CallLog,
  input: Record<string, unknown>,
  agentConfigId: string | null,
): Promise<ToolCallResult> {
  const out = await deps.executeTool(
    {
      organizationId: call.organization_id,
      businessId: call.business_id!,
      agentConfigId,
      callId: call.id,
    },
    "reschedule_appointment",
    input,
  );
  const parsed = parseToolContent(out.content);
  if (parsed.success) {
    return {
      ok: true,
      content: JSON.stringify({ ...parsed, rescheduleOutcome: "confirmed" }),
      isError: false,
    };
  }
  const bookingId = typeof input["bookingId"] === "string" ? input["bookingId"] : null;
  const newStart =
    typeof input["newStartIso"] === "string" ? Date.parse(input["newStartIso"]) : NaN;
  if (bookingId && Number.isFinite(newStart)) {
    const { data: row } = await deps.db
      .from("bookings")
      .select("id, status, start_at, end_at")
      .eq("id", bookingId)
      .eq("organization_id", call.organization_id)
      .eq("business_id", call.business_id!)
      .maybeSingle();
    const b = row as { id: string; status: string; start_at: string; end_at: string } | null;
    if (b && b.status === "CALENDAR_SYNC_FAILED" && Date.parse(b.start_at) === newStart) {
      console.warn("voice_agent:reschedule_calendar_sync_failed", { callId: call.id });
      return {
        ok: true,
        content: JSON.stringify({
          success: true,
          rescheduleOutcome: "saved_calendar_sync_failed",
          data: { id: b.id, startAt: b.start_at, endAt: b.end_at },
        }),
        isError: false,
      };
    }
  }
  return { ok: true, content: out.content, isError: true };
}

/** The agent config currently assigned to the number the call came in on. */
async function agentConfigOf(deps: SessionDeps, call: CallLog): Promise<string | null> {
  if (!call.phone_number_id) return null;
  const { data: pn } = await deps.db
    .from("phone_numbers")
    .select("agent_config_id, organization_id")
    .eq("id", call.phone_number_id)
    .maybeSingle();
  return pn && pn.organization_id === call.organization_id ? (pn.agent_config_id ?? null) : null;
}

function parseToolContent(content: string): {
  success?: boolean;
  data?: Record<string, unknown>;
  error?: { code?: string; message?: string };
} {
  try {
    return JSON.parse(content);
  } catch {
    return { success: false, error: { code: "BAD_TOOL_OUTPUT" } };
  }
}

/**
 * G5: a voice booking, with the same payment rule as every other channel
 * (payments/payment-policy.ts). When the business requires payment for this
 * service, the slot is HELD (create_payment_required_booking) and a payment
 * link is requested for the service's own price (request_payment, sent to
 * the customer over WhatsApp) — the WhatsApp channel's exact sequence. The
 * hold is never reported as confirmed: the existing payment webhook confirms
 * it when the payment is captured, and the hold expires otherwise. Both
 * steps are idempotent per call and slot (voiceBookingIdempotencyKey;
 * payment_request:<bookingId>), so a retried request never creates a
 * second hold or a second payment request.
 */
async function bookForCall(
  deps: SessionDeps,
  call: CallLog,
  allowed: string[],
  input: Record<string, unknown>,
  agentConfigId: string | null,
): Promise<ToolCallResult> {
  const ctx = {
    organizationId: call.organization_id,
    businessId: call.business_id!,
    agentConfigId,
    callId: call.id,
  };
  const serviceId = typeof input["serviceId"] === "string" ? input["serviceId"] : null;
  const service =
    serviceId && deps.loadService
      ? await deps.loadService(call.organization_id, call.business_id!, serviceId)
      : null;
  const needsPayment = bookingNeedsPayment(service && service.is_active ? service : null, {
    booking_payment_required: allowed.includes("create_payment_required_booking"),
    payment_request: allowed.includes("request_payment"),
  });
  if (!needsPayment) {
    if (!allowed.includes("book_appointment")) return { ok: false, reason: "tool_not_allowed" };
    const out = await deps.executeTool(ctx, "book_appointment", input);
    return { ok: true, content: out.content, isError: out.isError === true };
  }
  const holdOut = await deps.executeTool(ctx, "create_payment_required_booking", input);
  const hold = parseToolContent(holdOut.content);
  const bookingId = hold.data?.["id"];
  if (!hold.success || typeof bookingId !== "string")
    return { ok: true, content: holdOut.content, isError: true };
  const payOut = await deps.executeTool(ctx, "request_payment", {
    bookingId,
    // The service's own price, never anything from the agent's input.
    amountMinorUnits: paymentAmountMinorUnits(service!.price!),
    currency: service!.currency,
  });
  const payment = parseToolContent(payOut.content);
  console.info("voice_agent:payment_booking", {
    callId: call.id,
    held: true,
    paymentRequested: payment.success === true,
    linkSent: payment.data?.["whatsappSent"] === true,
  });
  return {
    ok: true,
    content: JSON.stringify({
      success: true,
      bookingOutcome: "payment_pending",
      data: { id: bookingId, startAt: hold.data?.["startAt"], endAt: hold.data?.["endAt"] },
      payment: {
        requested: payment.success === true,
        linkSent: payment.data?.["whatsappSent"] === true,
        ...(payment.success ? {} : { error: payment.error?.code ?? "UNKNOWN" }),
      },
    }),
    isError: false,
  };
}

export interface EndSessionInput {
  callId: string;
  reason: string;
  /**
   * The LiveKit job reporting. Required to close an outbound call that is
   * being dialled ("ringing"): only the job that claimed it may say its dial
   * failed.
   */
  jobId?: string | undefined;
  /** Short, redacted summary only — never the full transcript. */
  summary?: string | undefined;
  language?: string | undefined;
  outcome?: string | undefined;
  /**
   * F1: the LiveKit room and `sip.callID` of the call being reported. When
   * present (agents from Phase 2.11 on) they must match the row, or the
   * report is refused: an agent cannot end another call. Older agents send
   * neither; their reports are accepted but marked unbound, and the room
   * sweep never acts on an end report alone (it also requires the agent to
   * have left the room).
   */
  roomName?: string | undefined;
  sipCallId?: string | undefined;
  /** G3: the full conversation (see TranscriptTurn); stored in call_logs.transcript. */
  transcript?: TranscriptTurn[] | undefined;
  /**
   * The reporting agent job (LiveKit job id): one transcript segment per
   * job, so a job that replaced a crashed one adds its turns beside the
   * earlier ones instead of overwriting them. Absent = the single unnamed
   * segment (older agents).
   */
  segment?: string | undefined;
  /**
   * A transcript checkpoint during the call, not the end of the session:
   * only the transcript is merged; nothing else about the call changes.
   * Must be bound (room and SIP call id).
   */
  checkpoint?: boolean | undefined;
}

/**
 * One turn of call_logs.transcript: exactly the Cloudflare Worker voice
 * runtime's ConversationTurn (voice-runtime.server.ts), which the calls
 * dashboard renders (app.calls.tsx: role + text).
 */
export interface TranscriptTurn {
  role: "user" | "assistant";
  text: string;
  at: string;
}
export const MAX_TRANSCRIPT_TURNS = 400;
export const MAX_TRANSCRIPT_TEXT = 4000;

/**
 * The agent's own report that its session ended. It is NOT trusted for
 * billing (the agent could be wrong or compromised): it records the
 * summary/outcome and closes an outbound dial that never connected.
 * Billing is driven by the signed LiveKit webhook below.
 */
export async function endSipSession(
  deps: SessionDeps,
  input: EndSessionInput,
): Promise<{ ok: boolean; reason?: "unknown_call" | "binding_mismatch" }> {
  const call = checked(
    "call_logs.end_read",
    await deps.db
      .from("call_logs")
      .select("*")
      .eq("id", input.callId)
      .eq("provider", SIP_PROVIDER)
      .maybeSingle(),
  ) as CallLog | null;
  if (!call) return { ok: false, reason: "unknown_call" };
  const m = meta(call);
  // F1: bind the report to the call. For inbound calls klyro recorded the
  // room and the SIP call id at session start; for outbound calls the room
  // is derived from the row id and the SIP call id is set at session start.
  const expectedRoom =
    call.direction === "outbound"
      ? outboundRoomName(call.id)
      : (m["livekit_room"] as string | undefined);
  if (
    (input.roomName !== undefined && input.roomName !== expectedRoom) ||
    (input.sipCallId !== undefined &&
      call.provider_call_id !== null &&
      input.sipCallId !== call.provider_call_id)
  ) {
    console.warn("voice_agent:end_report_binding_mismatch", { callId: call.id });
    return { ok: false, reason: "binding_mismatch" };
  }
  const bound = input.roomName !== undefined || input.sipCallId !== undefined;
  if (input.checkpoint) {
    // A checkpoint must name BOTH the room and the SIP call it belongs to,
    // and the call must already have that SIP call id recorded.
    if (
      input.roomName === undefined ||
      input.sipCallId === undefined ||
      call.provider_call_id !== input.sipCallId ||
      !input.transcript
    ) {
      console.warn("voice_agent:transcript_checkpoint_unbound", { callId: call.id });
      return { ok: false, reason: "binding_mismatch" };
    }
    const stored = await storeTranscript(deps, call.id, input, false);
    return stored === "stored" || stored === "unchanged"
      ? { ok: true }
      : { ok: false, reason: stored };
  }
  const nowIso = deps.now().toISOString();
  // An outbound row that never reached session start ("initiated" or
  // claimed "ringing") was never answered: the dial failed (busy, no answer,
  // rejected, no trunk). Close it now; never billed. Conditional, so a
  // concurrent session start (-> "answered") wins and is not overwritten.
  const claimJob = (m["claim"] as { job_id?: string } | undefined)?.job_id;
  const mayCloseDial =
    call.direction === "outbound" &&
    (call.status === "initiated" ||
      (call.status === "ringing" && !!input.jobId && input.jobId === claimJob));
  if (call.direction === "outbound" && call.status === "ringing" && !mayCloseDial)
    console.warn("voice_agent:end_report_not_owner", { callId: call.id });
  if (mayCloseDial) {
    checked(
      "call_logs.close_dial",
      await deps.db
        .from("call_logs")
        .update({ status: "failed", failure_reason: input.reason.slice(0, 200), ended_at: nowIso })
        .eq("id", call.id)
        .in("status", ["initiated", "ringing"])
        .is("ended_at", null),
    );
  } else if ((call.status === "answered" || call.status === "in_progress") && !call.ended_at) {
    // Record WHEN klyro heard the end (klyro's clock, not an agent-supplied
    // time). Used only if LiveKit's signed end event never arrives
    // (reconcileStaleSipCalls, room sweep). Guarded (F6): merged into the
    // CURRENT metadata, and never once the call has ended.
    if (!bound) console.warn("voice_agent:end_report_unbound", { callId: call.id });
    await mergeCall(
      deps.db,
      call.id,
      (fresh) =>
        fresh.ended_at || typeof meta(fresh)["agent_ended_at"] === "string"
          ? null
          : {
              requireActive: true,
              update: {
                provider_metadata: {
                  ...meta(fresh),
                  agent_ended_at: nowIso,
                  ...(bound ? {} : { agent_end_unbound: true }),
                } as never,
              },
            },
      "call_logs.agent_end",
    );
  }
  const patch: Database["public"]["Tables"]["call_logs"]["Update"] = {};
  // G3: the final transcript, from a report bound to this call only, stored
  // atomically with the checkpoints already stored (storeTranscript): a
  // replay, the second report (end of conversation, then process shutdown),
  // a late, shorter one or a concurrent checkpoint never loses or
  // duplicates turns. The database writes the summary line with it.
  if (input.transcript && bound) {
    const stored = await storeTranscript(deps, call.id, input, true);
    if (stored === "unknown_call" || stored === "binding_mismatch") {
      console.warn("voice_agent:end_report_transcript_refused", { callId: call.id, stored });
      return { ok: false, reason: stored };
    }
  } else {
    if (input.transcript)
      console.warn("voice_agent:transcript_unbound_ignored", { callId: call.id });
    if (input.summary) patch.summary = input.summary.slice(0, 2000);
  }
  if (input.language) patch.language = input.language.slice(0, 16);
  if (input.outcome) patch.outcome = input.outcome.slice(0, 64);
  if (Object.keys(patch).length)
    checked(
      "call_logs.end_summary",
      await deps.db.from("call_logs").update(patch).eq("id", call.id),
    );
  return { ok: true };
}

/**
 * Stores this report's transcript segment in ONE database transaction
 * (deps.storeTranscriptSegment): concurrent checkpoints, the final report
 * and other agent jobs' segments are serialized by the database, so none
 * overwrites another. Only the transcript and its summary line are written,
 * and only when they changed. A database failure throws (the request fails;
 * nothing is reported as stored).
 */
async function storeTranscript(
  deps: SessionDeps,
  callId: string,
  input: EndSessionInput,
  final: boolean,
): Promise<StoreTranscriptOutcome> {
  if (!deps.storeTranscriptSegment) throw new Error("transcript store unavailable");
  const turns = (input.transcript ?? [])
    .filter((t) => (t.role === "user" || t.role === "assistant") && t.text.trim())
    .slice(0, MAX_TRANSCRIPT_TURNS)
    .map((t) => ({ role: t.role, text: t.text.trim().slice(0, MAX_TRANSCRIPT_TEXT), at: t.at }));
  return deps.storeTranscriptSegment({
    callId,
    sipCallId: input.sipCallId ?? null,
    segment: input.segment ?? "",
    turns,
    final,
    language: input.language ?? null,
  });
}

/** A billing lease older than this is presumed dead (its holder crashed). */
export const BILLING_LEASE_MS = 10 * 60_000;

/**
 * Takes the billing lease on a completed row by compare-and-swap on the
 * lease value the caller read: one conditional UPDATE, so of any number of
 * concurrent claimers exactly one matches. Claimable: billing "retry" (the
 * previous attempt failed and said so), or "pending" whose lease is stale
 * (its holder died mid-billing). A fresh "pending" lease is never taken:
 * its holder is billing right now.
 */
async function claimBillingLease(deps: SessionDeps, row: CallLog): Promise<CallLog | null> {
  const m = meta(row);
  const state = m["billing"];
  const lease = typeof m["billing_lease"] === "string" ? (m["billing_lease"] as string) : null;
  const nowMs = deps.now().getTime();
  const stale = lease === null || nowMs - Date.parse(lease) > BILLING_LEASE_MS;
  if (row.status !== "completed" || !(state === "retry" || (state === "pending" && stale)))
    return null;
  // Conditional on the billing state/lease AND every other guarded key
  // (F6): a copy read before the room sweep recorded its outcome cannot
  // overwrite it. On a conflict the caller does not bill now; the reconcile
  // sweep's billing retry claims the row later.
  return casUpdateCall(
    deps.db,
    row,
    {
      provider_metadata: {
        ...m,
        billing: "pending",
        billing_lease: new Date(nowMs).toISOString(),
      } as never,
    },
    { op: "call_logs.billing_lease" },
  );
}

/**
 * The single completion of a SIP call and its single billing.
 *
 * 1. Transition: active -> "completed" with the duration, conditional on
 *    status active AND ended_at IS NULL, returning the row. Exactly one
 *    caller (webhook, retry, sweep) wins it; the winner also takes the
 *    billing lease (billing "pending" + billing_lease) in the same update.
 * 2. Bill: only the lease holder calls finalizeBilling, with the STORED
 *    duration, then marks billing "done". If billing throws, the holder
 *    marks it "retry" and rethrows (the webhook's claim is released, so
 *    LiveKit's retry claims the lease and bills); a holder that died
 *    leaves a "pending" lease that becomes claimable after BILLING_LEASE_MS
 *    (the sweep). A row marked "done", or without a billing state, is
 *    never billed again. debit_wallet_for_call and record_call_usage are
 *    additionally idempotent per call (defence in depth).
 */
async function completeAndBill(
  deps: SessionDeps,
  call: CallLog,
  seconds: number,
  source: "livekit_webhook" | "agent_report",
  extra: Database["public"]["Tables"]["call_logs"]["Update"] = {},
): Promise<{ billed: boolean; transitioned: boolean }> {
  let row: CallLog | null = null;
  let transitioned = false;
  if (ACTIVE.includes(call.status) && !call.ended_at) {
    const nowIso = deps.now().toISOString();
    // One conditional transition (still active, metadata unchanged), retried
    // on a metadata-only conflict while the call is still active (F6).
    row = await mergeCall(
      deps.db,
      call.id,
      (fresh) =>
        !ACTIVE.includes(fresh.status) || fresh.ended_at
          ? null
          : {
              requireActive: true,
              update: {
                status: "completed",
                ended_at: nowIso,
                duration_seconds: seconds,
                ...extra,
                provider_metadata: {
                  ...meta(fresh),
                  billing: "pending",
                  billing_lease: nowIso,
                  billing_source: source,
                } as never,
              },
            },
      "call_logs.complete",
    );
    transitioned = row !== null;
  }
  if (!transitioned) {
    const again = checked(
      "call_logs.complete_read",
      await deps.db.from("call_logs").select("*").eq("id", call.id).maybeSingle(),
    ) as CallLog | null;
    row = again ? await claimBillingLease(deps, again) : null;
  }
  if (!row) return { billed: false, transitioned };
  const held = row;
  const heldLease = meta(held)["billing_lease"] as string;
  // Later billing-state writes: merged into the current metadata, and only
  // while this holder still owns the lease (F6).
  const markBilling = (value: "retry" | "done") =>
    mergeCall(
      deps.db,
      held.id,
      (fresh) =>
        meta(fresh)["billing_lease"] !== heldLease
          ? null
          : { update: { provider_metadata: { ...meta(fresh), billing: value } as never } },
      `call_logs.billing_${value}`,
    );
  try {
    await deps.finalizeBilling(held, held.duration_seconds);
  } catch (err) {
    await markBilling("retry").catch(() => undefined);
    throw err;
  }
  // If this holder was so slow that its lease went stale and another caller
  // took it over, the new holder owns the row's billing state (both used the
  // same stored duration; the debit is idempotent per call).
  if (!(await markBilling("done")))
    console.warn("voice_agent:billing_lease_lost", { callId: held.id });
  return { billed: true, transitioned };
}

/** How the room sweep decided to close a call (provider_metadata.room_sweep_close). */
export type SweepCloseIntent =
  { status: "failed"; reason: string } | { status: "completed"; seconds: number; endedAt: string };

export function sweepCloseIntent(call: CallLog): SweepCloseIntent | null {
  const v = meta(call)["room_sweep_close"] as Record<string, unknown> | undefined;
  if (!v || typeof v !== "object") return null;
  if (v["status"] === "failed" && typeof v["reason"] === "string")
    return { status: "failed", reason: v["reason"] };
  if (
    v["status"] === "completed" &&
    typeof v["seconds"] === "number" &&
    typeof v["endedAt"] === "string"
  )
    return {
      status: "completed",
      seconds: Math.max(0, Math.min(Math.round(v["seconds"]), MAX_BILLED_SECONDS)),
      endedAt: v["endedAt"],
    };
  return null;
}

/**
 * The SIP caller left the LiveKit room (signed `participant_left` webhook).
 * Marks the call completed and bills the duration LiveKit measured, once:
 * finalizeCallBilling is idempotent per call (debit_wallet_for_call), and
 * the webhook itself is de-duplicated by the caller (webhook_events).
 */
export async function completeSipCallFromLiveKit(
  deps: SessionDeps,
  p: { sipCallId: string; seconds: number; endedAtSeconds?: number },
): Promise<{ handled: boolean; callId?: string; billed?: boolean }> {
  const { data: call } = await deps.db
    .from("call_logs")
    .select("*")
    .eq("provider", SIP_PROVIDER)
    .eq("provider_call_id", p.sipCallId)
    .maybeSingle();
  if (!call) return { handled: false };
  let seconds = Math.max(0, Math.min(Math.round(p.seconds), MAX_BILLED_SECONDS));
  // Outbound: LiveKit's participant joinedAt can include ringing time (the
  // SIP participant exists while it rings). Bill at most from the moment
  // klyro saw the call answered (session start runs after waitUntilAnswered).
  if (call.direction === "outbound" && call.answered_at && p.endedAtSeconds !== undefined) {
    const answered = Date.parse(call.answered_at) / 1000;
    if (Number.isFinite(answered))
      seconds = Math.min(seconds, Math.max(0, Math.round(p.endedAtSeconds - answered)));
  }
  if (call.status === "failed") return { handled: true, callId: call.id, billed: false };
  // The room sweep decided to end this call and recorded how (F7): its room
  // deletion is what produced this event, so LiveKit's duration includes
  // time nobody served. Apply the sweep's decision instead.
  const intent = sweepCloseIntent(call);
  if (intent && ACTIVE.includes(call.status) && !call.ended_at) {
    if (intent.status === "failed") {
      const closed = await mergeCall(
        deps.db,
        call.id,
        (fresh) =>
          !ACTIVE.includes(fresh.status) || fresh.ended_at
            ? null
            : {
                requireActive: true,
                update: {
                  status: "failed",
                  failure_reason: intent.reason,
                  ended_at: deps.now().toISOString(),
                },
              },
        "call_logs.webhook_apply_sweep",
      );
      if (!closed) console.warn("voice_agent:webhook_sweep_close_conflict", { callId: call.id });
      return { handled: true, callId: call.id, billed: false };
    }
    const r = await completeAndBill(deps, call, intent.seconds, "agent_report", {
      ended_at: intent.endedAt,
    });
    return { handled: true, callId: call.id, billed: r.billed };
  }
  const r = await completeAndBill(deps, call, seconds, "livekit_webhook");
  return { handled: true, callId: call.id, billed: r.billed };
}

/**
 * Safety net, run every 15 minutes (cron route). Every step is conditional
 * (status still active AND ended_at IS NULL), so overlapping runs, a late
 * webhook or a late agent report can never double-close or double-bill.
 *
 *  - outbound never claimed for dialling, older than the claim TTL + 5 min:
 *    failed "not_dialed". The TTL refuses any later claim, so no call can
 *    start on that row afterwards.
 *  - outbound claimed ("ringing") but never answered, 30 min after the
 *    claim: failed "dial_not_completed" (the dial times out after ~30 s).
 *  - answered, LiveKit's signed end event missing, but the agent reported
 *    the end >= 15 min ago: completed and billed ONCE from klyro's own
 *    timestamps (answered_at -> when klyro received the end report), capped.
 *  - answered with no end signal at all after 3 hours: failed
 *    "livekit_end_event_missing", not billed (no trustworthy duration).
 *  - completed rows whose billing is still "pending" (billing threw): billed
 *    again with the stored duration (idempotent per call).
 *
 * Subrequest budget per run (Workers): 2 selects + at most 3 bulk updates
 * + MAX_BILLING_PER_RUN billing operations (each ~7 requests) ~= 35.
 */
export const RECONCILE_BATCH = 50;
export const MAX_BILLING_PER_RUN = 4;

export interface ReconcileSummary {
  notDialed: number;
  dialNotCompleted: number;
  endEventMissing: number;
  billedFromAgentReport: number;
  billingRetried: number;
  deferred: number;
}

export async function reconcileStaleSipCalls(
  deps: SessionDeps,
  p: { batch?: number; maxBilling?: number } = {},
): Promise<ReconcileSummary> {
  const now = deps.now().getTime();
  const ago = (ms: number) => new Date(now - ms).toISOString();
  const nowIso = new Date(now).toISOString();
  const summary: ReconcileSummary = {
    notDialed: 0,
    dialNotCompleted: 0,
    endEventMissing: 0,
    billedFromAgentReport: 0,
    billingRetried: 0,
    deferred: 0,
  };
  let billingBudget = p.maxBilling ?? MAX_BILLING_PER_RUN;

  const { data: rows } = await (deps.db
    .from("call_logs")
    .select("*")
    .eq("provider", SIP_PROVIDER)
    .in("status", ACTIVE)
    .is("ended_at", null)
    .lt("started_at", ago(10 * 60_000))
    .order("started_at", { ascending: true })
    .limit(p.batch ?? RECONCILE_BATCH) as unknown as Promise<{ data: CallLog[] | null }>);

  const notDialed: string[] = [];
  const dialNotCompleted: string[] = [];
  const endMissing: string[] = [];
  for (const row of rows ?? []) {
    const m = meta(row);
    const started = Date.parse(row.started_at);
    if (row.direction === "outbound" && row.status === "initiated") {
      if (now - started > (OUTBOUND_CLAIM_TTL_SECONDS + 300) * 1000) notDialed.push(row.id);
      continue;
    }
    if (row.direction === "outbound" && row.status === "ringing") {
      const claim = m["claim"] as { claimed_at?: string } | undefined;
      const claimedAt = Date.parse(claim?.claimed_at ?? row.started_at);
      if (now - claimedAt > 30 * 60_000) dialNotCompleted.push(row.id);
      continue;
    }
    // answered / in_progress
    const agentEnded =
      typeof m["agent_ended_at"] === "string" ? Date.parse(m["agent_ended_at"]) : NaN;
    const answered = row.answered_at ? Date.parse(row.answered_at) : NaN;
    if (
      Number.isFinite(agentEnded) &&
      Number.isFinite(answered) &&
      now - agentEnded > 15 * 60_000
    ) {
      if (billingBudget <= 0) {
        summary.deferred++;
        continue;
      }
      billingBudget--;
      const seconds = Math.max(
        0,
        Math.min(Math.round((agentEnded - answered) / 1000), MAX_BILLED_SECONDS),
      );
      const r = await completeAndBill(deps, row, seconds, "agent_report");
      if (r.billed) summary.billedFromAgentReport++;
      continue;
    }
    if (now - started > 180 * 60_000) endMissing.push(row.id);
  }

  const closeAll = async (ids: string[], reason: string, from: string[]) => {
    if (!ids.length) return 0;
    const { data } = await (deps.db
      .from("call_logs")
      .update({ status: "failed", failure_reason: reason, ended_at: nowIso })
      .in("id", ids)
      .in("status", from)
      .is("ended_at", null)
      .select("id") as unknown as Promise<{ data: { id: string }[] | null }>);
    return data?.length ?? 0; // rows actually changed, not attempts
  };
  summary.notDialed = await closeAll(notDialed, "not_dialed", ["initiated"]);
  summary.dialNotCompleted = await closeAll(dialNotCompleted, "dial_not_completed", ["ringing"]);
  summary.endEventMissing = await closeAll(endMissing, "livekit_end_event_missing", [
    "answered",
    "in_progress",
  ]);

  if (billingBudget > 0) {
    // Billing left unfinished: "retry" (an attempt failed and said so) or a
    // "pending" lease whose holder died. claimBillingLease decides which
    // are claimable; at most one caller wins each.
    const { data: pending } = await (deps.db
      .from("call_logs")
      .select("*")
      .eq("provider", SIP_PROVIDER)
      .eq("status", "completed")
      .in("provider_metadata->>billing", ["pending", "retry"])
      .lt("ended_at", ago(BILLING_LEASE_MS))
      .limit(billingBudget) as unknown as Promise<{ data: CallLog[] | null }>);
    for (const row of pending ?? []) {
      const r = await completeAndBill(deps, row, row.duration_seconds, "livekit_webhook");
      if (r.billed) summary.billingRetried++;
    }
  }
  const closed = summary.notDialed + summary.dialNotCompleted + summary.endEventMissing;
  if (closed || summary.billedFromAgentReport || summary.billingRetried)
    console.warn("voice_agent:stale_sip_calls_reconciled", summary);
  return summary;
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
    // Replay records of signed agent requests and of signed cron runs (F14).
    .in("provider", ["voice_agent_request", "voice_agent_cron"])
    .lt("created_at", cutoff) as unknown as Promise<unknown>);
}

export type PrepareOutboundResult =
  | { ok: true; callId: string; fromNumber: string; created: boolean; status: string }
  | {
      ok: false;
      code:
        | "invalid_destination"
        | "not_available"
        | "not_entitled"
        | "conflict"
        | "limit_active"
        | "limit_daily"
        | "internal_error";
      reason: string;
    };

/**
 * Authorises an outbound SIP call before anything is dialled: the same
 * entitlement gate as every other outbound call, then ONE atomic database
 * call (reserveOutbound) that, under a per-organization lock, either finds
 * the row for this idempotency-derived id ("existing" / "conflict"),
 * refuses on the in-progress or 24 h cap, or inserts the "initiated" row.
 * Concurrent requests can neither exceed the caps nor create two rows.
 */
export async function prepareOutboundSipCall(
  deps: SessionDeps,
  p: {
    organizationId: string;
    phoneNumberId: string;
    toNumber: string;
    callId: string;
    requestedBy: string;
    maxActive: number;
    maxDaily: number;
  },
): Promise<PrepareOutboundResult> {
  if (!E164.test(p.toNumber))
    return { ok: false, code: "invalid_destination", reason: "invalid_destination" };
  const { data: number } = await deps.db
    .from("phone_numbers")
    .select("id, organization_id, business_id, e164, status")
    .eq("id", p.phoneNumberId)
    .maybeSingle();
  if (!number || number.organization_id !== p.organizationId || number.status !== "active") {
    return { ok: false, code: "not_available", reason: "number_not_available" };
  }
  const gate = await deps.checkAccess(p.organizationId, number.id, "outbound");
  if (!gate.allowed)
    return { ok: false, code: "not_entitled", reason: gate.reason ?? "not_entitled" };
  if (!deps.reserveOutbound)
    return { ok: false, code: "internal_error", reason: "reservation_unavailable" };
  let r: ReserveOutboundOutcome;
  try {
    r = await deps.reserveOutbound({
      callId: p.callId,
      organizationId: p.organizationId,
      businessId: number.business_id,
      phoneNumberId: number.id,
      callerNumber: number.e164,
      destinationNumber: p.toNumber,
      requestedBy: p.requestedBy,
      nowIso: deps.now().toISOString(),
      maxActive: p.maxActive,
      maxDaily: p.maxDaily,
      claimTtlSeconds: OUTBOUND_CLAIM_TTL_SECONDS,
    });
  } catch (err) {
    // Includes "function does not exist" before the migration is applied:
    // outbound stays unavailable rather than falling back to a racy check.
    console.error("voice_agent:outbound_reservation_failed", (err as Error).message);
    return { ok: false, code: "internal_error", reason: "reservation_failed" };
  }
  switch (r.outcome) {
    case "created":
    case "existing":
      return {
        ok: true,
        callId: r.callId,
        fromNumber: number.e164,
        created: r.outcome === "created",
        status: r.status,
      };
    case "conflict":
      return { ok: false, code: "conflict", reason: "idempotency_key_reused" };
    default:
      return { ok: false, code: r.outcome, reason: r.outcome };
  }
}

export type ClaimOutboundResult =
  | { ok: true; callId: string; toNumber: string; fromNumber: string }
  | {
      ok: false;
      reason:
        "not_found" | "wrong_room" | "already_claimed" | "expired" | "call_ended" | "not_entitled";
    };

/**
 * The agent's claim on an outbound row, BEFORE it dials. It is the only
 * source of the destination and caller ID the agent may use (never dispatch
 * metadata). Exactly one LiveKit job can win it: initiated -> ringing,
 * conditional on status "initiated" and on the row being younger than
 * OUTBOUND_CLAIM_TTL_SECONDS. The same job retrying gets the same answer
 * (idempotent by job id); any other job is refused and must not dial.
 * The entitlement gate is re-checked here (a number suspended or locked
 * after the request was accepted is not dialled).
 */
export async function claimOutboundCall(
  deps: SessionDeps,
  p: { callId: string; roomName: string; jobId: string },
): Promise<ClaimOutboundResult> {
  if (p.roomName !== outboundRoomName(p.callId)) return { ok: false, reason: "wrong_room" };
  const { data: call } = await deps.db
    .from("call_logs")
    .select("*")
    .eq("id", p.callId)
    .eq("provider", SIP_PROVIDER)
    .eq("direction", "outbound")
    .maybeSingle();
  if (!call || !call.phone_number_id || !call.destination_number || !call.caller_number)
    return { ok: false, reason: "not_found" };
  const ok = (): ClaimOutboundResult => ({
    ok: true,
    callId: call.id,
    toNumber: call.destination_number!,
    fromNumber: call.caller_number!,
  });
  const m = meta(call);
  const claim = m["claim"] as { job_id?: string } | undefined;
  if (call.status === "ringing" && claim?.job_id === p.jobId) return ok(); // idempotent retry
  if (call.status !== "initiated")
    return { ok: false, reason: TERMINAL.includes(call.status) ? "call_ended" : "already_claimed" };
  const nowMs = deps.now().getTime();
  const cutoff = new Date(nowMs - OUTBOUND_CLAIM_TTL_SECONDS * 1000).toISOString();
  // Compare as instants (PostgREST returns "+00:00", toISOString() "Z").
  if (!(Date.parse(call.started_at) >= Date.parse(cutoff))) return { ok: false, reason: "expired" };
  const gate = await deps.checkAccess(call.organization_id, call.phone_number_id, "outbound");
  if (!gate.allowed) {
    await deps.db
      .from("call_logs")
      .update({
        status: "failed",
        failure_reason: "not_entitled_at_dial",
        ended_at: new Date(nowMs).toISOString(),
      })
      .eq("id", call.id)
      .eq("status", "initiated");
    return { ok: false, reason: "not_entitled" };
  }
  const { data: won } = await deps.db
    .from("call_logs")
    .update({
      status: "ringing",
      provider_metadata: {
        ...m,
        claim: { job_id: p.jobId, claimed_at: new Date(nowMs).toISOString() },
      } as never,
    })
    .eq("id", call.id)
    .eq("status", "initiated")
    .gte("started_at", cutoff)
    .select("id");
  if ((won as unknown[] | null)?.length) return ok();
  // Lost the race: another job claimed it, or it was closed meanwhile.
  const { data: again } = await deps.db
    .from("call_logs")
    .select("status, provider_metadata")
    .eq("id", call.id)
    .maybeSingle();
  const c2 = meta(again)["claim"] as { job_id?: string } | undefined;
  if (again?.status === "ringing" && c2?.job_id === p.jobId) return ok();
  return {
    ok: false,
    reason: again && TERMINAL.includes(again.status) ? "call_ended" : "already_claimed",
  };
}

/**
 * Records the dispatch outcome on a row that is still "initiated" (never
 * overwrites a claim). "rejected" is a definite answer from LiveKit (4xx):
 * nothing can dial, so the row is closed as failed. "unknown" (timeout,
 * network, 5xx, 408/429) leaves the row open: a job may still claim it, and
 * the sweep closes it only after the claim TTL, when no claim can succeed.
 */
export async function recordDispatchOutcome(
  deps: SessionDeps,
  callId: string,
  outcome: "dispatched" | "rejected" | "unknown",
): Promise<void> {
  const { data: row } = await deps.db
    .from("call_logs")
    .select("status, provider_metadata")
    .eq("id", callId)
    .maybeSingle();
  if (!row || row.status !== "initiated") return;
  const m = { ...meta(row), dispatch: outcome };
  const update: Database["public"]["Tables"]["call_logs"]["Update"] =
    outcome === "rejected"
      ? {
          status: "failed",
          failure_reason: "dispatch_rejected",
          ended_at: deps.now().toISOString(),
          provider_metadata: m as never,
        }
      : { provider_metadata: m as never };
  await deps.db.from("call_logs").update(update).eq("id", callId).eq("status", "initiated");
}

/**
 * Rate-limit windows of the voice-agent scopes (rate-limits.ts) are only
 * needed for their minute; delete those older than `olderThanHours`.
 *
 * The LIKE pattern deliberately has no backslash escapes (they are fragile
 * through PostgREST URL encoding). Its two "_" match any one character, so
 * it matches "voice?agent?..." keys. The only other key formats in this
 * table are "chat:<sha256 hex>", "voice:<sha256 hex>" and
 * "sarvam_context:<id>"; none can match, because hex never contains the
 * letters of "agent" and the others do not start with "voice". Checked
 * against real PostgreSQL in voice_agent_rate_limits.pg.test.ts.
 */
export const VOICE_AGENT_RATE_LIMIT_KEY_PATTERN = "voice_agent_%";
export async function pruneVoiceAgentRateLimits(
  deps: SessionDeps,
  p: { olderThanHours: number },
): Promise<void> {
  const cutoff = new Date(deps.now().getTime() - p.olderThanHours * 3_600_000).toISOString();
  await (deps.db
    .from("public_assistant_rate_limits")
    .delete()
    .like("client_key", VOICE_AGENT_RATE_LIMIT_KEY_PATTERN)
    .lt("window_start", cutoff) as unknown as Promise<unknown>);
}

/** Production wiring of SessionDeps to the existing modules (lazy, server-only). */
export async function defaultSessionDeps(): Promise<SessionDeps> {
  const [{ supabaseAdmin }, guard, agentConfig, tools, callerBookings] = await Promise.all([
    import("@/integrations/supabase/client.server"),
    import("@/lib/telephony-guard.server"),
    import("./agent-config.server"),
    import("@/lib/ai-tools.server"),
    import("@/lib/calendar/caller-bookings.server"),
  ]);
  const configDeps = await agentConfig.defaultAgentConfigDeps();
  const draftPolicy = agentConfig.draftConfigPolicy((n) => process.env[n]);
  if (draftPolicy.optInIgnored) {
    console.warn("voice_agent:draft_config_opt_in_ignored_in_production", {});
  }
  const db = supabaseAdmin as unknown as Client;
  return {
    db,
    resolveNumber: (provider, e164) => guard.resolveActivePhoneNumberByDestination(provider, e164),
    checkAccess: async (org, pn, dir) => {
      const g = await guard.checkTelephonyAccess(org, pn, dir);
      return { allowed: g.allowed, reason: g.reason };
    },
    loadBusiness: async (businessId) => {
      const c = await agentConfig.resolveCallAgentConfig(db, businessId, configDeps, new Date(), {
        allowDraft: draftPolicy.allowDraft,
      });
      if (!c.ok) {
        // Field names only (never configuration values).
        console.warn("voice_agent:agent_config_refused", { reason: c.reason, fields: c.fields });
        return null;
      }
      return {
        name: c.businessName,
        timezone: c.timezone,
        country: c.country,
        currency: c.currency,
        services: c.services,
        agentName: c.agent.agent_name,
        primaryLanguage: c.agent.primary_language,
        extraLanguages: c.agent.extra_languages,
        greetings: c.agent.greetings,
        voiceId: c.agent.voice_id,
        speakingPace: c.agent.speaking_pace,
        instructions: c.instructions,
        agentVersion: c.agentVersion,
        configSource: c.source,
      };
    },
    loadService: async (org, biz, id) => {
      const { data } = await db
        .from("services")
        .select("id, name, price, currency, is_active")
        .eq("id", id)
        .eq("organization_id", org)
        .eq("business_id", biz)
        .maybeSingle();
      return (data as never) ?? null;
    },
    findCallerBookings: (q) =>
      callerBookings.findCallerUpcomingBookings(db as never, {
        organizationId: q.organizationId,
        businessId: q.businessId,
        callerE164: q.callerE164,
        callId: q.callId,
        country: q.country,
      }),
    guardOwnership: (ctx, tool, input) =>
      callerBookings.guardBookingOwnership(db as never, ctx, tool, input),
    findCallerFirstName: (q) =>
      callerBookings.findReturningCallerFirstName(db as never, {
        organizationId: q.organizationId,
        businessId: q.businessId,
        callerE164: q.callerE164,
        country: q.country,
      }),
    availableTools: async (org, biz) =>
      (await tools.resolveAvailableTools(db, org, biz)).map((t) => t.name),
    executeTool: (ctx, name, input) =>
      tools.executeAiTool(db, { ...ctx, source: "voice" }, name, input),
    finalizeBilling: (call, seconds) => guard.finalizeCallBilling(call, seconds),
    reserveOutbound: async (p) => {
      // Not in the generated Database types until the migration is applied
      // and types are regenerated; bound to the client (rpc reads this.rest).
      const rpc = supabaseAdmin.rpc.bind(supabaseAdmin) as unknown as (
        fn: string,
        args: Record<string, unknown>,
      ) => PromiseLike<{
        data: Array<{ outcome: string; call_id: string | null; call_status: string | null }> | null;
        error: { message: string } | null;
      }>;
      const { data, error } = await rpc("reserve_voice_agent_outbound_call", {
        _call_id: p.callId,
        _organization_id: p.organizationId,
        _business_id: p.businessId,
        _phone_number_id: p.phoneNumberId,
        _caller_number: p.callerNumber,
        _destination_number: p.destinationNumber,
        _requested_by: p.requestedBy,
        _now: p.nowIso,
        _max_active: p.maxActive,
        _max_daily: p.maxDaily,
        _claim_ttl_seconds: p.claimTtlSeconds,
      });
      if (error) throw new Error(error.message);
      const row = data?.[0];
      if (!row) throw new Error("reserve_voice_agent_outbound_call returned no row");
      if (row.outcome === "created" || row.outcome === "existing")
        return {
          outcome: row.outcome,
          callId: row.call_id!,
          status: row.call_status ?? "initiated",
        };
      if (
        row.outcome === "conflict" ||
        row.outcome === "limit_active" ||
        row.outcome === "limit_daily"
      )
        return { outcome: row.outcome, callId: null, status: null };
      throw new Error(`unexpected reservation outcome: ${row.outcome}`);
    },
    storeTranscriptSegment: async (p) => {
      // Not in the generated Database types until the migration is applied
      // and types are regenerated; bound to the client (rpc reads this.rest).
      const rpc = supabaseAdmin.rpc.bind(supabaseAdmin) as unknown as (
        fn: string,
        args: Record<string, unknown>,
      ) => PromiseLike<{
        data: Array<{ outcome: string; total_turns: number | null }> | null;
        error: { message: string } | null;
      }>;
      const { data, error } = await rpc("store_voice_agent_transcript_segment", {
        _call_id: p.callId,
        _sip_call_id: p.sipCallId,
        _segment: p.segment,
        _turns: p.turns,
        _final: p.final,
        _language: p.language,
      });
      if (error) throw new Error(error.message);
      const outcome = data?.[0]?.outcome;
      if (
        outcome === "stored" ||
        outcome === "unchanged" ||
        outcome === "unknown_call" ||
        outcome === "binding_mismatch"
      )
        return outcome;
      throw new Error(`unexpected transcript store outcome: ${String(outcome)}`);
    },
    maxCallSeconds: maxCallSecondsFromEnv(process.env["VOICE_AGENT_MAX_CALL_SECONDS"]),
    now: () => new Date(),
  };
}
