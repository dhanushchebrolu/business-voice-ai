import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/integrations/supabase/types";
import {
  buildSarvamClientContext,
  type SarvamClientContext,
} from "./sarvam-client-context.server.ts";
import type { ToolExecutionContext } from "./ai-tools.server.ts";
import { zonedWallTimeToUtc } from "./calendar/timezone.ts";
import { normalizeCustomerPhone } from "./phone-number.ts";

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
}

type Client = SupabaseClient<Database>;

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
    .select("id, organization_id, agent_config_id, status, expires_at, test_caller_numbers")
    .eq("token_hash", await hashIntegrationToken(token))
    .maybeSingle();
  if (!row || row.status !== "active") return { ok: false, status: 401 };
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

export const AGENT_TOOLS = [
  "get_business_info",
  "check_availability",
  "book_appointment",
  "record_call_outcome",
] as const;
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
      let duration =
        Number(str(body, "duration_minutes", 4)) || business.default_appointment_duration_minutes;
      if (serviceName) {
        const { data: services } = await deps.supabaseAdmin
          .from("services")
          .select("name, duration_minutes")
          .eq("business_id", auth.businessId)
          .eq("is_active", true);
        const hit = (services ?? []).find((s) =>
          s.name.toLowerCase().includes(serviceName.toLowerCase()),
        );
        if (hit?.duration_minutes) duration = hit.duration_minutes;
      }

      if (tool === "check_availability") {
        const out = await execute(toolCtx, "check_calendar_availability", {
          dateIso: date,
          durationMinutes: duration,
        });
        await audit(deps, auth, "check_availability", out.isError ? "error" : "ok", interactionId, {
          date,
        });
        // Keep the UTC slots and add the business's wall-clock HH:mm, so the agent never
        // converts time zones itself (Intl applies the zone's DST rules for each instant).
        const result = JSON.parse(out.content) as {
          success?: boolean;
          data?: { slots?: { start: string; end: string }[] };
        };
        if (result.success && Array.isArray(result.data?.slots)) {
          result.data.slots = result.data.slots.map((s) => ({
            ...s,
            start_local: localNow(new Date(s.start), business.timezone).time,
            end_local: localNow(new Date(s.end), business.timezone).time,
          }));
        }
        return json({
          ok: !out.isError,
          duration_minutes: duration,
          timezone: business.timezone,
          result,
        });
      }

      if (!interactionId)
        return json({ ok: false, error: "interaction_id is required to book" }, 400);
      const time = str(body, "time", 5);
      if (!time || !/^\d{2}:\d{2}$/.test(time))
        return json({ ok: false, error: "time must be HH:mm" }, 400);
      const phone = normalizeCustomerPhone(str(body, "customer_phone", 40) ?? "", null);
      const start = zonedWallTimeToUtc(date, time, business.timezone);
      const end = new Date(start.getTime() + duration * 60_000);
      if (phone && auth.testCallerNumbers.includes(phone)) {
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
          test_call: true,
          slot_free: free,
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
        notes: serviceName ? `Service: ${serviceName}` : undefined,
      });
      await audit(deps, auth, "book_appointment", out.isError ? "error" : "ok", interactionId, {
        date,
        time,
      });
      return json({ ok: !out.isError, result: JSON.parse(out.content) });
    }

    // record_call_outcome (on_end): once per interaction; a lead only for a qualified follow-up (below).
    const outcome = {
      outcome: str(body, "outcome", 100),
      summary: str(body, "summary", 2000),
      customer_name: str(body, "customer_name", 200),
      caller_number: str(body, "caller_number", 40),
      interest: str(body, "interest", 200),
    };
    const callerPhone = normalizeCustomerPhone(outcome.caller_number ?? "", null);
    const testCall = Boolean(callerPhone && auth.testCallerNumbers.includes(callerPhone));
    const { error: dupError } = await deps.supabaseAdmin.from("sarvam_agent_events").insert({
      integration_id: auth.integrationId,
      organization_id: auth.organizationId,
      kind: "call_outcome",
      status: "ok",
      interaction_id: interactionId ?? null,
      detail: (testCall ? { ...outcome, test_call: true } : outcome) as Json,
    });
    if (dupError && (dupError as { code?: string }).code === "23505")
      return json({ ok: true, duplicate: true });
    if (dupError) throw dupError;
    // A lead is a follow-up for the team: callback requests, and enquiries where the caller
    // named themself or a service. Booked calls already have a booking; a summary alone never qualifies.
    const kind = outcome.outcome?.toLowerCase();
    const qualifies =
      kind === "callback_requested" ||
      (kind === "enquiry_answered" && Boolean(outcome.customer_name || outcome.interest));
    const phone = qualifies && !testCall ? callerPhone : null;
    if (phone) {
      const { error: leadError } = await deps.supabaseAdmin.from("leads").insert({
        organization_id: auth.organizationId,
        business_id: auth.businessId,
        name: outcome.customer_name ?? null,
        phone,
        source: "phone", // leads.source default; other call leads use it too
        asked_about: outcome.interest ?? outcome.outcome ?? null,
        notes: outcome.summary ?? null,
      });
      if (leadError)
        await audit(deps, auth, "lead", "error", interactionId, {
          error: leadError.message.slice(0, 300),
        });
    }
    return json({ ok: true, duplicate: false });
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
export function sarvamToolConfiguration(baseUrl: string): {
  tools: SarvamToolSpec[];
  inputVariables: { name: string; defaultValue: string }[];
  outputVariables: { name: string; type: string; extractionPrompt: string }[];
  promptGuard: string;
  allowlistIps: string[];
} {
  const auth = "Bearer token: the Sarvam secret holding this customer's ClickAI integration token";
  const base = `${baseUrl.replace(/\/+$/, "")}/api/public/sarvam/agent`;
  const contextVars = [
    "context_status",
    "missing",
    "guidance",
    "business_name",
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
          service_name: "the service the caller wants (optional)",
        },
        purpose:
          "Real free appointment slots for that date. Never offer a time this did not return.",
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
          service_name: "the service",
          customer_name: "the caller's name",
          customer_phone: "@User Identifier",
        },
        purpose: 'Books the slot. Say it is booked only when result.bookingOutcome is "confirmed".',
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
        },
        purpose:
          "Records the call's outcome once per call and saves a lead for callback requests and named enquiries.",
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
    ],
    promptGuard: `Business facts come only from the ClickAI variables (business_name, opening_hours, hours_today, services_and_prices, staff, faqs, policies; insert them with @) or the get_business_info tool. If context_status is not "ok", or a value is empty, never guess: say the team will confirm and offer a callback. Only offer times check_availability returned, and say an appointment is booked only when book_appointment returns bookingOutcome "confirmed".`,
    allowlistIps: ["4.213.167.70", "35.154.84.150"],
  };
}
