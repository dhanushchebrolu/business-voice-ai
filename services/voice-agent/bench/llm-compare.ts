/**
 * Sarvam vs Claude, through the production wiring (worker.ts buildLlm), the
 * real ReceptionistAgent, tools and guards, in LiveKit's text-mode
 * AgentSession, against the in-memory booking backend. PAID: every turn is a
 * real provider request. It refuses to run without explicit approval.
 *
 *   LLM_BENCH_APPROVED=yes SARVAM_API_KEY=... ANTHROPIC_API_KEY=... \
 *   BENCH_RUNS=3 BENCH_PROVIDERS=sarvam,anthropic \
 *   SARVAM_PRICE_IN_PER_1M=... SARVAM_PRICE_OUT_PER_1M=... \
 *   ANTHROPIC_PRICE_IN_PER_1M=... ANTHROPIC_PRICE_OUT_PER_1M=... \
 *   BENCH_SECONDS_PER_TURN=8 \
 *   node --experimental-strip-types bench/llm-compare.ts > bench-result.json
 *
 * Prices are inputs, never hard-coded (take them from the providers' current
 * price pages on the day). Per-minute cost assumes BENCH_SECONDS_PER_TURN of
 * call time per caller turn; replace it with measured call data when known.
 *
 * Measures per provider: time to first token and full response time per
 * model request (LiveKit llm_metrics), tokens, provider errors, tool
 * correctness (expected tools in order; book only after confirmation), booking
 * success (one confirmed booking in the backend), guard interventions (claims
 * the guards had to remove), and a reply-script check (does the reply use the
 * caller's script: Telugu / Devanagari / Latin). The script check is a
 * proxy; language quality needs native-speaker review of the transcripts,
 * which are included in the output.
 *
 * Not measured: STT, TTS, telephony, real klyro latency. A few runs prove
 * little: production suitability needs the acceptance thresholds in
 * PRODUCTION_READINESS.md §16 over the full run count.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- provider payloads and LiveKit event objects are untyped JSON here */
import { initializeLogger, voice } from "@livekit/agents";
import { ReceptionistAgent } from "../src/agent/receptionist.ts";
import { InMemoryBookingBackend } from "../src/backend/in-memory.ts";
import { newConversation } from "../src/conversation/state.ts";
import type { Config } from "../src/runtime/config.ts";
import { buildLlm } from "../src/worker.ts";

initializeLogger({ pretty: false, level: "error" });

if (process.env.LLM_BENCH_APPROVED !== "yes") {
  console.error(
    "refusing to run: this benchmark makes paid LLM calls. Set LLM_BENCH_APPROVED=yes once the spend is approved.",
  );
  process.exit(2);
}

const PROVIDERS = (process.env.BENCH_PROVIDERS ?? "sarvam,anthropic")
  .split(",")
  .map((p) => p.trim())
  .filter((p): p is "sarvam" | "anthropic" => p === "sarvam" || p === "anthropic");
const RUNS = Math.min(Math.max(Number(process.env.BENCH_RUNS ?? 3) || 3, 1), 20);
const SECONDS_PER_TURN = Number(process.env.BENCH_SECONDS_PER_TURN ?? 8);
const price = (k: string) => {
  const v = process.env[k];
  return v === undefined || v === "" ? null : Number(v);
};

const SERVICES = [
  {
    id: "svc-cleaning",
    name: "Cleaning",
    aliases: ["క్లీనింగ్", "क्लीनिंग"],
    durationMinutes: 30,
    priceInr: 800,
  },
  {
    id: "svc-root-canal",
    name: "Root Canal",
    aliases: ["రూట్ కెనాల్", "रूट कैनाल"],
    durationMinutes: 60,
    priceInr: null,
  },
];
const NOW = new Date("2026-11-02T04:30:00Z");
const BUSINESS = {
  businessName: "Smile Dental",
  timeZone: "Asia/Kolkata",
  services: SERVICES,
  now: () => NOW,
};
const HOURS = ["10:00", "11:00", "12:00", "14:00", "15:00", "16:00", "17:00"];

