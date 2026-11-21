import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/integrations/supabase/types";
import {
  buildSarvamClientContext,
  type SarvamClientContext,
} from "./sarvam-client-context.server.ts";
import type { ToolExecutionContext } from "./ai-tools.server.ts";
import { zonedWallTimeToUtc } from "./calendar/timezone.ts";
import { normalizeCustomerPhone } from "./phone-number.ts";
import { UNRESOLVED_SARVAM_STATUSES } from "./sarvam-call-review.ts";
import {
  checkInboundAdmission,
  checkOutboundAgentAdmission,
} from "./sarvam-inbound-admission.server.ts";
import { UNIVERSAL_CAPABILITIES } from "./universal-agent-config.ts";
import { customGreetingFor, renderGreeting } from "./agent-greeting.ts";
import { buildSarvamAgentPrompt, sarvamPromptGuardrails } from "./sarvam-agent-prompt.ts";
import {
  isAgentRole,
  OUTBOUND_AGENT_TOOLS,
  roleAllowsAgentApi,
  type AgentRole,
} from "./agent-roles.ts";

/**
 * ClickAI's agent API for a customer's manually created Sarvam Voice Agent.
 * Sarvam calls it through documented HTTP API tools
 * (docs.sarvam.ai/voice-agents/build/tools/https-tool):
 *
 *   POST /api/public/sarvam/agent/context            on_start  -> agent variables
 *   POST /api/public/sarvam/agent/tools/<tool>       run       -> mid-call answers/actions
 *   POST /api/public/sarvam/agent/tools/record_call_outcome   on_end
 *
 * Authentication: `Authorization: Bearer <integration token>` (Sarvam's
 * "bearer token" auth type, kept as a Sarvam workspace secret). The token is
 * the ONLY thing that identifies the tenant: token -> integration ->
 * organization + agent + that agent's business. A request body can never
 * choose the organization, and every lookup and action is scoped to it.
 *
 * Freshness: nothing is cached. Every request reads the customer's current
 * data from Supabase, so a change saved in the dashboard (e.g. closing time)
 * is what the very next lookup returns.
 *
 * Honesty: missing data is reported as missing (empty value plus a
 * `missing` list and `context_status`), never filled in, and any internal
 * failure answers `context_status: "unavailable"` with an instruction not to
 * state business facts, instead of an error the agent might paper over.
 */

export const TOKEN_PREFIX = "cai_sv_";
const MAX_BODY_BYTES = 16 * 1024;
const MAX_FIELD = 2000;

export const SAFE_GUIDANCE =
  "Only state business facts that appear in these variables or in a get_business_info result. If something is missing or context_status is not ok, do not guess: say you will have the team confirm and offer a callback.";

/* ------------------------------------------------------------------ */
/* Credentials                                                          */
/* ------------------------------------------------------------------ */

export async function hashIntegrationToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A new random token (256 bits), its hash and its display prefix. */
export async function generateIntegrationToken(): Promise<{
  token: string;
  hash: string;
  prefix: string;
}> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const body = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const token = `${TOKEN_PREFIX}${body}`;
  return {
    token,
    hash: await hashIntegrationToken(token),
    prefix: token.slice(0, TOKEN_PREFIX.length + 4),
  };
}

export interface AuthenticatedIntegration {
  integrationId: string;
  organizationId: string;
  agentConfigId: string;
  businessId: string;
  /** E.164 caller numbers whose calls are tests: no booking is written and no lead is created. */
  testCallerNumbers: string[];
  /** Which of the customer's two Sarvam agents holds this credential (agent-roles.ts). */
  role: AgentRole;
}

type Client = SupabaseClient<Database>;

/**
 * A test call: from a number on the customer's test list, or from Sarvam's own test chat and
 * evaluation sessions, which identify the caller by the Sarvam account's email instead of a
 * phone number (phone calls always carry the caller's number).
 */
function isTestCaller(raw: string, phone: string | null, testNumbers: string[]): boolean {
  return raw.includes("@") || Boolean(phone && testNumbers.includes(phone));
}

