/* eslint-disable @typescript-eslint/no-explicit-any -- raw provider payloads are untyped JSON here */
/**
 * Phase 2.19: controlled smoke test of the Sarvam LLM adapter against the
 * REAL Sarvam API. PAID. Text only: no LiveKit server, no telephony, no
 * klyro, no database: the receptionist runs in LiveKit's text-mode
 * AgentSession against the in-memory test backend, with synthetic callers.
 *
 * Refuses to run unless every gate holds (bench/smoke-gates.ts, tested offline):
 *   SARVAM_SMOKE_APPROVED=yes          explicit approval for this run
 *   SARVAM_SMOKE_AUTH_MODE             unset/"api-key" or "proxy-injected" (explicit only)
 *   SARVAM_API_KEY                     api-key mode: a dedicated staging key (never printed);
 *                                      proxy-injected mode: must be UNSET (no placeholder key)
 *   SARVAM_SMOKE_BUDGET_INR            approved cap in INR (1..50, the Phase 2.19 approval), checked before every request
 *   OPENAI_LOG unset                   the SDK's debug log would print the api-subscription-key header
 *
 * api-key mode (the key is in this process):
 *   SARVAM_SMOKE_APPROVED=yes SARVAM_SMOKE_BUDGET_INR=50 SARVAM_API_KEY=... \
 *   node --experimental-strip-types bench/sarvam-smoke.ts --out <file.json>
 *
 * proxy-injected mode (an egress proxy adds api-subscription-key for
 * api.sarvam.ai; this process sends no credential header at all):
 *   SARVAM_SMOKE_APPROVED=yes SARVAM_SMOKE_BUDGET_INR=50 \
 *   SARVAM_SMOKE_AUTH_MODE=proxy-injected NODE_USE_ENV_PROXY=1 \
 *   node --experimental-strip-types bench/sarvam-smoke.ts --out <file.json>
 * (HTTPS_PROXY must be set and NO_PROXY must not cover api.sarvam.ai.)
 * If the proxy does not inject the key, the first request gets 401/403 and
 * the run stops there.
 *
 * Hard limits: model sarvam-105b-conversations only; 5 conversations; 60
 * chat requests in total; the budget is charged from Sarvam's reported usage
 * at ₹15 / 1M input and ₹60 / 1M output tokens (+18 % GST), or, when a
 * response reports no usage, from a worst case (bytes sent ÷ 2 input, 4,000
 * output). When the next request could exceed the cap, the request is not
 * sent and the run stops.
 *
 * Captured per request: HTTP status, time to headers, time to first content
 * or tool-call delta, full duration, usage, finish reasons, raw tool calls
 * (id, name, arguments, exactly as Sarvam sent them), whether each tool
 * result was continued with a matching tool_call_id, errors and retries.
 * Never captured: request headers, the key. Transcripts are synthetic.
 *
 * Scenario 5 injects failures locally (a 503 and a cut stream) before the
 * request reaches Sarvam, then lets LiveKit's retry make the real request.
 */
import { writeFileSync } from "node:fs";
import { initializeLogger, voice } from "@livekit/agents";
import { createSarvamLlm } from "../src/agent/sarvam-llm.ts";
import { ReceptionistAgent, type GuardReport } from "../src/agent/receptionist.ts";
import { InMemoryBookingBackend } from "../src/backend/in-memory.ts";
import { newConversation } from "../src/conversation/state.ts";
import { resolveSmokeGates } from "./smoke-gates.ts";
import {
  SMOKE_HOURS,
  SMOKE_NOW_ISO,
  SMOKE_SERVICES,
  SUITES,
  evaluateScenario,
  selectSuite,
  stepLabel,
  type SmokeScenario,
} from "./smoke-scenarios.ts";

initializeLogger({ pretty: false, level: "error" });

/* ------------------------------------------------------------------ gates */

function fail(m: string): never {
  console.error(`refusing to run: ${m}`);
  process.exit(2);
}
const gates = resolveSmokeGates(process.env, process.argv);
if (!gates.ok) fail(gates.reason);
const { auth: AUTH, budgetInr: BUDGET, out: OUT } = gates;
const suite = selectSuite(process.argv);
if (!suite.ok) fail(suite.reason);
const SUITE = suite.name;

