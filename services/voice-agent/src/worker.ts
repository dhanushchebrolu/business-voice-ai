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
  AgentServer,
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
import { RoomServiceClient, SipClient } from "livekit-server-sdk";
import { createSarvamLlm } from "./agent/sarvam-llm.ts";
import {
  UNAVAILABLE,
  attachCallGuards,
  decideCall,
  effectiveMaxCallSeconds,
  dialOutbound,
  parseOutboundDispatch,
  checkpointTranscript,
  reportEnd,
  transcriptFrom,
  type SipCallInfo,
} from "./agent/call.ts";
import { ReceptionistAgent } from "./agent/receptionist.ts";
import { claimOutbound } from "./backend/klyro-backend.ts";
import { KlyroClient } from "./backend/klyro-client.ts";
import { loadConfig, type Config } from "./runtime/config.ts";
import { TranscriptCheckpointer } from "./runtime/transcript-checkpoint.ts";
import { activeJobsOf, captureAgentServer, installShutdownWatchdog } from "./runtime/shutdown.ts";
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
  if (c.LLM_PROVIDER === "sarvam") {
    // Sarvam only: no Anthropic, no FallbackAdapter (Phase 2.18).
    return createSarvamLlm({
      apiKey: c.SARVAM_API_KEY,
      model: c.SARVAM_LLM_MODEL,
      baseURL: c.SARVAM_LLM_BASE_URL,
      ...(c.SARVAM_LLM_REASONING_EFFORT ? { reasoningEffort: c.SARVAM_LLM_REASONING_EFFORT } : {}),
    });
  }
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