export async function authenticateIntegration(
  supabaseAdmin: Client,
  authorization: string | null,
  now: Date,
): Promise<{ ok: true; integration: AuthenticatedIntegration } | { ok: false; status: number }> {
  const match = /^Bearer\s+(\S+)$/i.exec(authorization ?? "");
  const token = match?.[1] ?? "";
  if (
    !token.startsWith(TOKEN_PREFIX) ||
    token.length < TOKEN_PREFIX.length + 32 ||
    token.length > 128
  )
    return { ok: false, status: 401 };
  const { data: row } = await supabaseAdmin
    .from("sarvam_agent_integrations")
    .select("id, organization_id, agent_config_id, status, expires_at, test_caller_numbers, role")
    .eq("token_hash", await hashIntegrationToken(token))
    .maybeSingle();
  if (!row || row.status !== "active") return { ok: false, status: 401 };
  // An unknown role fails closed rather than defaulting to the wider inbound rights.
  if (!isAgentRole(row.role)) return { ok: false, status: 401 };
  if (row.expires_at && new Date(row.expires_at).getTime() <= now.getTime())
    return { ok: false, status: 401 };
  const { data: agent } = await supabaseAdmin
    .from("agent_configs")
    .select("organization_id, business_id")
    .eq("id", row.agent_config_id)
    .maybeSingle();
  // The agent (and so its business) must still belong to the integration's organization.
  if (!agent || agent.organization_id !== row.organization_id) return { ok: false, status: 401 };
  return {
    ok: true,
    integration: {
      integrationId: row.id,
      organizationId: row.organization_id,
      agentConfigId: row.agent_config_id,
      businessId: agent.business_id,
      testCallerNumbers: row.test_caller_numbers ?? [],
      role: row.role,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Context -> flat agent variables                                       */
/* ------------------------------------------------------------------ */

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const cap = (s: string, n = MAX_FIELD) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function intervalsText(intervals: unknown): string {
  const list = Array.isArray(intervals) ? intervals : [];
  return list
    .map((i) => {
      const o = (i ?? {}) as Record<string, unknown>;
      const start =
        typeof o["start"] === "string"
          ? o["start"]
          : typeof o["from"] === "string"
            ? o["from"]
            : null;
      const end =
        typeof o["end"] === "string" ? o["end"] : typeof o["to"] === "string" ? o["to"] : null;
      return start && end ? `${start}-${end}` : null;
    })
    .filter(Boolean)
    .join(", ");
}

function money(amount: number | null, currency: string): string | null {
  if (amount === null || amount === undefined) return null;
  return currency === "INR" ? `₹${amount}` : `${amount} ${currency}`;
}

/** Local date, weekday and time in the business's timezone. */
export function localNow(
  now: Date,
  timeZone: string,
): { date: string; weekday: number; time: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      weekday: "short",
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts["weekday"] ?? "");
  return {
    date: `${parts["year"]}-${parts["month"]}-${parts["day"]}`,
    weekday,
    time: `${parts["hour"]}:${parts["minute"]}`,
  };
}

/** Flat string variables for Sarvam's "save reply into variables". Empty string = not configured. */
export function flattenContext(ctx: SarvamClientContext, now: Date): Record<string, string> {
  const b = ctx.business;
  const today = localNow(now, b.timezone);
  const dayText = (day: number) => {
    const h = ctx.hours.find((x) => x.dayOfWeek === day);
    if (!h) return null;
    if (h.isClosed) return "Closed";
    return intervalsText(h.intervals) || "Closed";
  };
  const hoursConfigured = ctx.hours.length > 0;
  const openingHours = hoursConfigured
    ? DAY_NAMES.map((name, i) => `${name}: ${dayText(i) ?? "not set"}`).join("; ")
    : "";
  const services = ctx.services.map((s) => {
    const price = money(s.price, s.currency);
    return `${s.name}${price ? `: ${price}` : ": price not listed"}${s.durationMinutes ? ` (${s.durationMinutes} min)` : ""}`;
  });
  const staff = [
    ...new Set(
      ctx.services.flatMap((s) => {
        const a = s.attributes ?? {};
        const person = a["doctor"] ?? a["stylist"] ?? a["counsel"];
        if (!person) return [];
        return [`${person}${a["specialty"] ? ` (${a["specialty"]})` : ""}: ${s.name}`];
      }),
    ),
  ];
  const address = [b.address, b.city, b.state, b.postalCode].filter(Boolean).join(", ");
  const missing = [
    ...(hoursConfigured ? [] : ["opening hours"]),
    ...(ctx.services.length ? [] : ["services and prices"]),
    ...(address ? [] : ["address"]),
    ...(b.primaryPhone ? [] : ["phone number"]),
  ];
  return {
    context_status: missing.length === 0 ? "ok" : "incomplete",
    missing: missing.join(", "),
    guidance: SAFE_GUIDANCE,
    business_name: b.name,
    // The tenant's own greeting (or the automatic one), spoken as Sarvam's intro.
    greeting: renderGreeting(
      ctx.agent ? customGreetingFor(ctx.agent.greetings, ctx.agent.primaryLanguage) : "",
      { businessName: b.name, agentName: ctx.agent?.name },
    ),
    business_type: b.businessType.replace(/_/g, " "),
    business_description: cap(b.description ?? ""),
    business_address: address,
    business_phone: b.primaryPhone ?? "",
    business_email: b.email ?? "",
    business_website: b.website ?? "",
    business_timezone: b.timezone,
    business_date: today.date,
    business_time: today.time,
    hours_today: hoursConfigured ? (dayText(today.weekday) ?? "not set") : "",
    opening_hours: cap(openingHours),
    services_and_prices: cap(services.join("; ")),
    staff: cap(staff.join("; ")),
    faqs: cap(ctx.faqs.map((f) => `Q: ${f.question} A: ${f.answer}`).join(" | ")),
    policies: cap(ctx.rules.map((r) => r.rule).join(" | ")),
    knowledge: cap(ctx.knowledge.map((k) => `${k.title}: ${k.content}`).join(" | "), 4000),
  };
}

/* ------------------------------------------------------------------ */
/* Services                                                             */
/* ------------------------------------------------------------------ */

const normName = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/**
 * Matches what the agent sent to ONE configured service. The agent is told to
 * send a configured name (translated from the caller's words); this is the
 * guard that it really is one. Never substitutes a different service.
 */
export function matchService<T extends { name: string }>(
  services: T[],
  raw: string,
): { kind: "match"; service: T } | { kind: "ambiguous"; options: T[] } | { kind: "none" } {
  const q = normName(raw);
  if (!q) return { kind: "none" };
  const exact = services.filter((s) => normName(s.name) === q);
  if (exact.length === 1) return { kind: "match", service: exact[0]! };
  const hits =
    q.length < 3
      ? []
      : services.filter((s) => {
          const n = normName(s.name);
          return n.includes(q) || q.includes(n);
        });
  if (hits.length === 1) return { kind: "match", service: hits[0]! };
  if (hits.length > 1) return { kind: "ambiguous", options: hits };
  return { kind: "none" };
}

/** Is the caller's HH:mm an open start time, and if not, the (up to 3) nearest open ones. */
export function requestedTimeAnswer(
  time: string,
  slots: string[],
): { time: string; available: boolean; alternatives: string[] } {
  const mins = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const open = slots.filter((s) => /^\d{2}:\d{2}$/.test(s));
  if (open.includes(time)) return { time, available: true, alternatives: [] };
  const alternatives = [...open]
    .sort(
      (a, b) =>
        Math.abs(mins(a) - mins(time)) - Math.abs(mins(b) - mins(time)) || mins(a) - mins(b),
    )
    .slice(0, 3)
    .sort((a, b) => mins(a) - mins(b));
  return { time, available: false, alternatives };
}

const UNAVAILABLE = (reason: string): Record<string, string> => ({
  context_status: "unavailable",
  missing: "all business information",
  guidance: `${SAFE_GUIDANCE} Business information could not be loaded (${reason}).`,
});

/* ------------------------------------------------------------------ */
/* Request handling                                                      */
/* ------------------------------------------------------------------ */

export interface AgentApiDeps {
  supabaseAdmin: Client;
  now?: () => Date;
  rateLimit?: (key: string) => Promise<{ allowed: boolean; retryAfterSeconds: number }>;
  /** Defaults to ai-tools.server.ts's executeAiTool (capability-gated, tenant from ctx only). */
  executeTool?: (
    ctx: ToolExecutionContext,
    name: string,
    input: Record<string, unknown>,
  ) => Promise<{ content: string; isError?: boolean }>;
}

/** agent_configs.capabilities keys for lead capture and message taking (universal-agent-config.ts). */
export const CALLBACK_CAPABILITY_KEYS = [
  ...(UNIVERSAL_CAPABILITIES.find((c) => c.id === "lead_capture")?.keys ?? []),
  ...(UNIVERSAL_CAPABILITIES.find((c) => c.id === "take_messages")?.keys ?? []),
];

export const AGENT_TOOLS = [
  "get_business_info",
  "check_availability",
  "book_appointment",
  "request_callback",
  "record_call_outcome",
] as const;

/** What actually happened on a call, from ClickAI's own tool log (oldest first). */
export function callFacts(events: { kind: string; status: string; detail: unknown }[]): {
  availability_checked: boolean;
  requested_time_available: boolean | null;
  service_id: string | null;
  booking_outcome: string | null;
  booking_id: string | null;
  booking_error: string | null;
  callback_recorded: boolean;
  lead_id: string | null;
  opted_out: boolean;
} {
  const d = (e: { detail: unknown }) => (e.detail ?? {}) as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === "string" ? v : null);
  const checks = events.filter((e) => e.kind === "check_availability" && e.status === "ok");
  const lastCheck = checks.at(-1);
  const book = events.filter((e) => e.kind === "book_appointment").at(-1);
  const callback = events.find((e) => e.kind === "callback" && e.status === "ok");
  const withService = [...events].reverse().find((e) => s(d(e)["service_id"]));
  return {
    availability_checked: checks.length > 0,
    requested_time_available:
      lastCheck && typeof d(lastCheck)["available"] === "boolean"
        ? (d(lastCheck)["available"] as boolean)
        : null,
    service_id: withService ? s(d(withService)["service_id"]) : null,
    booking_outcome: book
      ? (s(d(book)["outcome"]) ?? (book.status === "ok" ? "unknown" : "not_booked"))
      : null,
    booking_id: book ? s(d(book)["booking_id"]) : null,
    booking_error: book ? s(d(book)["error_code"]) : null,
    callback_recorded: Boolean(callback),
    lead_id: callback ? s(d(callback)["lead_id"]) : null,
    opted_out: events.some((e) => e.kind === "call_outcome" && d(e)["opted_out"] === true),
  };
}
export type AgentTool = (typeof AGENT_TOOLS)[number];

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });

