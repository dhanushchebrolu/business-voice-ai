# Voice pipeline testing: tiers, commands, and runbooks

This is the testing reference for the backend voice-agent call pipeline
(`Vobiz → telephony adapter → Klyro call session → Sarvam STT → LLM →
Sarvam Bulbul TTS → audio out → transcript/call-log persistence`). It
covers four tiers, from "always runs in CI, zero external dependencies" to
"a real phone call against a deployed environment."

## Tier 1 — Unit tests (no I/O)

Pure-function tests: the runtime state machine, sentence chunking, etc.

```
node --experimental-strip-types --test src/lib/voice-runtime.server.test.ts
node --experimental-strip-types --test src/lib/sarvam.server.test.ts
```

No environment variables required. These run as part of the full suite
(`node --experimental-strip-types --test src/**/*.test.ts
src/**/**/*.test.ts`).

## Tier 2 — Integration tests (mocked Sarvam, deterministic)

Drives the real `startRuntimeSession`/`terminateRuntimeSession` orchestration
end-to-end — state machine, barge-in, silence timer, persistence — against
deterministic fake STT/TTS/LLM implementations injected through
`RuntimeDeps` (`src/lib/voice-runtime.server.ts`). No network call, no
credentials, fully deterministic.

```
node --experimental-strip-types --test src/lib/voice-runtime-harness.test.ts
```

The fakes and the harness itself live in
`src/lib/telephony/voice-runtime-test-harness.ts` and are reusable for
writing further scenarios — see that file's module doc for the fake
STT/TTS/LLM/persistence/bridge APIs.

Also in this tier: `src/lib/telephony/call-session-durable-object.server.test.ts`
(the Durable Object coordinator, including the pre-registration
buffering/waiter-cleanup fixes) and `src/lib/telephony-runtime.test.ts`
(tenant isolation and agent-loading, source-scanned — see that file's
module doc for why source-scanning is this repo's established technique
for Supabase-dependent code with no live database in this sandbox).

## Tier 3 — Live Sarvam test (real credentials, no phone call)

Exercises the actual Sarvam STT/LLM/TTS APIs over the network, without
needing a real telephone call. Requires a real `SARVAM_API_KEY`.

**Before running this tier, read the open schema questions below** — this
repo's Sarvam clients were built and verified against Sarvam's own docs at
the time, but `docs.sarvam.ai` is unreachable from this sandbox (network
egress is blocked for that domain and every other Sarvam/documentation host
tried), so nothing here has actually been exercised against the live API.
The two module doc comments below list every point where secondary sources
(WebSearch summaries, a third-party community Rust SDK) disagreed with the
current implementation or with each other — check these FIRST if 3a/3b/3c
fail, since each is a specific, actionable candidate root cause rather than
a generic "something's wrong":

- `src/lib/sarvam.server.ts` — `SARVAM_MODELS.chat`/`stt` were updated to
  `"sarvam-105b-conversations"`/`"saaras:v3"` (from `"sarvam-m"`/
  `"saaras:v2.5"`) on a user-supplied reference that also matches this
  repo's own README spec section — the model-name question itself is
  resolved as far as this repo's sources go, but neither value has been
  exercised against the live API yet. 3a is exactly that first live check;
  a rejected/unknown-model error there is still the thing to report back.
- `src/lib/sarvam-realtime.server.ts` — is the STT WebSocket path
  `/speech-to-text/ws` (current code) or `/speech-to-text-realtime/ws`? Is
  inbound audio sent as raw binary frames (current code) or base64-encoded
  inside a JSON `{"event":"audio_input",...}` message? Are the STT query
  params `language-code`/`sample-rate` (current code) or
  `language_code`/`sample_rate`? Is the TTS config field
  `target_language_code` (current code) or `language_code`?

A `ProviderError`/connection failure in 3a or 3b that isn't explained by a
bad key or Sarvam being down should be checked against this list before
assuming a deeper bug — the fix, if one of these is wrong, is a small,
targeted change in the named file, not a redesign.

### 3a. LLM only (fastest smoke test)

```bash
SARVAM_API_KEY=<real key> node --experimental-strip-types -e '
import("./src/lib/sarvam.server.ts").then(async ({ sarvam }) => {
  const { reply } = await sarvam.runConversation([
    { role: "system", content: "You are a helpful receptionist for a bakery called Sweet Treats." },
    { role: "user", content: "What time do you open?" },
  ]);
  console.log("LLM reply:", reply);
});
'
```

Expect a plausible reply within a few seconds. A `ProviderError` naming a
504 means the new 15s request timeout (`sarvam.server.ts`) fired — check
Sarvam's status page before assuming the key is wrong.

### 3b. Streaming STT + TTS (requires a short WAV/PCM sample)

