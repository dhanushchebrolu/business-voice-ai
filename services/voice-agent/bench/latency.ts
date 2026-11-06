/**
 * What can be measured without providers or a LiveKit server:
 *  1. deterministic understanding + state update per caller turn;
 *  2. LiveKit AgentSession per-turn overhead (model time 0), with and without a tool call;
 *  3. agent -> klyro internal API round trip over real HTTP on localhost:
 *     HMAC signing (agent) + verification and replay check (klyro's own
 *     handler code) + tool dispatch (fake executor).
 * NOT measured (needs real calls): SIP/RTP, STT, LLM time-to-first-token,
 * TTS first audio, end-of-turn model, network to klyro. Those dominate.
 *
 *   node --experimental-strip-types bench/latency.ts
 */
import { createServer } from "node:http";
import { initializeLogger, voice } from "@livekit/agents";
import { handleTool, type HttpDeps } from "../../../src/lib/voice-agent/http.server.ts";
import { ReceptionistAgent } from "../src/agent/receptionist.ts";
import { InMemoryBookingBackend } from "../src/backend/in-memory.ts";
import { KlyroClient } from "../src/backend/klyro-client.ts";
import { applyReading, newConversation, nextStep } from "../src/conversation/state.ts";
import { readUtterance } from "../src/conversation/understanding.ts";

initializeLogger({ pretty: false, level: "error" });
const SERVICES = [
  {
    id: "svc-cleaning",
    name: "Cleaning",
    aliases: ["క్లీనింగ్", "क्लीनिंग"],
    durationMinutes: 30,
    priceInr: 800,
  },
];
const UTTERANCES = [
  "నాకు అపాయింట్మెంట్ బుక్ చేయాలి",
  "आज शाम चार बजे क्लीनिंग चाहिए",
  "no, 3 PM not 2",
  "రేపు evening 5 PM కి cleaning బుక్ చేయండి",
  "हाँ जी, इसी नंबर पर",
  "my name is Ravi",
];
const BUSINESS = {
  businessName: "Smile Dental",
  timeZone: "Asia/Kolkata",
  services: SERVICES,
  now: () => new Date("2026-11-02T04:30:00Z"),
};

function stats(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
  return `median ${q(0.5).toFixed(3)} ms | p95 ${q(0.95).toFixed(3)} ms | max ${s.at(-1)!.toFixed(3)} ms (n=${s.length})`;
}

// 1.
{
  const xs: number[] = [];
  for (let i = 0; i < 3200; i++) {
    const t0 = performance.now();
    const st = newConversation({
      callId: "b",
      callerId: "+919876543210",
      primaryLanguage: "en-IN",
    });
    applyReading(
      st,
      readUtterance(UTTERANCES[i % UTTERANCES.length]!, { catalog: SERVICES }),
      BUSINESS,
    );
    nextStep(st);
    if (i >= 200) xs.push(performance.now() - t0);
  }
  console.log(`understanding + state + next step         ${stats(xs)}`);
}

// 2.
{
  const agent = new ReceptionistAgent({
    business: BUSINESS,
    backend: new InMemoryBookingBackend({ timeZoneOffset: "+05:30", openHours: ["16:00"] }),
    state: newConversation({ callId: "bench", callerId: null, primaryLanguage: "en-IN" }),
  });
  const session = new voice.AgentSession({
    llm: new voice.testing.FakeLLM(
      UTTERANCES.map((u) => ({ input: u, content: "Okay. Which day would you like to come in?" })),
    ),
  });
  await session.start({ agent });
  const xs: number[] = [];
  for (let i = 0; i < 320; i++) {
    const t0 = performance.now();
    await session.run({ userInput: UTTERANCES[i % UTTERANCES.length]! }).wait();
    if (i >= 20) xs.push(performance.now() - t0);
  }
  console.log(`AgentSession turn (state+guard, model 0)   ${stats(xs)}`);
  await session.close();
}

// 3.
{
  const SECRET = "b".repeat(40);
  const deps: HttpDeps = {
    env: (n) => (n === "VOICE_AGENT_HMAC_SECRET" ? SECRET : undefined),
    // Allow-all here; the real limiter adds one Postgres round trip per call (not measured).
    limiter: {
      preAuth: () => ({ allowed: true, retryAfterSeconds: 0 }),
      shared: async () => ({ allowed: true, retryAfterSeconds: 0 }),
    },
    releaseClaim: async () => undefined,
    claimOnce: (() => {
      const seen = new Set<string>();
      return async (_p: string, id: string) => (seen.has(id) ? false : (seen.add(id), true));
    })(),
    session: {
      db: {
        from: () => {
          const q = {
            select: () => q,
            eq: () => q,
            maybeSingle: async () => ({
              data: {
                id: "c",
                provider: "livekit_sip",
                organization_id: "o",
                business_id: "b",
                phone_number_id: null,
                status: "answered",
              },
              error: null,
            }),
          };
          return q;
        },
      } as never,
      resolveNumber: async () => null,
      checkAccess: async () => ({ allowed: true, reason: null }),
      loadBusiness: async () => ({}) as never,
      availableTools: async () => ["check_calendar_availability"],
      executeTool: async () => ({ content: '{"success":true,"data":{"slots":[]}}' }),
      finalizeBilling: async () => undefined,
      now: () => new Date(),
    },
  };
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const r = await handleTool(
      new Request(`http://127.0.0.1${req.url}`, {
        method: "POST",
        headers: req.headers as Record<string, string>,
        body: Buffer.concat(chunks),
      }),
      deps,
    );
    res.writeHead(r.status, { "content-type": "application/json" }).end(await r.text());
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const client = new KlyroClient({
    baseUrl: `http://127.0.0.1:${port}`,
    secret: SECRET,
    retries: 0,
  });
  const xs: number[] = [];
  for (let i = 0; i < 520; i++) {
    const t0 = performance.now();
    await client.post(
      "/api/internal/voice-agent/tool",
      {
        callId: "11111111-1111-4111-8111-111111111111",
        tool: "check_calendar_availability",
        input: { dateIso: "2026-11-03", durationMinutes: 30 },
      },
      { idempotent: true },
    );
    if (i >= 20) xs.push(performance.now() - t0);
  }
  console.log(`signed klyro tool call, localhost HTTP    ${stats(xs)}`);
  server.close();
}