const str = (body: Record<string, unknown>, key: string, max = 500): string | undefined => {
  const v = body[key];
  if (typeof v === "number") return String(v);
  return typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined;
};

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return null;
  if (!text.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function audit(
  deps: AgentApiDeps,
  auth: AuthenticatedIntegration,
  kind: string,
  status: "ok" | "error" | "rejected",
  interactionId: string | undefined,
  detail: Record<string, unknown>,
) {
  await deps.supabaseAdmin
    .from("sarvam_agent_events")
    .insert({
      integration_id: auth.integrationId,
      organization_id: auth.organizationId,
      kind,
      status,
      interaction_id: interactionId ?? null,
      detail: detail as Json,
    })
    .then(
      () => undefined,
      () => undefined,
    );
}

async function defaultExecuteTool(
  supabaseAdmin: Client,
): Promise<NonNullable<AgentApiDeps["executeTool"]>> {
  const { executeAiTool } = await import("./ai-tools.server.ts");
  return (ctx, name, input) => executeAiTool(supabaseAdmin, ctx, name, input);
}

interface LeadInput {
  name: string | null;
  phone: string;
  askedAbout: string | null;
  notes: string | null;
}

/**
 * The id of this call's one lead, derived from (integration, interaction): a
 * retried or recovered save hits the primary key instead of creating a second
 * lead, and an opt-out can find the lead even if its audit row was never written.
 */
export async function callLeadId(integrationId: string, interactionId: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`clickai-call-lead:${integrationId}:${interactionId}`),
    ),
  );
  const hex = Array.from(digest.slice(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
  // RFC 4122 layout (version 5 nibble, variant bits) so it reads as a normal UUID.
  const v = `5${hex.slice(13, 16)}`;
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16) + hex.slice(17, 20);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${v}-${variant}-${hex.slice(20, 32)}`;
}

/**
 * Saves this call's lead under its deterministic id. A repeat finds the row
 * (23505 on the primary key) and reports it as existing, never as a second lead.
 * Returns null when it could not be saved (the error is audited).
 */
async function saveCallLead(
  deps: AgentApiDeps,
  auth: AuthenticatedIntegration,
  interactionId: string | undefined,
  lead: LeadInput,
  integrationId: string = auth.integrationId,
): Promise<{ id: string; created: boolean } | null> {
  const id = interactionId ? await callLeadId(integrationId, interactionId) : undefined;
  const { data, error } = await deps.supabaseAdmin
    .from("leads")
    .insert({
      ...(id ? { id } : {}),
      organization_id: auth.organizationId,
      business_id: auth.businessId,
      name: lead.name,
      phone: lead.phone,
      source: "phone", // leads.source default; other call leads use it too
      asked_about: lead.askedAbout,
      notes: lead.notes,
    })
    .select("id")
    .single();
  if (id && (error as { code?: string } | null)?.code === "23505") return { id, created: false };
  if (error || !data) {
    await audit(deps, auth, "lead", "error", interactionId, {
      error: (error?.message ?? "no row").slice(0, 300),
    });
    return null;
  }
  return { id: data.id, created: true };
}

/**
 * ClickAI's own record of what happened on this call. A failed read throws (the
 * caller answers with a temporary error and writes nothing), so a callback or a
 * lead is never decided on a missing opt-out record.
 */
async function readCallEvents(
  deps: AgentApiDeps,
  auth: AuthenticatedIntegration,
  interactionId: string | undefined,
) {
  if (!interactionId) return [];
  const { data, error } = await deps.supabaseAdmin
    .from("sarvam_agent_events")
    .select("kind, status, detail")
    .eq("integration_id", auth.integrationId)
    .eq("interaction_id", interactionId)
    .in("kind", ["check_availability", "book_appointment", "callback", "call_outcome"])
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data ?? [];
}

/**
 * The number ClickAI itself dialled, when this tool call belongs to one of this
 * customer's outbound calls. The agent sends `clickai_call_id` (the outbound
 * agent variable ClickAI sets; empty on inbound calls). On an outbound call the
 * agent's own caller id comes from Sarvam's user_identifier, which is not
 * verified for instant outbound. When this is known, a booking is made for this
 * dialled number only (outboundCallForTool), and request_callback refuses: no
 * mid-call callback on an outbound call (finalization saves one from
 * outbound_result, on this dialled number, so it is never saved twice). Same
 * organization only; anything else (no id, not a UUID, another customer's
 * call, an inbound call) is null and the tool behaves exactly as before.
 */
export async function dialledNumberForTool(
  deps: AgentApiDeps,
  auth: AuthenticatedIntegration,
  body: Record<string, unknown>,
): Promise<string | null> {
  return (await outboundCallForTool(deps, auth, body, new Date()))?.phone ?? null;
}

/** Statuses of an outbound call that is still going on (Sarvam's result webhook not yet in). */
const OPEN_OUTBOUND_STATUSES = ["initiated", "ringing", "answered", "in_progress"];
/** No outbound call outlives its 300 s cap; a booking for an older call id is refused. */
const OUTBOUND_BOOKING_WINDOW_MS = 15 * 60 * 1000;

/**
 * The customer's own Sarvam outbound call named by the tool body's
 * clickai_call_id: the number ClickAI dialled (canonical E.164) and whether the
 * call is still open (not ended, started within the last 15 minutes).
 */
export async function outboundCallForTool(
  deps: AgentApiDeps,
  auth: AuthenticatedIntegration,
  body: Record<string, unknown>,
  now: Date,
): Promise<{ phone: string | null; open: boolean } | null> {
  const callId = str(body, "clickai_call_id", 64);
  if (!callId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(callId))
    return null;
  const { data, error } = await deps.supabaseAdmin
    .from("call_logs")
    .select("organization_id, provider, direction, destination_number, status, started_at")
    .eq("id", callId)
    .eq("organization_id", auth.organizationId)
    .maybeSingle();
  if (error) throw error;
  if (!data || data.provider !== "sarvam" || data.direction !== "outbound") return null;
  const started = Date.parse(data.started_at ?? "");
  return {
    phone: normalizeCustomerPhone(data.destination_number ?? "", null),
    open:
      OPEN_OUTBOUND_STATUSES.includes(data.status ?? "") &&
      Number.isFinite(started) &&
      now.getTime() - started < OUTBOUND_BOOKING_WINDOW_MS,
  };
}

/** "yes" / "true" (any case) from Sarvam's opted_out agent variable. */
export function isOptedOutValue(value: unknown): boolean {
  return typeof value === "string"
    ? ["yes", "true"].includes(value.trim().toLowerCase())
    : value === true;
}

export interface CallOutcomeInput {
  outcome?: string | undefined;
  summary?: string | undefined;
  customerName?: string | undefined;
  callerNumber?: string | undefined;
  interest?: string | undefined;
  requestedSlot?: string | undefined;
  /** Sarvam's opted_out agent variable, as sent. */
  optedOut?: unknown;
  /** "tool": Sarvam's on-end tool call; "reconciliation": recovered from the call-end webhook. */
  source: "tool" | "reconciliation";
}

/** The lead an outcome row says is due (its outbox entry), as stored in detail.lead. */
type DueLead = {
  name: string | null;
  phone: string;
  asked_about: string | null;
  notes: string | null;
};

/**
 * Completes one outcome row's due lead: saves it under the call's
 * deterministic id (a repeat finds it), then records lead_id on the row so the
 * sweep stops looking. Safe to run any number of times; a lead the team later
 * deletes is never recreated once lead_id is recorded.
 */
export async function completeDueLead(
  deps: AgentApiDeps,
  auth: AuthenticatedIntegration,
  event: { id: string; integration_id: string; interaction_id: string; detail: unknown },
): Promise<string | null> {
  const detail = (event.detail ?? {}) as Record<string, unknown>;
  const due = detail["lead"] as DueLead | undefined;
  if (!due || detail["lead_id"]) return (detail["lead_id"] as string | undefined) ?? null;
  const direction = await resolveLeadDirection(deps, auth, event.interaction_id, due.phone);
  // Held: still due, so the sweep decides again once Sarvam's webhook links the call.
  if (direction === "unknown") return null;
  if (direction !== "inbound") {
    // Not a follow-up: drop the due lead so the sweep stops, and keep why.
    const { lead: _dropped, ...rest } = detail;
    const { error } = await deps.supabaseAdmin
      .from("sarvam_agent_events")
      .update({ detail: { ...rest, lead_skipped: direction } as Json })
      .eq("id", event.id);
    if (error) throw error;
    return null;
  }
  const saved = await saveCallLead(
    deps,
    auth,
    event.interaction_id,
    { name: due.name, phone: due.phone, askedAbout: due.asked_about, notes: due.notes },
    event.integration_id,
  );
  if (!saved) return null; // still due: the next retry or sweep tries again
  // Audited by the attempt that created it (a later attempt finds it and does not).
  if (saved.created)
    await audit(deps, auth, "lead", "ok", event.interaction_id, { lead_id: saved.id });
  const { error } = await deps.supabaseAdmin
    .from("sarvam_agent_events")
    .update({ detail: { ...detail, lead_id: saved.id } as Json })
    .eq("id", event.id);
  if (error) throw error;
  return saved.id;
}

/**
 * Who a due lead belongs to, from what ClickAI has stored, never a time window:
 *   - own_number: the caller number is one of the customer's own numbers;
 *   - inbound / outbound: Sarvam's interaction id matches one of the customer's
 *     Sarvam calls (inbound rows keep it as provider_call_id, outbound rows as
 *     provider_metadata.interaction_id once Sarvam's result webhook arrives);
 *   - inbound: no match yet, and the customer has no unfinished ClickAI outbound
 *     call. Every outbound call is written before it is dialled and stays
 *     unfinished until its result arrives, so the outcome cannot be one;
 *   - unknown: no match yet while an outbound call is unfinished. The lead is
 *     held, and the sweep decides once the webhook links the interaction.
 *
 * The agent's call_outcome uses the inbound taxonomy (a booking the agent must
 * refuse on an outbound call reads as callback_requested), so an outbound
 * outcome is never a lead. An explicit outbound callback request becomes one in
 * call finalization, from outbound_result and ClickAI's own dialled number.
 */
export type LeadDirection = "inbound" | "outbound" | "own_number" | "unknown";

export async function resolveLeadDirection(
  deps: AgentApiDeps,
  auth: AuthenticatedIntegration,
  interactionId: string,
  phone: string,
): Promise<LeadDirection> {
  const db = deps.supabaseAdmin;
  const { data: own, error: ownError } = await db
    .from("phone_numbers")
    .select("id")
    .eq("organization_id", auth.organizationId)
    .eq("e164", phone)
    .neq("status", "released")
    .limit(1);
  if (ownError) throw ownError;
  if ((own ?? []).length > 0) return "own_number";

  for (const column of ["provider_call_id", "provider_metadata->>interaction_id"]) {
    const { data, error } = await db
      .from("call_logs")
      .select("direction")
      .eq("organization_id", auth.organizationId)
      .eq("provider", "sarvam")
      .eq(column, interactionId)
      .limit(1);
    if (error) throw error;
    const direction = data?.[0]?.direction;
    if (direction === "outbound" || direction === "inbound") return direction;
  }

  const { data: open, error: openError } = await db
    .from("call_logs")
    .select("id")
    .eq("organization_id", auth.organizationId)
    .eq("provider", "sarvam")
    .eq("direction", "outbound")
    .in("status", [...UNRESOLVED_SARVAM_STATUSES])
    .limit(1);
  if (openError) throw openError;
  return (open ?? []).length > 0 ? "unknown" : "inbound";
}

/**
 * Records one call's outcome — once per (integration, interaction), enforced by
 * idx_sarvam_agent_events_one_outcome — and at most one lead. Safe to run any
 * number of times from the tool call and the reconciliation job, in any order
 * or at the same time:
 *   - an opt-out first marks this call's lead (its deterministic id; a callback
 *     lead saved mid-call has the same id) as do_not_contact; idempotent;
 *   - the outcome row is the single audit record and also the lead's outbox:
 *     detail.lead holds a due lead, detail.lead_id is set once it is saved;
 *   - every attempt, including a duplicate, completes a still-due lead, and the
 *     sweep does the same for rows nobody retries — so a crash between the
 *     outcome row and the lead never loses the lead, and never doubles it.
 */
export async function recordCallOutcome(
  deps: AgentApiDeps,
  auth: AuthenticatedIntegration,
  interactionId: string | undefined,
  input: CallOutcomeInput,
): Promise<{ duplicate: boolean; leadId: string | null }> {
  // `facts` come from ClickAI's own tool log for this call, never from the LLM's summary.
  const facts = callFacts(await readCallEvents(deps, auth, interactionId));
  const optedOut = isOptedOutValue(input.optedOut);
  const callerRaw = input.callerNumber ?? "";
  const callerPhone = normalizeCustomerPhone(callerRaw.slice(0, 40), null);
  const testCall = isTestCaller(callerRaw, callerPhone, auth.testCallerNumbers);

  let suppressedLeadId: string | null = null;
  if (optedOut && interactionId) {
    const ownLead = await callLeadId(auth.integrationId, interactionId);
    const { data: updated, error: suppressError } = await deps.supabaseAdmin
      .from("leads")
      .update({ status: "do_not_contact" })
      .in("id", [...new Set([ownLead, facts.lead_id].filter((x): x is string => Boolean(x)))])
      .eq("organization_id", auth.organizationId)
      .select("id");
    if (suppressError) throw suppressError;
    suppressedLeadId = updated?.[0]?.id ?? null;
  }

  // An opt-out on an outbound call goes on the do-not-call list now, not only
  // through the end-of-call webhook (which may be lost) - and only for a number
  // ClickAI itself dialled in the last hour, so a test chat or a forged
  // caller_number cannot suppress anyone else.
  if (optedOut && auth.role === "outbound" && callerPhone && !testCall) {
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { data: dialled, error: dialledError } = await deps.supabaseAdmin
      .from("call_logs")
      .select("id")
      .eq("organization_id", auth.organizationId)
      .eq("direction", "outbound")
      .eq("destination_number", callerPhone)
      .gt("started_at", since)
      .limit(1);
    if (dialledError) throw dialledError;
    if (dialled?.length) {
      const { suppressSingleCallOptOut } = await import("./telephony/call-finalization.server.ts");
      await suppressSingleCallOptOut(
        deps.supabaseAdmin,
        {
          organization_id: auth.organizationId,
          business_id: auth.businessId,
          destination_number: callerPhone,
        },
        { opted_out: "yes" },
      );
    }
  }

  // A lead is a follow-up for the team: callback requests, and enquiries where the caller
  // named themself or a service. Booked calls already have a booking; a summary alone never
  // qualifies; a callback already saved mid-call (request_callback) is not saved twice.
  const kind = input.outcome?.toLowerCase();
  const qualifies =
    kind === "callback_requested" ||
    (kind === "enquiry_answered" && Boolean(input.customerName || input.interest));
  // Direction is decided when the lead is saved (completeDueLead), not here.
  const leadDue: DueLead | null =
    qualifies && !optedOut && !testCall && !facts.callback_recorded && callerPhone && interactionId
      ? {
          name: input.customerName ?? null,
          phone: callerPhone,
          asked_about: input.interest ?? input.outcome ?? null,
          notes: input.summary ?? null,
        }
      : null;

  const outcome = {
    outcome: input.outcome,
    summary: input.summary,
    customer_name: input.customerName,
    caller_number: callerRaw.slice(0, 40) || undefined,
    interest: input.interest,
    requested_slot: input.requestedSlot,
    // The person asked not to be contacted again: never a lead, whatever the outcome says.
    opted_out: optedOut,
    ...(optedOut ? { suppressed_lead_id: suppressedLeadId } : {}),
    source: input.source,
    facts,
    ...(testCall ? { test_call: true } : {}),
    ...(leadDue ? { lead: leadDue } : {}),
  };
  const { data: inserted, error: insertError } = await deps.supabaseAdmin
    .from("sarvam_agent_events")
    .insert({
      integration_id: auth.integrationId,
      organization_id: auth.organizationId,
      kind: "call_outcome",
      status: "ok",
      interaction_id: interactionId ?? null,
      detail: outcome as Json,
    })
    .select("id")
    .single();
  if ((insertError as { code?: string } | null)?.code === "23505") {
    // Already recorded: finish its lead if an earlier attempt stopped before saving it.
    const { data: existing, error: readError } = await deps.supabaseAdmin
      .from("sarvam_agent_events")
      .select("id, integration_id, interaction_id, detail")
      .eq("integration_id", auth.integrationId)
      .eq("interaction_id", interactionId!)
      .eq("kind", "call_outcome")
      .maybeSingle();
    if (readError) throw readError;
    if (existing) await completeDueLead(deps, auth, existing as never);
    return { duplicate: true, leadId: null };
  }
  if (insertError || !inserted) throw insertError ?? new Error("outcome not recorded");
  if (!leadDue) return { duplicate: false, leadId: null };
  const leadId = await completeDueLead(deps, auth, {
    id: inserted.id,
    integration_id: auth.integrationId,
    interaction_id: interactionId!,
    detail: outcome,
  });
  return { duplicate: false, leadId };
}

/** Entry point shared by the two public routes. `tool` is undefined for the on-start context. */
export async function handleSarvamAgentRequest(
  request: Request,
  tool: string | undefined,
  deps: AgentApiDeps,
): Promise<Response> {
  const now = deps.now?.() ?? new Date();
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (tool !== undefined && !(AGENT_TOOLS as readonly string[]).includes(tool))
    return json({ error: "unknown_tool" }, 404);

  const authResult = await authenticateIntegration(
    deps.supabaseAdmin,
    request.headers.get("authorization"),
    now,
  );
  if (!authResult.ok) return json({ error: "unauthorized" }, 401);
  const auth = authResult.integration;

  if (deps.rateLimit) {
    const decision = await deps.rateLimit(`agent:${auth.integrationId}`);
    if (!decision.allowed)
      return json({ error: "rate_limited" }, 429, {
        "retry-after": String(decision.retryAfterSeconds),
      });
  }

  // Role gate: an outbound agent's credential can never request a callback or
  // reach any write tool except booking (bound to its own open call, below),
  // whatever the agent sends. Checked
  // before admission and before the body is read, so nothing else runs.
  if (!roleAllowsAgentApi(auth.role, tool)) {
    await audit(deps, auth, tool ?? "context", "rejected", undefined, {
      error_code: "OUTBOUND_AGENT_TOOL_FORBIDDEN",
      role: auth.role,
    });
    return json(
      {
        ok: false,
        error: "forbidden_for_outbound_agent",
        guidance:
          "This call cannot arrange callbacks or send messages. Give the business phone number from the business facts instead.",
      },
      403,
    );
  }

  // Admission gate: no business data or tool action unless this customer's
  // number is ACTIVE with a verified deployment mapping (inbound agent), or
  // the customer's own outbound agent is registered (outbound agent). Fails closed.
  const admission =
    auth.role === "outbound"
      ? await checkOutboundAgentAdmission(deps.supabaseAdmin, {
          organizationId: auth.organizationId,
          agentConfigId: auth.agentConfigId,
        })
      : await checkInboundAdmission(deps.supabaseAdmin, {
          organizationId: auth.organizationId,
          agentConfigId: auth.agentConfigId,
        });
  if (!admission.admitted) {
    await audit(deps, auth, tool ?? "context", "rejected", undefined, {
      error_code: "NOT_ADMITTED",
      reason: admission.reason,
    });
    return json({ error: "not_admitted", guidance: SAFE_GUIDANCE }, 403);
  }

  const body = await readBody(request);
  if (!body) return json({ error: "invalid_body" }, 400);
  const interactionId = str(body, "interaction_id", 200);

  await deps.supabaseAdmin
    .from("sarvam_agent_integrations")
    .update({ last_used_at: now.toISOString() })
    .eq("id", auth.integrationId)
    .then(
      () => undefined,
      () => undefined,
    );

  try {
    if (tool === undefined || tool === "get_business_info") {
      const ctx = await buildSarvamClientContext(deps.supabaseAdmin, auth.organizationId);
      const vars = ctx ? flattenContext(ctx, now) : UNAVAILABLE("no business profile");
      await audit(deps, auth, tool ? "get_business_info" : "context", "ok", interactionId, {
        context_status: vars["context_status"],
      });
      return json(vars);
    }

    const toolCtx: ToolExecutionContext = {
      organizationId: auth.organizationId,
      businessId: auth.businessId,
      agentConfigId: auth.agentConfigId,
      // Booking idempotency per Sarvam call + slot (voiceBookingIdempotencyKey).
      ...(interactionId ? { callId: `sarvam-${interactionId}` } : {}),
      source: "voice",
    };
    const execute = deps.executeTool ?? (await defaultExecuteTool(deps.supabaseAdmin));

    if (tool === "check_availability" || tool === "book_appointment") {
      const date = str(body, "date", 10);
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date))
        return json({ ok: false, error: "date must be YYYY-MM-DD" }, 400);
      const { data: business } = await deps.supabaseAdmin
        .from("businesses")
        .select("organization_id, timezone, default_appointment_duration_minutes")
        .eq("id", auth.businessId)
        .maybeSingle();
      if (!business || business.organization_id !== auth.organizationId)
        return json({ ok: false, error: "business_not_found", guidance: SAFE_GUIDANCE });
      const serviceName = str(body, "service_name", 200);
      // Agents built for service validation send require_service; older agent versions
      // keep the lenient behaviour so a deploy never changes a live version's calls.
      const requireService = body["require_service"] === true || body["require_service"] === "true";
      let duration =
        Number(str(body, "duration_minutes", 4)) || business.default_appointment_duration_minutes;
      let service: { id: string; name: string } | null = null;
      if (serviceName || requireService) {
        const { data: services } = await deps.supabaseAdmin
          .from("services")
          .select("id, name, duration_minutes")
          .eq("business_id", auth.businessId)
          .eq("is_active", true);
        const list = services ?? [];
        const match = serviceName ? matchService(list, serviceName) : ({ kind: "none" } as const);
        if (match.kind === "match") {
          service = { id: match.service.id, name: match.service.name };
          if (match.service.duration_minutes) duration = match.service.duration_minutes;
        } else if (requireService && list.length > 0) {
          const code = !serviceName
            ? "SERVICE_REQUIRED"
            : match.kind === "ambiguous"
              ? "SERVICE_AMBIGUOUS"
              : "SERVICE_NOT_OFFERED";
          const options = (match.kind === "ambiguous" ? match.options : list).map((s) => s.name);
          await audit(deps, auth, tool, "rejected", interactionId, {
            date,
            service_name: serviceName ?? null,
            error_code: code,
          });
          return json({
            ok: true,
            result: { success: false, error: { code, requested: serviceName ?? "", options } },
          });
        }
      }

      if (tool === "check_availability") {
        const out = await execute(toolCtx, "check_calendar_availability", {
          dateIso: date,
          durationMinutes: duration,
        });
        // Keep the UTC slots and add the business's wall-clock HH:mm, so the agent never
        // converts time zones itself (Intl applies the zone's DST rules for each instant).
        const result = JSON.parse(out.content) as {
          success?: boolean;
          data?: { slots?: { start: string; end: string; start_local?: string }[] };
        };
        if (result.success && Array.isArray(result.data?.slots)) {
          result.data.slots = result.data.slots.map((s) => ({
            ...s,
            start_local: localNow(new Date(s.start), business.timezone).time,
            end_local: localNow(new Date(s.end), business.timezone).time,
          }));
        }
        // The caller's own time, answered by the server, so the agent never decides "free or not".
        const wanted = str(body, "time", 5);
        const requestedTime =
          wanted && /^\d{2}:\d{2}$/.test(wanted) && result.success
            ? requestedTimeAnswer(
                wanted,
                (result.data?.slots ?? []).map((s) => s.start_local ?? ""),
              )
            : null;
        await audit(deps, auth, "check_availability", out.isError ? "error" : "ok", interactionId, {
          date,
          service_id: service?.id ?? null,
          ...(requestedTime ? { requested_time: wanted, available: requestedTime.available } : {}),
        });
        return json({
          ok: !out.isError,
          duration_minutes: duration,
          timezone: business.timezone,
          service,
          requested_time: requestedTime,
          result,
        });
      }

      if (!interactionId)
        return json({ ok: false, error: "interaction_id is required to book" }, 400);
      const time = str(body, "time", 5);
      if (!time || !/^\d{2}:\d{2}$/.test(time))
        return json({ ok: false, error: "time must be HH:mm" }, 400);
      // On a call ClickAI placed, the booking is for the number ClickAI dialled,
      // taken from its own call row; the provider's caller id (customer_phone,
      // unverified on instant outbound) is never used. An outbound-role
      // credential books only on such a call while it is still open.
      const outboundCall = await outboundCallForTool(deps, auth, body, now);
      const refuse = async (code: string, message: string) => {
        await audit(deps, auth, "book_appointment", "rejected", interactionId, {
          date,
          time,
          outbound_call: true,
          error_code: code,
        });
        return json({
          ok: true,
          outbound_call: true,
          result: { success: false, error: { code, message } },
        });
      };
      if (outboundCall && (!outboundCall.open || !outboundCall.phone))
        return refuse(
          "OUTBOUND_CALL_NOT_OPEN",
          "Not booked: this call can no longer book. Tell the person it is not booked and give them the business phone number.",
        );
      if (!outboundCall && auth.role === "outbound")
        return refuse(
          "OUTBOUND_CALL_NOT_VERIFIED",
          "Not booked: ClickAI could not identify this call. Tell the person it is not booked and give them the business phone number.",
        );
      if (outboundCall && !str(body, "customer_name", 200))
        return refuse(
          "CUSTOMER_NAME_REQUIRED",
          "Not booked yet: ask for the person's name, then book again.",
        );
      const caller = outboundCall?.phone ?? str(body, "customer_phone", 200) ?? "";
      const phone = normalizeCustomerPhone(caller, null);
      const start = zonedWallTimeToUtc(date, time, business.timezone);
      const end = new Date(start.getTime() + duration * 60_000);
      if (isTestCaller(caller, phone, auth.testCallerNumbers)) {
        // Test call: check the slot exactly as a booking would, but never write a booking.
        const avail = await execute(toolCtx, "check_calendar_availability", {
          dateIso: date,
          durationMinutes: duration,
        });
        const slots =
          (JSON.parse(avail.content) as { data?: { slots?: { start: string }[] } }).data?.slots ??
          [];
        const free = slots.some((s) => new Date(s.start).getTime() === start.getTime());
        await audit(deps, auth, "book_appointment", "ok", interactionId, {
          date,
          time,
          service_id: service?.id ?? null,
          test_call: true,
          slot_free: free,
          outcome: "not_booked",
          error_code: "TEST_CALL_NOT_SAVED",
        });
        return json({
          ok: true,
          test_call: true,
          result: {
            success: false,
            error: {
              code: "TEST_CALL_NOT_SAVED",
              message: `Test call: ${time} on ${date} is ${free ? "free" : "not free"}, and test calls are never booked`,
            },
          },
        });
      }
      const out = await execute(toolCtx, "book_appointment", {
        customerName: str(body, "customer_name", 200),
        ...(phone ? { customerPhone: phone } : {}),
        startIso: start.toISOString(),
        endIso: end.toISOString(),
        ...(service ? { serviceId: service.id } : {}),
        notes: service
          ? `Service: ${service.name}`
          : serviceName
            ? `Service: ${serviceName}`
            : undefined,
      });
      const booked = JSON.parse(out.content) as {
        success?: boolean;
        bookingOutcome?: string;
        data?: { id?: string };
        error?: { code?: string };
      };
      await audit(deps, auth, "book_appointment", out.isError ? "error" : "ok", interactionId, {
        date,
        time,
        service_id: service?.id ?? null,
        outcome: booked.success ? (booked.bookingOutcome ?? "unknown") : "not_booked",
        booking_id: booked.success ? (booked.data?.id ?? null) : null,
        error_code: booked.error?.code ?? null,
        ...(outboundCall ? { outbound_call: true } : {}),
      });
      return json({ ok: !out.isError, service, result: booked });
    }

    const saveLead = async (lead: LeadInput) =>
      (await saveCallLead(deps, auth, interactionId, lead))?.id ?? null;
    const callEvents = () => readCallEvents(deps, auth, interactionId);

    if (tool === "request_callback") {
      // Mid-call: the agent promises a callback only after this reports recorded=true.
      if (!interactionId)
        return json({ ok: false, error: "interaction_id is required to record a callback" }, 400);
      if (await dialledNumberForTool(deps, auth, body)) {
        await audit(deps, auth, "callback", "rejected", interactionId, {
          outbound_call: true,
          error_code: "OUTBOUND_USE_CALL_RESULT",
        });
        return json({
          ok: true,
          recorded: false,
          outbound_call: true,
          error: {
            code: "OUTBOUND_USE_CALL_RESULT",
            message:
              "On calls the business places, set outbound_result to callback_requested; the callback is saved when the call ends.",
          },
        });
      }
      // Only customers with lead capture or message taking switched on may record callbacks.
      const { data: agentRow, error: agentError } = await deps.supabaseAdmin
        .from("agent_configs")
        .select("organization_id, capabilities")
        .eq("id", auth.agentConfigId)
        .maybeSingle();
      if (agentError) throw agentError;
      const caps = (agentRow?.capabilities ?? {}) as Record<string, boolean>;
      if (
        !agentRow ||
        agentRow.organization_id !== auth.organizationId ||
        !CALLBACK_CAPABILITY_KEYS.some((k) => caps[k] === true)
      ) {
        await audit(deps, auth, "callback", "rejected", interactionId, {
          error_code: "CAPABILITY_DISABLED",
        });
        return json({ ok: true, recorded: false, error: { code: "CAPABILITY_DISABLED" } });
      }
      const known = callFacts(await callEvents());
      // An opt-out recorded for this call (by record_call_outcome) wins over any later callback.
      if (known.opted_out) {
        await audit(deps, auth, "callback", "rejected", interactionId, {
          error_code: "CALLER_OPTED_OUT",
        });
        return json({ ok: true, recorded: false, error: { code: "CALLER_OPTED_OUT" } });
      }
      if (known.callback_recorded) return json({ ok: true, recorded: true, duplicate: true });
      const raw = str(body, "caller_number", 200) ?? "";
      const phone = normalizeCustomerPhone(raw, null);
      if (isTestCaller(raw, phone, auth.testCallerNumbers)) {
        // Test callers follow the success path so conversations can be tested; nothing is saved.
        await audit(deps, auth, "callback", "ok", interactionId, {
          test_call: true,
          lead_id: null,
        });
        return json({ ok: true, recorded: true, test_call: true });
      }
      if (!phone) {
        await audit(deps, auth, "callback", "rejected", interactionId, {
          error_code: "NO_CALLER_NUMBER",
        });
        return json({ ok: true, recorded: false, error: { code: "NO_CALLER_NUMBER" } });
      }
      const leadId = await saveLead({
        name: str(body, "customer_name", 200) ?? null,
        phone,
        askedAbout: str(body, "reason", 200) ?? "callback_requested",
        notes: str(body, "notes", 1000) ?? null,
      });
      await audit(deps, auth, "callback", leadId ? "ok" : "error", interactionId, {
        lead_id: leadId,
        ...(leadId ? {} : { error_code: "LEAD_NOT_SAVED" }),
      });
      return json(
        leadId
          ? { ok: true, recorded: true }
          : { ok: true, recorded: false, error: { code: "LEAD_NOT_SAVED" } },
      );
    }

    // record_call_outcome (on_end): the same idempotent path the reconciliation job uses.
    const recorded = await recordCallOutcome(deps, auth, interactionId, {
      outcome: str(body, "outcome", 100),
      summary: str(body, "summary", 2000),
      customerName: str(body, "customer_name", 200),
      callerNumber: str(body, "caller_number", 200),
      interest: str(body, "interest", 200),
      requestedSlot: str(body, "requested_slot", 200),
      optedOut: str(body, "opted_out", 10),
      source: "tool",
    });
    return json({ ok: true, duplicate: recorded.duplicate });
  } catch (err) {
    console.error("sarvam_agent:error", { tool: tool ?? "context", error: (err as Error).message });
    await audit(deps, auth, tool ?? "context", "error", interactionId, {
      error: (err as Error).message.slice(0, 300),
    });
    return json(
      tool === undefined || tool === "get_business_info"
        ? UNAVAILABLE("temporary error")
        : { ok: false, error: "temporary_error", guidance: SAFE_GUIDANCE },
    );
  }
}

/* ------------------------------------------------------------------ */
/* What to configure in Sarvam (rendered in the admin brief)             */
/* ------------------------------------------------------------------ */

export interface SarvamToolSpec {
  name: string;
  lifecycle: "on_start" | "run" | "on_end";
  method: "POST";
  url: string;
  auth: string;
  body: Record<string, string>;
  saveIntoVariables?: string[];
  purpose: string;
}

/**
 * The HTTP API tools to create on the customer's Sarvam agent, using only
 * documented options: lifecycle on_start / run / on_end, POST with a JSON
 * body, bearer-token auth from a Sarvam secret, call-context variables
 * (User Identifier, Interaction ID) and agent variables inserted with `@`,
 * and "save reply into variables" for on_start.
 */
export interface SarvamToolConfiguration {
  role: AgentRole;
  tools: SarvamToolSpec[];
  inputVariables: { name: string; defaultValue: string }[];
  outputVariables: { name: string; type: string; extractionPrompt: string }[];
  promptGuard: string;
  /** The agent's complete system prompt, composed from the shared core (sarvam-agent-prompt.ts). */
  systemPrompt: string;
  allowlistIps: string[];
}

/** What the generated prompt depends on: the customer's tools and business category. */
export interface SarvamTemplateOptions {
  /** ClickAI tools this customer's agent has (from its capabilities). Defaults to the role's full set. */
  tools?: readonly string[];
  /** Dental or medical business: emergency and medical-advice guidance. */
  healthcare?: boolean;
}

/**
 * The configuration for one of the customer's two agents. The outbound agent
 * gets only OUTBOUND_AGENT_TOOLS (agent-roles.ts) that the customer's
 * capabilities allow, the variables ClickAI sets on every outbound call and an
 * opt-out output; ClickAI's API refuses anything else from its credential
 * anyway. Both get a system prompt from the same shared core.
 */
export function sarvamToolConfiguration(
  baseUrl: string,
  role: AgentRole = "inbound",
  options: SarvamTemplateOptions = {},
): SarvamToolConfiguration {
  const inbound = inboundToolConfiguration(baseUrl);
  const healthcare = options.healthcare ?? false;
  if (role === "inbound") {
    const tools = options.tools ?? inbound.tools.map((t) => t.name);
    return {
      role,
      ...inbound,
      systemPrompt: buildSarvamAgentPrompt({ role, tools, healthcare }),
    };
  }
  const allowed = new Set<string>(
    OUTBOUND_AGENT_TOOLS.filter((t) => !options.tools || options.tools.includes(t)),
  );
  const tools = inbound.tools.filter((t) => allowed.has(t.name));
  const promptOptions = { role, tools: tools.map((t) => t.name), healthcare } as const;
  return {
    role,
    tools,
    inputVariables: [
      ...inbound.inputVariables,
      { name: "call_direction", defaultValue: "outbound" },
      { name: "clickai_call_id", defaultValue: "" },
      { name: "campaign_objective", defaultValue: "" },
      { name: "campaign_instructions", defaultValue: "" },
    ],
    outputVariables: [
      ...inbound.outputVariables,
      {
        name: "opted_out",
        type: "Enum: yes, no",
        extractionPrompt:
          "yes only if the person clearly asked not to be called again or to be removed; otherwise no.",
      },
      // Read by outbound call finalization (call-variables.ts OUTBOUND_RETAINED_VARIABLES):
      // campaign decisions, the lead score and the one explicit-callback lead.
      {
        name: "wrong_number",
        type: "Enum: yes, no",
        extractionPrompt:
          "yes only if the person said it is the wrong number or that they are not the person the business meant to reach; otherwise no.",
      },
      {
        name: "interest_level",
        type: "Enum: high, medium, low, none",
        extractionPrompt:
          "none if the person asked not to be called again, was the wrong person, was an answering machine, declined, or there was no real conversation. Otherwise high (wanted an appointment), medium (asked questions or wanted to be contacted later), low (listened but undecided).",
      },
      {
        name: "outbound_result",
        type: "Enum: interested, not_interested, callback_requested, opted_out, wrong_person, voicemail, no_conversation",
        extractionPrompt:
          "Answer in order and stop at the first yes: asked not to be called or contacted again → opted_out; wrong number or not the person meant → wrong_person; answering machine, beep or recorded greeting → voicemail; no real conversation → no_conversation; explicitly asked to be contacted later → callback_requested; clearly declined → not_interested; otherwise interested.",
      },
    ],
    promptGuard: sarvamPromptGuardrails(promptOptions),
    systemPrompt: buildSarvamAgentPrompt(promptOptions),
    allowlistIps: inbound.allowlistIps,
  };
}

function inboundToolConfiguration(
  baseUrl: string,
): Omit<SarvamToolConfiguration, "role" | "systemPrompt"> {
  const auth = "Bearer token: the Sarvam secret holding this customer's ClickAI integration token";
  const base = `${baseUrl.replace(/\/+$/, "")}/api/public/sarvam/agent`;
  const contextVars = [
    "context_status",
    "missing",
    "guidance",
    "business_name",
    "greeting",
    "business_type",
    "business_description",
    "business_address",
    "business_phone",
    "business_email",
    "business_website",
    "business_timezone",
    "business_date",
    "business_time",
    "hours_today",
    "opening_hours",
    "services_and_prices",
    "staff",
    "faqs",
    "policies",
    "knowledge",
  ];
  return {
    tools: [
      {
        name: "clickai_business_context",
        lifecycle: "on_start",
        method: "POST",
        url: `${base}/context`,
        auth,
        body: { interaction_id: "@Interaction ID", caller_number: "@User Identifier" },
        saveIntoVariables: contextVars,
        purpose:
          "Loads this business's current profile, hours, services, prices and FAQs before the agent speaks.",
      },
      {
        name: "get_business_info",
        lifecycle: "run",
        method: "POST",
        url: `${base}/tools/get_business_info`,
        auth,
        body: { interaction_id: "@Interaction ID" },
        purpose:
          "Re-reads the latest business information mid-call (hours, prices, services, staff, FAQs).",
      },
      {
        name: "check_availability",
        lifecycle: "run",
        method: "POST",
        url: `${base}/tools/check_availability`,
        auth,
        body: {
          interaction_id: "@Interaction ID",
          date: "YYYY-MM-DD (from the caller)",
          service_name:
            "one service name exactly as configured (translated from the caller's words)",
          time: "HH:mm the caller asked for (optional); the reply says if it is free",
          require_service: "true (constant): reject services this business does not offer",
        },
        purpose:
          "Real free appointment slots for that date, and whether the caller's time is free. Never offer a time this did not return.",
      },
      {
        name: "book_appointment",
        lifecycle: "run",
        method: "POST",
        url: `${base}/tools/book_appointment`,
        auth,
        body: {
          interaction_id: "@Interaction ID",
          date: "YYYY-MM-DD",
          time: "HH:mm (24-hour, business local time)",
          service_name: "the configured service name",
          customer_name: "the caller's name",
          customer_phone: "@User Identifier",
          clickai_call_id: "@clickai_call_id",
          require_service: "true (constant)",
        },
        purpose: 'Books the slot. Say it is booked only when result.bookingOutcome is "confirmed".',
      },
      {
        name: "request_callback",
        lifecycle: "run",
        method: "POST",
        url: `${base}/tools/request_callback`,
        auth,
        body: {
          interaction_id: "@Interaction ID",
          caller_number: "@User Identifier",
          clickai_call_id: "@clickai_call_id",
          customer_name: "the caller's name",
          reason: "what the team should call back about",
        },
        purpose:
          "Saves a callback request as a lead now. Promise a callback only when it replies recorded=true.",
      },
      {
        name: "record_call_outcome",
        lifecycle: "on_end",
        method: "POST",
        url: `${base}/tools/record_call_outcome`,
        auth,
        body: {
          interaction_id: "@Interaction ID",
          caller_number: "@User Identifier",
          outcome: "@call_outcome",
          summary: "@call_summary",
          customer_name: "@customer_name",
          interest: "@caller_interest",
          requested_slot: "@requested_slot",
          opted_out: "@opted_out",
        },
        purpose:
          "Records the call's outcome once per call and saves a lead for callback requests and named enquiries, never for a caller who opted out.",
      },
    ],
    inputVariables: contextVars.map((name) => ({
      name,
      defaultValue: name === "context_status" ? "unavailable" : "",
    })),
    outputVariables: [
      {
        name: "call_outcome",
        type: "Enum: booked, enquiry_answered, callback_requested, not_interested, other",
        extractionPrompt: "What the call achieved for the caller.",
      },
      {
        name: "call_summary",
        type: "String",
        extractionPrompt: "Two sentences: what the caller wanted and what was agreed.",
      },
      {
        name: "customer_name",
        type: "String",
        extractionPrompt: "The caller's name if they gave it, otherwise empty.",
      },
      {
        name: "caller_interest",
        type: "String",
        extractionPrompt: "The service the caller asked about, otherwise empty.",
      },
      {
        name: "requested_slot",
        type: "String",
        extractionPrompt:
          "The date and time the caller asked for (YYYY-MM-DD HH:mm), otherwise empty.",
      },
    ],
    promptGuard: `Business facts come only from the ClickAI variables (business_name, opening_hours, hours_today, services_and_prices, staff, faqs, policies; insert them with @) or the get_business_info tool. If context_status is not "ok", or a value is empty, never guess: say the team will confirm and offer a callback. Only offer times check_availability returned, and say an appointment is booked only when book_appointment returns bookingOutcome "confirmed".`,
    allowlistIps: ["4.213.167.70", "35.154.84.150"],
  };
}