function callInfo(
  ctx: JobContext,
  attrs: Record<string, string>,
  outbound: { callId: string; toNumber: string } | null,
): SipCallInfo | null {
  const sipCallId = attrs[SIP.callId];
  if (!sipCallId) return null;
  if (outbound) {
    // Destination from klyro's claim, not from dispatch metadata.
    return {
      roomName: ctx.room.name ?? "",
      sipCallId,
      calledNumber: outbound.toNumber,
      callerNumber: outbound.toNumber,
      direction: "outbound",
      outboundCallLogId: outbound.callId,
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

    const client = new KlyroClient({
      baseUrl: c.KLYRO_BASE_URL,
      secret: c.VOICE_AGENT_HMAC_SECRET,
      keyId: c.VOICE_AGENT_HMAC_KEY_ID,
      timeoutMs: c.KLYRO_TIMEOUT_MS,
    });

    // Outbound: an owner/admin created the call row (outbound.functions.ts);
    // the dispatch metadata names only that row. Claim it from klyro (one
    // job only), then dial the destination and caller ID klyro returns,
    // through this agent's own configured trunk.
    let outbound: { callId: string; toNumber: string } | null = null;
    const dispatch = parseOutboundDispatch(ctx.job.metadata);
    if (dispatch) {
      const sip = new SipClient(
        c.LIVEKIT_URL.replace(/^wss?:/, "https:"),
        c.LIVEKIT_API_KEY,
        c.LIVEKIT_API_SECRET,
      );
      const dialed = await dialOutbound({
        dispatch,
        jobId: ctx.job.id,
        trunkId: c.SIP_OUTBOUND_TRUNK_ID,
        roomName: ctx.room.name ?? "",
        maxCallSeconds: c.MAX_CALL_SECONDS,
        claim: (q) => claimOutbound(client, q),
        dial: (trunk, to, room, opts) => sip.createSipParticipant(trunk, to, room, opts),
        deleteRoom: () => ctx.deleteRoom(),
        client,
        telemetry: new CallTelemetry({
          callId: dispatch.outboundCallLogId,
          sipCallId: null,
          room: ctx.room.name ?? "",
        }),
      });
      if (!dialed.ok) {
        ctx.shutdown(dialed.reason);
        return;
      }
      outbound = { callId: dispatch.outboundCallLogId, toNumber: dialed.toNumber };
    }

    // Outbound: wait for the participant this job dialled ("callee"), never
    // anyone else who joins the room. (Agent participants are excluded by
    // the framework in both cases.)
    const participant = await ctx.waitForParticipant(outbound ? "callee" : undefined);
    const attrs = (participant.attributes ?? {}) as Record<string, string>;
    const info = callInfo(ctx, attrs, outbound);
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

    const decision = await decideCall(client, info, telemetry, undefined, c.MAX_CALL_SECONDS);
    const binding = { roomName: info.roomName, sipCallId: info.sipCallId };

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
      onTurn: ({ step, language, serviceMatch }) =>
        telemetry.emit("turn.state", {
          step: step.kind,
          language,
          service_match: serviceMatch.kind,
          service_candidates: serviceMatch.candidates,
        }),
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
      maxCallSeconds: effectiveMaxCallSeconds(c.MAX_CALL_SECONDS, decision.maxCallSeconds),
      io: {
        say: async (t) => void (await session.say(t).waitForPlayout()),
        hangup: async () => {
          await session.close().catch(() => undefined);
        },
        // The conversation session is closed when this runs: speak through a
        // separate TTS-only session (bounded by attachCallGuards' timeout).
        apologize: async (language) => {
          const s = new voice.AgentSession({
            tts: new sarvam.TTS({
              model: "bulbul:v3",
              speaker: "priya",
              targetLanguageCode: language,
            }),
          });
          try {
            await s.start({ agent: new voice.Agent({ instructions: "" }), room: ctx.room });
            await s.say(UNAVAILABLE[language], { allowInterruptions: false }).waitForPlayout();
          } finally {
            await s.close().catch(() => undefined);
          }
        },
        // Delete the room (ends the SIP leg); if that fails, remove the caller.
        disconnect: async () => {
          try {
            await ctx.deleteRoom();
          } catch (err) {
            await new RoomServiceClient(
              c.LIVEKIT_URL.replace(/^wss?:/, "https:"),
              c.LIVEKIT_API_KEY,
              c.LIVEKIT_API_SECRET,
            )
              .removeParticipant(ctx.room.name ?? "", participant.identity)
              .catch(() => {
                throw err;
              });
          }
        },
      },
    });
    // The transcript is read from the session's own history at the moment
    // of each report; klyro merges it per job segment, keeping the longest.
    const transcript = () => transcriptFrom(session.history.items as never);
    // Crash safety: the transcript so far is checkpointed during the call
    // (throttled), so an agent that dies mid-call still leaves it stored.
    const segment = ctx.job.id;
    const checkpoints = new TranscriptCheckpointer({
      snapshot: transcript,
      send: (turns) =>
        checkpointTranscript(client, {
          callId: decision.callId,
          binding,
          segment,
          language: decision.state.language.current,
          transcript: turns,
        }),
      onError: (message) =>
        telemetry.emit("provider.error", {
          provider: "klyro",
          stage: "transcript_checkpoint",
          error: message,
        }),
    });
    session.on(voice.AgentSessionEventTypes.ConversationItemAdded, () => checkpoints.notify());
    ctx.addShutdownCallback(async () => {
      await checkpoints.close();
      await reportEnd(
        client,
        decision.callId,
        "shutdown",
        decision.state,
        telemetry,
        binding,
        transcript(),
        segment,
      );
    });

    await session.start({ agent, room: ctx.room });
    telemetry.emit("call.connected", { ms: Date.now() - joinedAt });
    session.say(decision.greeting, { allowInterruptions: true });
    const { reason } = await guards.finished;
    await checkpoints.close();
    await reportEnd(
      client,
      decision.callId,
      reason,
      decision.state,
      telemetry,
      binding,
      transcript(),
      segment,
    );
  },
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const c = loadConfig();
  // Bounded shutdown (runtime/shutdown.ts): installed before the framework
  // starts, so a SIGTERM before AgentServer.run() or during process-pool
  // warm-up still ends the process. Active calls are never cut short except
  // at the hard cap, which stays below the pod's termination grace period.
  // The active-call count is read in-process from the AgentServer that
  // cli.runApp() creates (captured when its run() starts), not over HTTP.
  const server = captureAgentServer(AgentServer);
  installShutdownWatchdog({
    activeJobs: () => activeJobsOf(server),
    exit: (code) => process.exit(code),
    idleGraceMs: 5_000,
    hardCapMs: c.DRAIN_TIMEOUT_MS + 30_000,
    pollMs: 1_000,
    log: (event, data) => console.log(JSON.stringify({ event, ...data })),
  });
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