const MODEL = "sarvam-105b-conversations";
const MAX_REQUESTS = 60;
const PRICE_IN = 15 / 1e6;
const PRICE_OUT = 60 / 1e6;
const GST = 1.18;
const WORST_OUT_TOKENS = 4000;

/* ------------------------------------------------------------------ recorder */

type ToolCallRaw = { index?: number; id?: string; name?: string; args: string };
type ReqRecord = {
  scenario: string;
  seq: number;
  method: string;
  path: string;
  injected?: string;
  status?: number;
  requestId?: string | null;
  msToHeaders?: number;
  msToFirstDelta?: number | null;
  msTotal?: number;
  bytesSent: number;
  lastRole?: string;
  toolResultFor?: string | null;
  toolResultMatched?: boolean | null;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
  finishReasons: string[];
  toolCalls: ToolCallRaw[];
  sawReasoningContent: boolean;
  sawThinkTag: boolean;
  rawShapeNotes: string[];
  errorBody?: string;
  costInr?: number;
};

const records: ReqRecord[] = [];
const issuedToolIds = new Set<string>();
let spentInr = 0;
let chatRequests = 0;
let stopped: string | null = null;
let scenario = "";
let inject: Array<"503" | "cut"> = [];
let consecutiveTransportFailures = 0;
const MAX_TRANSPORT_FAILURES = 3;

const realFetch = globalThis.fetch;

