/**
 * LiveKit agent worker (long-running Node process; deployed separately from
 * the klyro Cloudflare Worker — see deploy/).
 *
 *   node --experimental-strip-types src/worker.ts start   # production mode: drains on SIGTERM
 *   node --experimental-strip-types src/worker.ts dev     # development
 *
 * Backpressure: loadFunc reports active jobs / MAX_CONCURRENT_SESSIONS; at
 * 1.0 LiveKit marks this worker FULL and dispatches new calls elsewhere.
 * Health: LiveKit's built-in HTTP server on HEALTH_PORT ("/" = connected to
 * LiveKit and inference process running; "/worker" = active jobs).
 * Graceful shutdown: SIGTERM -> drain (no new calls, wait up to
 * DRAIN_TIMEOUT_MS for active calls) -> exit.
 */
import { fileURLToPath } from "node:url";
import {
  cli,
  defineAgent,
  llm,
  ServerOptions,
  voice,
  type JobContext,
  type JobProcess,
} from "@livekit/agents";
import * as anthropic from "@livekit/agents-plugin-anthropic";
import * as openai from "@livekit/agents-plugin-openai";
import * as sarvam from "@livekit/agents-plugin-sarvam";
import * as silero from "@livekit/agents-plugin-silero";
import { SipClient } from "livekit-server-sdk";
import { attachCallGuards, decideCall, reportEnd, type SipCallInfo } from "./agent/call.ts";
import { ReceptionistAgent } from "./agent/receptionist.ts";
import { KlyroClient } from "./backend/klyro-client.ts";
import { loadConfig, type Config } from "./runtime/config.ts";
import { CallTelemetry, maskPhone } from "./runtime/telemetry.ts";

/**
 * End-of-turn detection. "multilingual" (default): LiveKit's text EOU model
 * (needs its model files baked into the image: `npx livekit-agents
 * download-files`); languages it does not support fall back to VAD silence.
 * "vad": VAD silence + endpointing delays only (no model files) — a
 * degraded mode, also used to run the worker where the model can't be fetched.
 * The plugin is imported only when used: importing it registers its
 * inference process, which then requires the model files.
 */
const TURN_DETECTION = process.env["TURN_DETECTION"] === "vad" ? "vad" : "multilingual";
const livekit =
  TURN_DETECTION === "multilingual" ? await import("@livekit/agents-plugin-livekit") : null;

const SIP = {
  callId: "sip.callID",
  caller: "sip.phoneNumber",
  called: "sip.trunkPhoneNumber",
} as const;

/** Sarvam bulbul:v3 speakers (from @livekit/agents-plugin-sarvam 1.9.5 models.d.ts). */
const V3_SPEAKERS = new Set([
  "shubh",
  "aditya",
  "ritu",
  "priya",
  "neha",
  "rahul",
  "pooja",
  "rohan",
  "simran",
  "kavya",
  "amit",
  "dev",
  "ishita",
  "shreya",
  "ratan",
  "varun",
  "manan",
  "sumit",
  "roopa",
  "kabir",
  "aayan",
  "ashutosh",
  "advait",
  "amelia",
  "sophia",
  "anand",
  "tanya",
  "tarun",
  "sunny",
  "mani",
  "gokul",
  "vijay",
  "shruti",
  "suhani",
  "mohit",
  "kavitha",
  "rehan",
  "soham",
  "rupali",
]);

export function buildLlm(c: Config): llm.LLM {
  const llms: llm.LLM[] = [];
  if (c.ANTHROPIC_API_KEY) {
    llms.push(
      new anthropic.LLM({
        model: c.CLAUDE_MODEL,
        apiKey: c.ANTHROPIC_API_KEY,
        temperature: 0.2,
        maxTokens: 300,
      }),
    );
  }
  if (c.FALLBACK_LLM_BASE_URL) {
    llms.push(
      new openai.LLM({
        baseURL: c.FALLBACK_LLM_BASE_URL,
        ...(c.FALLBACK_LLM_API_KEY ? { apiKey: c.FALLBACK_LLM_API_KEY } : {}),
        model: c.FALLBACK_LLM_MODEL ?? "gpt-4o-mini",
        temperature: 0.2,
      }),
    );
  }
  // One provider: use it directly. Two: LiveKit's FallbackAdapter moves to the
  // next on timeout/error and back when the first recovers.
  return llms.length === 1 ? llms[0]! : new llm.FallbackAdapter({ llms, attemptTimeout: 6 });
}