type Script = "telugu" | "devanagari" | "latin";
type Scenario = {
  name: string;
  turns: Array<{ text: string; script: Script }>;
  expectTools: string[];
  expectBooked: boolean;
};
const SCENARIOS: Scenario[] = [
  {
    name: "telugu-booking",
    turns: [
      { text: "నమస్కారం", script: "telugu" },
      { text: "నాకు రేపు సాయంత్రం నాలుగు గంటలకు క్లీనింగ్ అపాయింట్మెంట్ కావాలి", script: "telugu" },
      { text: "అవును, ఆ టైం సరిపోతుంది", script: "telugu" },
      { text: "నా పేరు రవి", script: "telugu" },
      { text: "అవును, ఇదే నంబర్", script: "telugu" },
      { text: "అవును, బుక్ చేయండి", script: "telugu" },
    ],
    expectTools: ["check_availability", "book_appointment"],
    expectBooked: true,
  },
  {
    name: "hindi-booking",
    turns: [
      { text: "नमस्ते", script: "devanagari" },
      { text: "आज शाम चार बजे क्लीनिंग चाहिए", script: "devanagari" },
      { text: "जी हाँ", script: "devanagari" },
      { text: "मेरा नाम धनुष है", script: "devanagari" },
      { text: "हाँ जी, इसी नंबर पर", script: "devanagari" },
      { text: "हाँ, बुक कर दीजिए", script: "devanagari" },
    ],
    expectTools: ["check_availability", "book_appointment"],
    expectBooked: true,
  },
  {
    name: "english-booking",
    turns: [
      { text: "Hi", script: "latin" },
      { text: "I'd like a cleaning tomorrow at 11 am", script: "latin" },
      { text: "yes that works", script: "latin" },
      { text: "my name is Priya", script: "latin" },
      { text: "yes, this number", script: "latin" },
      { text: "yes please book it", script: "latin" },
    ],
    expectTools: ["check_availability", "book_appointment"],
    expectBooked: true,
  },
  {
    name: "code-mixed-booking",
    turns: [
      { text: "hello andi", script: "latin" },
      { text: "రేపు evening 5 PM కి cleaning బుక్ చేయండి", script: "telugu" },
      { text: "haan theek hai", script: "latin" },
      { text: "naa peru Suresh", script: "latin" },
      { text: "yes same number", script: "latin" },
      { text: "ok confirm చేయండి", script: "telugu" },
    ],
    expectTools: ["check_availability", "book_appointment"],
    expectBooked: true,
  },
  {
    name: "price-unknown-no-booking",
    turns: [
      { text: "root canal ki entha avutundi?", script: "latin" },
      { text: "ok thanks, I'll call later", script: "latin" },
    ],
    expectTools: ["get_service_price"],
    expectBooked: false,
  },
];

const scriptOf = (s: string): Script | null => {
  const te = (s.match(/[ఀ-౿]/g) ?? []).length;
  const hi = (s.match(/[ऀ-ॿ]/g) ?? []).length;
  const la = (s.match(/[A-Za-z]/g) ?? []).length;
  const max = Math.max(te, hi, la);
  if (max === 0) return null;
  return max === te ? "telugu" : max === hi ? "devanagari" : "latin";
};

function configFor(p: "sarvam" | "anthropic"): Config {
  if (p === "sarvam" && !process.env.SARVAM_API_KEY) throw new Error("SARVAM_API_KEY is not set");
  if (p === "anthropic" && !process.env.ANTHROPIC_API_KEY)
    throw new Error("ANTHROPIC_API_KEY is not set");
  return {
    LLM_PROVIDER: p,
    SARVAM_API_KEY: process.env.SARVAM_API_KEY ?? "",
    SARVAM_LLM_MODEL:
      (process.env.SARVAM_LLM_MODEL as Config["SARVAM_LLM_MODEL"]) ?? "sarvam-105b-conversations",
    SARVAM_LLM_BASE_URL: "https://api.sarvam.ai/v1",
    SARVAM_LLM_REASONING_EFFORT: process.env
      .SARVAM_LLM_REASONING_EFFORT as Config["SARVAM_LLM_REASONING_EFFORT"],
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    CLAUDE_MODEL: process.env.CLAUDE_MODEL ?? "claude-sonnet-4-6",
  } as Config;
}