```bash
SARVAM_API_KEY=<real key> node --experimental-strip-types -e '
import("./src/lib/sarvam-realtime.server.ts").then(async ({ connectSarvamTts }) => {
  const session = await connectSarvamTts({
    voiceId: "ritu",
    language: "en-IN",
    pace: 1,
    outputCodec: "linear16",
    outputSampleRateHz: 8000,
    onEvent: (e) => {
      if (e.type === "audio") console.log("received audio chunk, bytes:", e.data.length);
      else console.log("event:", e.type);
    },
  });
  session.sendText("Hello, thanks for calling.");
  session.flush();
  await new Promise((r) => setTimeout(r, 3000));
  session.close();
});
'
```

Expect one or more `received audio chunk` lines. For STT, the equivalent
`connectSarvamStt` call needs a real audio source (a WAV file split into
frames, or a microphone capture) — there is no packaged live STT smoke
script in this repo; construct one from `connectSarvamStt`'s documented
interface in `sarvam-realtime.server.ts` if a full loop test is needed.

### 3c. Full runtime, fake bridge, real Sarvam

The most complete non-telephony live test: real Sarvam STT/TTS/LLM, driven
through the actual `startRuntimeSession` orchestration, with only the
_telephony_ transport faked (no real call needed).

```bash
SARVAM_API_KEY=<real key> node --experimental-strip-types -e '
import("./src/lib/voice-runtime.server.ts").then(async ({ startRuntimeSession, terminateRuntimeSession }) => {
  const { createFakeBridge } = await import("./src/lib/telephony/voice-runtime-test-harness.ts");
  const bridge = createFakeBridge();
  const handle = await startRuntimeSession({
    callId: "live-smoke-test-1",
    organizationId: "00000000-0000-0000-0000-000000000000",
    businessId: "00000000-0000-0000-0000-000000000001",
    agentConfigId: null,
    agentVersion: null,
    instructions: "You are Aria, a receptionist for Sweet Treats bakery.",
    snapshotAgent: {
      agent_name: "Aria", persona: "professional", custom_personality: null,
      objectives: ["answer_questions"], capabilities: {}, primary_language: "en-IN",
      extra_languages: [], multilingual: false, voice_id: "ritu", speaking_pace: 1,
      greetings: { "en-IN": "Hello, thanks for calling Sweet Treats." },
      transfer_number: null, after_hours_behavior: "take_message",
    },
    businessName: "Sweet Treats",
    bridge,
  });
  console.log("state after startup:", handle.state); // expect "listening"
  console.log("greeting audio frames received:", bridge.sentFrames.length);
  await terminateRuntimeSession("live-smoke-test-1", "smoke test done");
});
' 2>&1 | grep -v "^voice_runtime:"
```

No `persistTranscript`/database call is exercised here (no `deps` passed —
this uses the real `defaultRuntimeDeps`, which will attempt the real
`call_logs` write on termination and log-and-swallow a failure if Supabase
isn't configured in this shell — expected in a local smoke test).

## Tier 4 — Live telephony test (a real Vobiz call)

Cannot be automated from this repository: it needs a deployed Worker and a
Vobiz number. Set it up on staging as described in `voice-staging.md`
(`SARVAM_API_KEY`, the three `VOBIZ_` values, `TELEPHONY_WEBHOOK_BASE_URL`;
the `VOBIZ_CALL_SESSION` binding is declared in `wrangler.json`). The
organization's agent must be `ready` or `live`, and its number `active`
with `inbound_enabled`. A real call needs approval.

### Making the test call

1. Call the test number from a real phone.
2. Expect to hear the configured greeting within a few seconds of the call
   connecting.
3. Speak a question; expect a spoken reply after a short pause.
4. Interrupt the agent mid-reply; expect it to stop talking immediately.
5. Go silent for ~12 seconds; expect "Are you still there?"; stay silent
   another ~10 seconds; expect the call to end gracefully.
6. Hang up normally; confirm in the admin Calls view
   (`/admin/calls` or the org's Customer 360 page) that:
   - `call_logs.status` reached `completed`
   - `call_logs.transcript` contains the full turn-by-turn conversation
   - `call_logs.duration_seconds`/`ended_at` are populated

### Where to look when something doesn't work

- Cloudflare Worker logs (`wrangler tail`, filtered for `voice_runtime:`,
  `vobiz_call_session_do:`, `vobiz_bridge:`, `telephony:` prefixes — every
  log line in this pipeline is prefixed this way and carries `call_id`/
  `organization_id`, never a secret value).
- The Durable Object's own `/internal/status?callId=<id>` endpoint (only
  reachable from inside the Worker, not public) reports whether a runtime
  session is currently active and its state.