const recordingFetch = (async (input: any, init: any) => {
  const url = new URL(typeof input === "string" ? input : (input.url ?? String(input)));
  const method = (init?.method ?? "GET").toUpperCase();
  const body = typeof init?.body === "string" ? init.body : "";
  const rec: ReqRecord = {
    scenario,
    seq: records.length + 1,
    method,
    path: url.pathname,
    bytesSent: body.length,
    finishReasons: [],
    toolCalls: [],
    sawReasoningContent: false,
    sawThinkTag: false,
    rawShapeNotes: [],
  };
  records.push(rec);
  if (url.hostname !== "api.sarvam.ai") {
    rec.errorBody = "blocked: not api.sarvam.ai";
    throw new Error("smoke: refusing a request to a host other than api.sarvam.ai");
  }
  const isChat = method === "POST" && url.pathname.endsWith("/chat/completions");
  if (isChat) {
    let parsed: any = {};
    try {
      parsed = JSON.parse(body);
    } catch {
      /* recorded as is */
    }
    const msgs: any[] = parsed.messages ?? [];
    const lastNonSystem = [...msgs].reverse().find((m) => m.role !== "system");
    rec.lastRole = lastNonSystem?.role;
    if (lastNonSystem?.role === "tool") {
      rec.toolResultFor = lastNonSystem.tool_call_id ?? null;
      rec.toolResultMatched = !!rec.toolResultFor && issuedToolIds.has(rec.toolResultFor);
    }
    if (parsed.model !== MODEL) rec.rawShapeNotes.push(`unexpected model ${parsed.model}`);
    const nextInject = inject.shift();
    if (nextInject === "503") {
      rec.injected = "503 (local, not sent)";
      rec.status = 503;
      return new Response(JSON.stringify({ error: { message: "injected overload" } }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    }
    if (nextInject === "cut") {
      rec.injected = "stream cut before any data (local, not sent)";
      rec.status = 200;
      return new Response(new ReadableStream({ start: (c) => c.close() }), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    // Budget: refuse before sending if a worst-case request could cross the cap.
    const worst = (body.length / 2) * PRICE_IN * GST + WORST_OUT_TOKENS * PRICE_OUT * GST;
    if (stopped) {
      rec.errorBody = `not sent: ${stopped}`;
      throw new Error(`smoke: ${stopped}`);
    }
    if (chatRequests >= MAX_REQUESTS || spentInr + worst > BUDGET) {
      stopped ??= chatRequests >= MAX_REQUESTS ? "request limit reached" : "spending cap reached";
      rec.errorBody = `not sent: ${stopped}`;
      throw new Error(`smoke: ${stopped}`);
    }
    chatRequests++;
  }
  const t0 = performance.now();
  let res: Response;
  try {
    res = await realFetch(input, init);
  } catch (e) {
    // No HTTP response (network policy, DNS, TLS): stop after a few instead of
    // burning through the request limit with retries.
    rec.errorBody = `transport: ${(e as Error).message}`.slice(0, 200);
    if (isChat && ++consecutiveTransportFailures >= MAX_TRANSPORT_FAILURES)
      stopped ??= "api.sarvam.ai unreachable (3 consecutive transport failures)";
    throw e;
  }
  if (isChat) consecutiveTransportFailures = 0;
  if (isChat && (res.status === 401 || res.status === 403))
    stopped ??= `authentication rejected (HTTP ${res.status})`;
  rec.msToHeaders = Math.round(performance.now() - t0);
  rec.status = res.status;
  rec.requestId = res.headers.get("x-request-id") ?? res.headers.get("request-id");
  const type = res.headers.get("content-type") ?? "";
  if (!res.ok || !res.body) {
    const text = await res.text();
    rec.errorBody = text.slice(0, 500);
    rec.msTotal = Math.round(performance.now() - t0);
    if (isChat) charge(rec, body.length, null);
    return new Response(text, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  }
  if (!type.includes("text/event-stream")) {
    if (!isChat) {
      const text = await res.text();
      rec.msTotal = Math.round(performance.now() - t0);
      rec.errorBody = res.ok ? undefined : text.slice(0, 300);
      return new Response(text, { status: res.status, headers: res.headers });
    }
    rec.rawShapeNotes.push(`non-SSE content-type ${type}`);
  }
  // Tee: one copy to the adapter, one parsed here for the record (raw, before normalisation).
  const [a, b] = res.body.tee();
  void (async () => {
    const dec = new TextDecoder();
    let buf = "";
    let usage: any = null;
    const byIndex = new Map<number, ToolCallRaw>();
    const reader = b.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, "");
        buf = buf.slice(i + 1);
        if (!line.startsWith("data:")) continue;
        const p = line.slice(5).trim();
        if (p === "[DONE]") continue;
        let c: any;
        try {
          c = JSON.parse(p);
        } catch {
          rec.rawShapeNotes.push("malformed JSON chunk");
          continue;
        }
        if (c.error)
          rec.rawShapeNotes.push(`in-stream error: ${JSON.stringify(c.error).slice(0, 200)}`);
        if (c.usage) usage = c.usage;
        if (!Array.isArray(c.choices)) {
          if (!c.usage) rec.rawShapeNotes.push("chunk without choices");
          continue;
        }
        for (const ch of c.choices) {
          if (ch.finish_reason) rec.finishReasons.push(ch.finish_reason);
          const d = ch.delta ?? {};
          if (d.reasoning_content) rec.sawReasoningContent = true;
          if (typeof d.content === "string" && d.content.includes("<think>"))
            rec.sawThinkTag = true;
          if ((d.content || d.tool_calls) && rec.msToFirstDelta === undefined)
            rec.msToFirstDelta = Math.round(performance.now() - t0);
          if (Array.isArray(d.tool_calls)) {
            if (d.tool_calls.length > 1)
              rec.rawShapeNotes.push(`${d.tool_calls.length} tool calls in one delta`);
            for (const t of d.tool_calls) {
              const idx = typeof t.index === "number" ? t.index : -1;
              if (typeof t.index !== "number") rec.rawShapeNotes.push("tool call without index");
              let cur = byIndex.get(idx);
              if (!cur || (t.id && cur.id && t.id !== cur.id)) {
                cur = { index: t.index, id: t.id, name: t.function?.name, args: "" };
                byIndex.set(idx === -1 ? byIndex.size + 1000 : idx, cur);
                if (!t.id) rec.rawShapeNotes.push("tool call without id");
              } else if (t.function?.name && cur.name)
                rec.rawShapeNotes.push("name repeated on continuation");
              const a2 = t.function?.arguments;
              if (a2 !== undefined && typeof a2 !== "string")
                rec.rawShapeNotes.push("object-valued arguments");
              cur.args += typeof a2 === "string" ? a2 : a2 === undefined ? "" : JSON.stringify(a2);
            }
          }
        }
      }
    }
    rec.msTotal = Math.round(performance.now() - t0);
    rec.msToFirstDelta ??= null;
    rec.toolCalls = [...byIndex.values()];
    rec.usage = usage;
    if (!usage) rec.rawShapeNotes.push("no usage reported");
    charge(rec, body.length, usage);
  })().catch((e) => rec.rawShapeNotes.push(`recorder: ${(e as Error).message}`));
  return new Response(a, { status: res.status, statusText: res.statusText, headers: res.headers });
}) as typeof fetch;

function charge(rec: ReqRecord, bytes: number, usage: any) {
  const pin = usage?.prompt_tokens ?? bytes / 2;
  const pout = usage?.completion_tokens ?? (usage ? 0 : WORST_OUT_TOKENS);
  rec.costInr = (pin * PRICE_IN + pout * PRICE_OUT) * GST;
  spentInr += rec.costInr;
}

/* ------------------------------------------------------------------ scenarios */

// Scenarios, the business clock and the calendar live in smoke-scenarios.ts
// (tested offline); the original suite is unchanged.
const SCENARIOS: SmokeScenario[] = [...SUITES[SUITE]];
const businessFor = (sc: SmokeScenario) => ({
  businessName: "Test Dental (smoke)",
  timeZone: "Asia/Kolkata",
  services: SMOKE_SERVICES,
  now: () => new Date(sc.nowIso ?? SMOKE_NOW_ISO),
});

async function runScenario(sc: SmokeScenario) {
  scenario = sc.name;
  inject = [...(sc.inject ?? [])];
  const backend = new InMemoryBookingBackend({
    timeZoneOffset: "+05:30",
    openHours: sc.openHours ?? SMOKE_HOURS,
    callId: `smoke-${sc.name}`,
  });
  const state = newConversation({
    callId: `smoke-${sc.name}`,
    callerId: "+910000000000",
    primaryLanguage: "en-IN",
  });
  const tools: Array<{ name: string; ok: boolean }> = []; // backend-calling tools (onTool)
  const executed: Array<{ callId: string; name: string; args: string }> = []; // every executed call
  const guards: string[] = [];
  // Every intervention in full: rule, exact removed text, reason, original and spoken reply, languages.
  const guardReports: Array<GuardReport & { turn: number }> = [];
  const steps: string[] = []; // the state's step for each caller turn
  const agent = new ReceptionistAgent({
    business: businessFor(sc),
    backend,
    state,
    onTurn: ({ step }) => steps.push(stepLabel(step as { kind: string })),
    onGuard: (r, report) => {
      guards.push(...r.map((x) => x.rule));
      guardReports.push({ ...report, turn: steps.length - 1 });
    },
    onTool: (t) => tools.push({ name: t.name, ok: t.ok }),
  });
  // The adapter's auth guard checks every request's headers before recordingFetch sees it.
  const model = createSarvamLlm(
    AUTH.mode === "proxy-injected"
      ? { auth: "proxy-injected", model: MODEL, fetch: recordingFetch }
      : { auth: "api-key", apiKey: AUTH.apiKey, model: MODEL, fetch: recordingFetch },
  );
  const llmErrors: Array<{ name: string; status?: number; recoverable: boolean; message: string }> =
    [];
  model.on("error", (e: any) =>
    llmErrors.push({
      name: e.error?.name ?? "error",
      status: e.error?.statusCode,
      recoverable: !!e.recoverable,
      message: String(e.error?.message ?? "").slice(0, 200),
    }),
  );
  const metrics: any[] = [];
  model.on("metrics_collected", (m: any) => {
    if (m.type === "llm_metrics")
      metrics.push({
        ttftMs: m.ttftMs,
        durationMs: m.durationMs,
        promptTokens: m.promptTokens,
        completionTokens: m.completionTokens,
      });
  });
  // Remember every tool-call id LiveKit actually received (after normalisation) for the continuation check.
  const session = new voice.AgentSession({ llm: model });
  session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (ev) => {
    const it: any = ev.item;
    if (it.type === "message" && it.role === "assistant") agent.recordSpoken(it.interrupted);
  });
  session.on(voice.AgentSessionEventTypes.FunctionToolsExecuted, (ev: any) => {
    for (const c of ev.functionCalls ?? []) {
      issuedToolIds.add(c.callId);
      executed.push({ callId: c.callId, name: c.name, args: c.args });
    }
  });
  await session.start({ agent });
  const transcript: Array<{ caller: string; agent: string }> = [];
  for (const t of sc.turns) {
    if (stopped) break;
    const r = await session.run({ userInput: t }).wait();
    transcript.push({
      caller: t,
      agent: r.events
        .filter((e) => e.type === "message")
        .map((e) => (e as { item: { textContent?: string } }).item.textContent ?? "")
        .join(" "),
    });
  }
  await session.close();
  const offered = state.booking.offered.map((o) => o.hhmm);
  const toolNames = executed.map((t) => t.name);
  const checks = evaluateScenario(sc, {
    steps,
    transcript,
    date: state.date?.value ?? null,
    offered,
    bookingStatus: state.booking.status,
    bookings: backend.bookings.size,
    backendBookCalls: backend.calls.book,
    closed: state.closing.closed,
  });
  return {
    scenario: sc.name,
    covers: sc.covers ?? [],
    checksPassed: checks.filter((c) => c.pass).length,
    checksFailed: checks.filter((c) => !c.pass),
    checks,
    steps,
    transcript,
    executedToolCalls: executed,
    backendToolResults: tools,
    duplicateCallIds: executed.length - new Set(executed.map((t) => t.callId)).size,
    toolsAsExpected: sc.expectTools.every((t) => toolNames.includes(t)),
    unexpectedBookCalls: sc.expectBooked
      ? 0
      : toolNames.filter((t) => t === "book_appointment").length,
    bookingsInBackend: backend.bookings.size,
    backendBookCalls: backend.calls.book,
    bookingStatus: state.booking.status,
    bookedAsExpected:
      (backend.bookings.size === 1) === sc.expectBooked && backend.bookings.size <= 1,
    offeredSlots: offered,
    backendOpenHours: sc.openHours ?? SMOKE_HOURS,
    businessNow: sc.nowIso ?? SMOKE_NOW_ISO,
    finalDate: state.date?.value ?? null,
    guardInterventions: guards,
    guardReports,
    llmErrors,
    metrics,
    language: state.language.current,
  };
}

const conversations = [];
for (const sc of SCENARIOS) {
  if (stopped) break;
  try {
    conversations.push(await runScenario(sc));
  } catch (e) {
    conversations.push({ scenario: sc.name, fatal: (e as Error).message });
  }
}
await new Promise((r) => setTimeout(r, 200)); // let recorders finish

const chat = records.filter((r) => r.method === "POST" && !r.injected && r.status !== undefined);
const ttft = chat
  .map((r) => r.msToFirstDelta)
  .filter((x): x is number => typeof x === "number")
  .sort((a, b) => a - b);
const full = chat
  .map((r) => r.msTotal)
  .filter((x): x is number => typeof x === "number")
  .sort((a, b) => a - b);
const q = (xs: number[], p: number) =>
  xs.length ? xs[Math.min(xs.length - 1, Math.floor(p * xs.length))] : null;
const allChecks = conversations.flatMap((c: any) => c.checks ?? []);
const summary = {
  suite: SUITE,
  model: MODEL,
  scenariosRun: conversations.length,
  scenariosPlanned: SCENARIOS.length,
  checksPassed: allChecks.filter((c: any) => c.pass).length,
  checksFailed: allChecks.filter((c: any) => !c.pass).length,
  fatalScenarios: conversations.filter((c: any) => c.fatal).map((c: any) => c.scenario),
  authMode: AUTH.mode,
  budgetInr: BUDGET,
  spentInrEstimatedFromUsage: Number(spentInr.toFixed(4)),
  stopped,
  chatRequestsSent: chatRequests,
  statuses: chat.reduce<Record<string, number>>(
    (a, r) => ((a[String(r.status)] = (a[String(r.status)] ?? 0) + 1), a),
    {},
  ),
  otherRequests: records
    .filter((r) => r.method !== "POST")
    .map((r) => ({ method: r.method, path: r.path, status: r.status })),
  ttftMs: { p50: q(ttft, 0.5), p95: q(ttft, 0.95), max: ttft.at(-1) ?? null },
  fullMs: { p50: q(full, 0.5), p95: q(full, 0.95), max: full.at(-1) ?? null },
  tokens: {
    prompt: chat.reduce((a, r) => a + (r.usage?.prompt_tokens ?? 0), 0),
    completion: chat.reduce((a, r) => a + (r.usage?.completion_tokens ?? 0), 0),
  },
  toolResultsContinued: chat
    .filter((r) => r.lastRole === "tool")
    .map((r) => ({ id: r.toolResultFor, matched: r.toolResultMatched })),
  rawShapeNotes: [...new Set(records.flatMap((r) => r.rawShapeNotes))],
};
writeFileSync(OUT, JSON.stringify({ summary, conversations, requests: records }, null, 2));
console.log(JSON.stringify(summary, null, 2));