function callInfo(ctx: JobContext, attrs: Record<string, string>): SipCallInfo | null {
  const meta = (() => {
    try {
      return JSON.parse(ctx.job.metadata || "{}") as {
        outboundCallLogId?: string;
        toNumber?: string;
        fromNumber?: string;
      };
    } catch {
      return {};
    }
  })();
  const sipCallId = attrs[SIP.callId];
  if (!sipCallId) return null;
  if (meta.outboundCallLogId) {
    return {
      roomName: ctx.room.name ?? "",
      sipCallId,
      calledNumber: meta.toNumber ?? attrs[SIP.caller] ?? "",
      callerNumber: meta.toNumber ?? null,
      direction: "outbound",
      outboundCallLogId: meta.outboundCallLogId,
    };
  }
  return {
    roomName: ctx.room.name ?? "",
    sipCallId,
    calledNumber: attrs[SIP.called] ?? "",
    callerNumber: attrs[SIP.caller] ?? null,
    direction: "inbound",
  };
}

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData["vad"] = await silero.VAD.load();
  },
  entry: async (ctx: JobContext) => {
    const c = loadConfig();
    const joinedAt = Date.now();
    await ctx.connect();

    // Outbound: klyro authorised the dial (prepareOutboundSipCall) and the
    // dispatch metadata carries its call row; dial through the outbound trunk.
    let meta: { outboundCallLogId?: string; toNumber?: string; outboundTrunkId?: string } = {};
    try {
      meta = JSON.parse(ctx.job.metadata || "{}");
    } catch {
      meta = {}; // malformed dispatch metadata: treat as an inbound call
    }
    if (meta.outboundCallLogId && meta.toNumber && meta.outboundTrunkId) {
      const sip = new SipClient(
        c.LIVEKIT_URL.replace(/^wss?:/, "https:"),
        c.LIVEKIT_API_KEY,
        c.LIVEKIT_API_SECRET,
      );
      await sip.createSipParticipant(meta.outboundTrunkId, meta.toNumber, ctx.room.name ?? "", {
        participantIdentity: "callee",
        waitUntilAnswered: true,
        participantAttributes: { "clickai.callLogId": meta.outboundCallLogId },
      } as never);
    }

    const participant = await ctx.waitForParticipant();
    const attrs = (participant.attributes ?? {}) as Record<string, string>;
    const info = callInfo(ctx, attrs);
    const telemetry = new CallTelemetry({
      callId: null,
      sipCallId: info?.sipCallId ?? null,
      room: ctx.room.name ?? "",
    });
    if (!info) {
      telemetry.emit("call.rejected", { reason: "not_a_sip_participant" });
      ctx.shutdown("not_a_sip_participant");
      return;
    }
    telemetry.emit("call.joined", {
      direction: info.direction,
      caller: maskPhone(info.callerNumber),
    });

    const client = new KlyroClient({
      baseUrl: c.KLYRO_BASE_URL,
      secret: c.VOICE_AGENT_HMAC_SECRET,
      keyId: c.VOICE_AGENT_HMAC_KEY_ID,
      timeoutMs: c.KLYRO_TIMEOUT_MS,
    });
    const decision = await decideCall(client, info, telemetry);

    const tts = new sarvam.TTS({
      model: "bulbul:v3",
      speaker: "priya",
      targetLanguageCode: "en-IN",
    });
    if (decision.kind === "reject") {
      // Fixed message, no LLM, then hang up (deleting the room ends the SIP leg).
      const s = new voice.AgentSession({ tts });
      await s.start({ agent: new voice.Agent({ instructions: "" }), room: ctx.room });
      await s.say(decision.message, { allowInterruptions: false }).waitForPlayout();
      await s.close();
      await ctx.deleteRoom();
      return;
    }

    if (V3_SPEAKERS.has(decision.voiceId))
      tts.updateOptions({ speaker: decision.voiceId } as never);
    const agent = new ReceptionistAgent({
      business: decision.business,
      backend: decision.backend,
      state: decision.state,
      businessInstructions: decision.instructions,
      onTurn: ({ step, language }) => telemetry.emit("turn.state", { step: step.kind, language }),
      onGuard: (removed) =>
        telemetry.emit("guard.removed", {
          count: removed.length,
          rules: removed.map((r) => r.rule).join(","),
        }),
      onTool: ({ name, ok, ms, detail }) =>
        telemetry.emit("tool", { tool: name, ok, ms: Math.round(ms), detail: detail ?? null }),
    });
    const session = new voice.AgentSession({
      vad: ctx.proc.userData["vad"] as silero.VAD,
      // saaras:v3, automatic language detection, code-mixed transcripts.
      stt: new sarvam.STT({ model: "saaras:v3", languageCode: "unknown", mode: "codemix" }),
      llm: buildLlm(c),
      tts,
      ...(livekit
        ? { turnDetection: new livekit.turnDetector.MultilingualModel() }
        : { turnDetection: "vad" as const }),
      voiceOptions: {
        minEndpointingDelay: 600,
        maxEndpointingDelay: 3000,
        allowInterruptions: true,
        minInterruptionDuration: 500,
        preemptiveGeneration: false,
      },
      userAwayTimeout: c.SILENCE_TIMEOUT_S,
    });
    const guards = attachCallGuards({
      session,
      agent,
      telemetry,
      events: voice.AgentSessionEventTypes,
      maxCallSeconds: c.MAX_CALL_SECONDS,
      io: {
        say: async (t) => void (await session.say(t).waitForPlayout()),
        hangup: async () => {
          await session.close().catch(() => undefined);
          await ctx.deleteRoom().catch(() => undefined);
        },
      },
    });
    ctx.addShutdownCallback(async () => {
      await reportEnd(client, decision.callId, "shutdown", decision.state, telemetry);
    });

    await session.start({ agent, room: ctx.room });
    telemetry.emit("call.connected", { ms: Date.now() - joinedAt });
    session.say(decision.greeting, { allowInterruptions: true });
    const { reason } = await guards.finished;
    await reportEnd(client, decision.callId, reason, decision.state, telemetry);
  },
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const c = loadConfig();
  cli.runApp(
    new ServerOptions({
      agent: fileURLToPath(import.meta.url),
      agentName: c.AGENT_NAME,
      wsURL: c.LIVEKIT_URL,
      apiKey: c.LIVEKIT_API_KEY,
      apiSecret: c.LIVEKIT_API_SECRET,
      port: c.HEALTH_PORT,
      host: "0.0.0.0",
      drainTimeout: c.DRAIN_TIMEOUT_MS,
      numIdleProcesses: Math.min(c.MAX_CONCURRENT_SESSIONS, 4),
      loadFunc: async (server) =>
        (server as unknown as { activeJobs: unknown[] }).activeJobs.length /
        c.MAX_CONCURRENT_SESSIONS,
      loadThreshold: 1,
    }),
  );
}