async function runOnce(p: "sarvam" | "anthropic", sc: Scenario, run: number) {
  const backend = new InMemoryBookingBackend({
    timeZoneOffset: "+05:30",
    openHours: HOURS,
    callId: `bench-${run}`,
  });
  const state = newConversation({
    callId: `bench-${run}`,
    callerId: "+919876543210",
    primaryLanguage: "en-IN",
  });
  const tools: string[] = [];
  const guards: string[] = [];
  const agent = new ReceptionistAgent({
    business: BUSINESS,
    backend,
    state,
    onGuard: (r) => guards.push(...r.map((x) => x.rule)),
    onTool: (t) => tools.push(t.name),
  });
  const model = buildLlm(configFor(p));
  const reqs: Array<{
    ttftMs: number;
    durationMs: number;
    promptTokens: number;
    completionTokens: number;
  }> = [];
  model.on("metrics_collected", (m: any) => {
    if (m.type === "llm_metrics")
      reqs.push({
        ttftMs: m.ttftMs,
        durationMs: m.durationMs,
        promptTokens: m.promptTokens,
        completionTokens: m.completionTokens,
      });
  });
  const errors: string[] = [];
  model.on("error", (e: any) =>
    errors.push(`${e.error?.name ?? "error"}${e.recoverable ? " (retried)" : ""}`),
  );
  const session = new voice.AgentSession({ llm: model });
  session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (ev) => {
    if (ev.item.type === "message" && ev.item.role === "assistant")
      agent.recordSpoken(ev.item.interrupted);
  });
  await session.start({ agent });
  const transcript: Array<{ caller: string; agent: string; scriptOk: boolean | null }> = [];
  const t0 = performance.now();
  for (const turn of sc.turns) {
    const r = await session.run({ userInput: turn.text }).wait();
    const reply = r.events
      .filter((e) => e.type === "message")
      .map((e) => (e as { item: { textContent?: string } }).item.textContent ?? "")
      .join(" ");
    const got = scriptOf(reply);
    transcript.push({
      caller: turn.text,
      agent: reply,
      scriptOk: got === null ? null : got === turn.script,
    });
  }
  const wallMs = performance.now() - t0;
  await session.close();
  const booked = state.booking.status === "confirmed" && backend.bookings.size === 1;
  const toolsOk =
    JSON.stringify(tools.filter((t) => sc.expectTools.includes(t))) ===
    JSON.stringify(sc.expectTools);
  return {
    provider: p,
    scenario: sc.name,
    run,
    wallMs,
    requests: reqs,
    errors,
    tools,
    toolsOk,
    bookingOk: booked === sc.expectBooked && backend.bookings.size <= 1,
    booked,
    guards,
    transcript,
  };
}

const pct = (xs: number[], q: number) => {
  const s = xs.filter((x) => x >= 0).sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))]! : null;
};

type RunResult =
  | Awaited<ReturnType<typeof runOnce>>
  | { provider: string; scenario: string; run: number; fatal: string };
const results: RunResult[] = [];
for (const p of PROVIDERS)
  for (const sc of SCENARIOS)
    for (let i = 0; i < RUNS; i++) {
      try {
        results.push(await runOnce(p, sc, i));
      } catch (e) {
        results.push({ provider: p, scenario: sc.name, run: i, fatal: (e as Error).message });
      }
    }

const summary = PROVIDERS.map((p) => {
  const rs = results.filter((r) => r.provider === p && !("fatal" in r)) as Array<
    Awaited<ReturnType<typeof runOnce>>
  >;
  const reqs = rs.flatMap((r) => r.requests);
  const inTok = reqs.reduce((a, r) => a + r.promptTokens, 0);
  const outTok = reqs.reduce((a, r) => a + r.completionTokens, 0);
  const key = p === "sarvam" ? "SARVAM" : "ANTHROPIC";
  const pin = price(`${key}_PRICE_IN_PER_1M`);
  const pout = price(`${key}_PRICE_OUT_PER_1M`);
  const cost = pin === null || pout === null ? null : (inTok * pin + outTok * pout) / 1e6;
  const convs = rs.length;
  const bookings = rs.filter((r) => r.booked).length;
  const turns = rs.reduce((a, r) => a + r.transcript.length, 0);
  const scriptChecks = rs
    .flatMap((r) => r.transcript.map((t) => t.scriptOk))
    .filter((x) => x !== null);
  return {
    provider: p,
    conversations: convs,
    fatal: results.filter((r) => r.provider === p && "fatal" in r).length,
    ttftMs: {
      p50: pct(
        reqs.map((r) => r.ttftMs),
        0.5,
      ),
      p95: pct(
        reqs.map((r) => r.ttftMs),
        0.95,
      ),
    },
    fullMs: {
      p50: pct(
        reqs.map((r) => r.durationMs),
        0.5,
      ),
      p95: pct(
        reqs.map((r) => r.durationMs),
        0.95,
      ),
    },
    toolCorrectRate: convs ? rs.filter((r) => r.toolsOk).length / convs : null,
    bookingSuccessRate: convs ? rs.filter((r) => r.bookingOk).length / convs : null,
    guardInterventions: rs.reduce((a, r) => a + r.guards.length, 0),
    providerErrors: rs.reduce((a, r) => a + r.errors.length, 0),
    replyScriptMatchRate: scriptChecks.length
      ? scriptChecks.filter(Boolean).length / scriptChecks.length
      : null,
    tokens: {
      prompt: inTok,
      completion: outTok,
      perConversation: convs ? (inTok + outTok) / convs : null,
    },
    cost:
      cost === null
        ? "prices not provided"
        : {
            total: cost,
            perConversation: convs ? cost / convs : null,
            perBooking: bookings ? cost / bookings : null,
            perMinuteAssumed: turns ? cost / ((turns * SECONDS_PER_TURN) / 60) : null,
          },
  };
});

console.log(
  JSON.stringify(
    { runs: RUNS, secondsPerTurnAssumed: SECONDS_PER_TURN, summary, results },
    null,
    2,
  ),
);
