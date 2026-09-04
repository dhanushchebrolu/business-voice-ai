# PHASE E — SARVAM AI VOICE RUNTIME — FINAL REPORT

## 1. Summary

Implements the conversational voice runtime that Phase D's `routeToAgentRuntime`
was left as a documented stub for: a Sarvam-backed STT → LLM → TTS pipeline
with barge-in, call-scoped conversation memory, and a clean audio-transport
boundary. It is fully wired into Phase D's inbound call flow, reuses Phase
B/C's entitlement and billing architecture verbatim, and adds **zero new
database migrations** — every field it needs already existed.

One honest, load-bearing limitation, stated up front rather than buried:
**no telephony provider in this repository implements a live audio media
transport** (Phase D's adapter only ever handled call *control* —
provisioning, dialing, status webhooks — never audio). Phase E defines the
contract that transport must satisfy (`AudioMediaBridge`) and wires
everything on top of it correctly, but `openMediaBridge()` returns `null`
for every provider today, so in this environment `routeToAgentRuntime`
always resolves `handled: false` with that exact reason — never a
fabricated success. See §11/§18.

## 2. Existing architecture inspected

Read in full before writing anything: `PHASE_B_FINAL_REPORT.md`,
`PHASE_C_FINAL_REPORT.md`, `PHASE_D_FINAL_REPORT.md`; `src/lib/telephony/adapter.ts`,
`telephony.server.ts`, `telephony-guard.server.ts`, `telephony-admin.functions.ts`,
`telephony-runtime.ts`; the `phone_numbers`/`call_logs`/`wallet_transactions`/
`pricing_rules`/`usage_records`/`organization_entitlements`/
`organization_feature_locks`/`agent_configs`/`agent_versions` schemas (via
migrations + `types.ts`); `agent-instructions.ts`, `agent-service.server.ts`,
`agent.functions.ts`, `sarvam.server.ts`, `voices.ts`, `app.agent.tsx`; the
Razorpay webhook (idempotency/signature pattern); `platform-admin.server.ts`
(admin auth pattern); RLS/grants across every migration.

The single most consequential finding: **`agent-instructions.ts` +
`agent-service.server.ts` + the `agent_configs`/`agent_versions` tables
already fully implement §6's "agent configuration" requirement** — name,
greeting (per-language), system instructions, language, supported languages,
voice, pace, business context, services, FAQs, escalation (`transfer_number`)
— nothing new was needed there. Reusing it, rather than inventing a parallel
config layer, was the single biggest scope reduction in this phase.

## 3. Files changed

**New:**
- `src/lib/telephony/audio-bridge.ts` — `AudioMediaBridge` contract (§10)
- `src/lib/sarvam-realtime.server.ts` — Sarvam realtime STT/TTS WebSocket clients
- `src/lib/voice-runtime.server.ts` — conversation orchestrator (state machine, sentence buffering, interruption, billing/entitlement wiring)
- `src/lib/telephony-guard.server.test.ts`, `sarvam-realtime.server.test.ts`, `voice-runtime.server.test.ts` — real, runnable tests (see §14)
- `.env.example`

**Modified:**
- `src/lib/telephony-runtime.ts` — stub replaced with the real handoff (defense-in-depth gate re-check → resolve business/agent config → open media bridge → start runtime)
- `src/lib/telephony/adapter.ts` — added optional `openMediaBridge?()` to `TelephonyProviderAdapter` (additive; every existing method unchanged)
- `src/lib/telephony/generic-provider.ts`, `mock-provider.ts` — implement `openMediaBridge()` returning `null` (honest "not supported")
- `src/routes/api/public/webhooks/telephony.ts` — `routeToAgentRuntime` is now also called from the ringing→answered transition path (`applyCallEvent`), not only the new-call-already-answered path; `terminateRuntimeSession` is called before `finalizeCallBilling` on every terminal status
- `package.json` — added `"test": "node --test src/**/*.test.ts"` (zero new dependency — Node 22's built-in test runner + its default TypeScript type-stripping)

No Phase A/B/C/D file was touched beyond the webhook/adapter files listed
above, and those changes are additive.

## 4. Database changes

**None.** `call_logs.transcript` (jsonb), `.summary`, `.language`, and
`.agent_version` (all pre-existing, from Phase 0-A/Phase D) hold the
conversation record; `agent_configs.status` (pre-existing) gets set to
`"live"` on a successful first greeting — the one column that existed but
nothing ever wrote to before (confirmed by inspection: `agentStatusLabel()`
in `workspace.ts` already expected a `"live"` value that no code path
produced). Billing reuses `wallet_transactions`/`pricing_rules`/
`usage_records` exactly as Phase D left them — no new columns there either.

## 5. Sarvam integration

Models: `saaras:v3-realtime` (STT), `bulbul:v3` (TTS) — as directed.
**Verification note, stated plainly per the brief's §28/§33**: this
environment's network egress is restricted to an allowlisted proxy that
does not reach `docs.sarvam.ai` or `docs.pipecat.ai` (`WebFetch` returned
`EGRESS_BLOCKED` for every attempt). `WebSearch` was used instead and
returned genuine, current search-result summaries of Sarvam's docs, which
is what the message-level protocol below is built from — not training-data
guesswork, but also not a direct read of the live spec. Sources:

- [Realtime Speech-to-Text API - saaras:v3-realtime](https://docs.sarvam.ai/api/api-guides-tutorials/speech-to-text/realtime-api)
- [Realtime Streaming Speech-to-Text API - saaras:v3-realtime & v4-realtime](https://docs.sarvam.ai/api/api-guides-tutorials/speech-to-text/realtime-streaming)
- [Streaming Text-to-Speech API - WebSocket](https://docs.sarvam.ai/api/api-guides-tutorials/text-to-speech/streaming-api/web-socket)
- [WebSocket | Sarvam API Docs (TTS)](https://docs.sarvam.ai/api-reference-docs/text-to-speech/stream)
- [Bulbul Text-to-Speech Model](https://docs.sarvam.ai/api-reference-docs/models/bulbul)

Confirmed details actually used: auth via the `api-subscription-key.<key>`
WebSocket subprotocol (the browser-safe mechanism — Node's `WebSocket`
global has the identical constructor signature and also cannot send
arbitrary headers, so this is the correct choice server-side too, not a
workaround); STT `language_code` as a connection parameter with VAD-auto
the documented default, emitting `vad.speech_start`/`vad.speech_end`;
TTS requires a `config` message first, then `convert`/`flush`/`ping`/`close`
client messages and an `audio` server message; Bulbul v3 has no
pitch/loudness controls, pace range 0.5–2.0, default 24kHz.

**Not confirmed**: the exact JSON field names inside the realtime STT
transcript event (partial vs. final). `sarvam-realtime.server.ts`'s
`normalizeSttMessage`/`normalizeTtsMessage` handle this honestly — they try
multiple plausible shapes (documented in the file's own header comment) and
degrade to a structured `{type:"unknown"}` event (logged, never thrown) for
anything unrecognized, rather than asserting one guessed shape is correct.
**This must be re-verified against the live docs, or a real session with
`SARVAM_API_KEY` set, before production use** — flagged in code and here,
not silently shipped as if confirmed.

## 6. STT architecture

`connectSarvamStt()` opens one WebSocket per call, sends raw audio frames
via `sendAudioFrame()`, and normalizes incoming messages into a typed
`SttEvent` union (`partial_transcript`, `final_transcript`, `speech_start`,
`speech_end`, `language_detected`, `error`, `closed`, `unknown`). Server-VAD
mode (the documented default) is used — no manual turn-delimiting needed.
`voice-runtime.server.ts` wires `speech_start` during `SPEAKING`/`THINKING`
directly into barge-in (§11) and `final_transcript` into the conversation
loop. Language: per-agent `primary_language`, or `"unknown"` (auto-detect)
when the agent is configured `multilingual` — reusing the exact
`multilingual`/`extra_languages` fields `agent_configs` already has. Telugu
(`te-IN`) and every other language in `voices.ts`'s `LANGUAGES` list is
supported identically — nothing language-specific is hardcoded.

## 7. LLM architecture

Reused, not reinvented: `sarvam.server.ts`'s existing `sarvam.runConversation()`
(the same REST chat-completion call the pre-existing customer-facing test
console already used) is the default LLM provider, called with
`buildAgentInstructions()`'s deterministic system prompt plus the last 20
conversation turns. It is accessed through a narrow seam
(`handleUserUtterance` in `voice-runtime.server.ts` is the only caller) so a
different/streaming provider can be substituted later without touching the
conversation manager, state machine, or anything upstream.

**Honest limitation**: `sarvam.runConversation` is a non-streaming REST call
(returns the full reply at once) — there is no real "LLM first token"
signal to measure or stream from. Time-to-first-audio is still reduced by
streaming the *returned* text to TTS sentence-by-sentence (`chunkIntoSentences`,
§8) rather than waiting for the full reply to be spoken as one TTS request,
but this is not the same as true incremental token generation. Swapping in
a token-streaming provider later is exactly the kind of change the narrow
LLM seam above is designed to absorb without touching anything else.

Cancellation: `sarvam.runConversation` accepts no `AbortSignal` (it wasn't
modified — that's Phase-pre-E shared code, left untouched per "reuse what
exists"). Interruption instead uses a **generation counter**: every new
utterance/interruption increments `session.generation`; a REST reply that
resolves after the caller already moved on is detected (`generation !==
session.generation`) and discarded rather than spoken over the new turn —
soft cancellation, not hard request abortion, and documented as such.

## 8. TTS architecture

`connectSarvamTts()` sends the required `config` message first (voice,
language, pace, `output_audio_codec`/`output_audio_bitrate` resolved from
the audio bridge's actual outbound format — never hardcoded, never
assumed), then streams text via repeated `convert`+`flush` calls as each
sentence-chunk becomes available, and receives `audio` messages back,
decoded from base64 into the frame bytes handed to `AudioMediaBridge.sendOutboundFrame`.

## 9. Telephony bridge

`AudioMediaBridge` (`telephony/audio-bridge.ts`) is the normalized contract:
`inboundFormat`/`outboundFormat` (encoding + sample rate), inbound-frame
subscription, outbound-frame send, `clearOutboundBuffer()` (for barge-in),
close/on-close. `TelephonyProviderAdapter.openMediaBridge?(providerCallId)`
is the one new, **optional** method on Phase D's existing adapter interface
— optional specifically because it is a different capability (media
transport) from everything else the interface already covered (call
control), and a provider can be fully wired for dialing/webhooks without
implementing it. Both existing adapters (`GenericTelephonyAdapter`,
`MockTelephonyAdapter`) implement it by returning `null` — the honest state,
documented in both files, not a silent gap.

## 10. Barge-in / interruption

On `speech_start` while the runtime is `SPEAKING` or `THINKING`:
`session.generation` is incremented (soft-cancels any in-flight LLM call, §7),
`bridge.clearOutboundBuffer()` drops whatever audio was already queued for
the caller, `tts.flush()` is sent, and state moves to `INTERRUPTED` then back
to `LISTENING` — the caller's new utterance is processed as a fresh turn.
This depends on the bridge actually supporting `clearOutboundBuffer()` (part
of the contract every real implementation must provide) — no interruption
capability is faked for a provider that couldn't actually support it.

## 11. Security

Re-verified by re-reading the actual code and, where possible, the actual
build artifacts — not asserted from the presence of an RLS policy (per the
brief's explicit instruction):

- **Secret exposure**: `SARVAM_API_KEY` is read only inside
  `sarvam-realtime.server.ts`/`sarvam.server.ts` (`.server.ts`-suffixed,
  the same server-only-bundle convention every other secret-handling file in
  this repo already uses). **Verified against the actual build output**:
  `grep -rl "SARVAM_API_KEY|api-subscription-key|SarvamRealtimeError" .output/public/`
  returns nothing; the same strings are present in `.output/server/`. This
  is a real check of the real attack path (what ships to the browser), not
  an inference from file naming.
- **No client-callable entry point**: `voice-runtime.server.ts` and
  `telephony-runtime.ts` export no `createServerFn` — the only caller of
  `routeToAgentRuntime` is the webhook route itself, server-side. A browser
  cannot invoke the runtime, supply a `callId`/`organizationId`/`agentConfigId`,
  or otherwise influence which agent/organization runs.
- **Impersonation**: organization/business/agent are resolved entirely from
  the `phone_numbers` row already validated by Phase D's gate — never from
  any caller-supplied value. There is no code path where a customer selects
  another organization's agent.
- **Entitlement re-check**: `routeToAgentRuntime` calls `checkTelephonyAccess`
  again (the exact Phase D function, not a reimplementation) before doing
  anything — a lock/suspension applied after the call started still blocks
  the runtime from starting.
- **Billing bypass/duplicate billing**: `voice-runtime.server.ts` never
  imports or calls `finalizeCallBilling`, never writes to
  `wallet_transactions` or `usage_records` (`grep -rn "finalizeCallBilling\|wallet_transactions\|usage_records" src/lib/voice-runtime.server.ts`
  returns nothing) — billing stays entirely on Phase D's single,
  webhook-driven path.
- **Provider-cost leakage**: Phase E adds no new provider-cost data at all
  (§16), so there is nothing new to leak; the Phase A/Phase D column grants
  on `usage_records`/`call_logs` are untouched.
- **Sensitive logs**: every `console.*` call in the new code logs only IDs,
  language codes, and error messages — never the API key, never full
  transcript/reply text (verified by grep, listed in §16 below).
- **WebSocket authorization**: the only WebSockets this phase opens are
  *outbound*, from our server to Sarvam, authenticated per-connection via
  the API key. No new *inbound* WebSocket endpoint is exposed to anything —
  `openMediaBridge` returning `null` everywhere means there is no live
  inbound media socket in this environment to attack yet.

## 12. Billing integration

Confirmed zero duplication: Phase D's `finalizeCallBilling` (unchanged) is
still the only code path that debits a wallet or writes `usage_records`,
still triggered only by a terminal provider call-status webhook event.
Phase E's only interaction with billing is temporal ordering:
`terminateRuntimeSession` is called immediately before `finalizeCallBilling`
on a terminal event, so the runtime's resources are torn down and the
transcript is persisted before — never after, never racing — the canonical
billing finalization runs.

## 13. Idempotency

- **Duplicate runtime start**: `startRuntimeSession` checks
  `activeSessions.get(callId)` synchronously before any `await`, so two
  calls into it for the same call — from the "new call already answered"
  path and the "ringing→answered transition" path both potentially firing —
  converge on one session (test-verified, §14).
- **Duplicate termination**: `terminateRuntimeSession` is a no-op if the
  session is already `ENDING`/`ENDED`, or already gone from the map.
- **Duplicate webhook events**: unchanged — still Phase D's
  `webhook_events` unique-index dedupe, upstream of anything Phase E does.
- **Duplicate TTS/billing**: TTS requests are per-sentence-chunk, not
  retried; billing idempotency is entirely Phase D's (untouched).

## 14. Testing

Real, runnable tests — `npm test` (`node --test src/**/*.test.ts`), zero new
dependency (Node 22's built-in test runner plus its default `.ts`
type-stripping). **12/12 pass.**

| File | Covers |
|---|---|
| `telephony-guard.server.test.ts` | Call state machine: same-state no-op, valid forward transitions, illegal transitions rejected (`completed -> in_progress`, `failed -> answered`), every terminal status has no outgoing transitions |
| `sarvam-realtime.server.test.ts` | STT/TTS connect fails fast with a structured `SarvamRealtimeError(code:"not_configured")` when `SARVAM_API_KEY` is unset — before any socket opens |
| `voice-runtime.server.test.ts` | `chunkIntoSentences` (3 cases: sentence-boundary split, short-fragment merging, empty input); `startRuntimeSession` fails closed into `ERROR` state (never throws) with no `SARVAM_API_KEY`; concurrent same-`callId` starts converge on one session |

What is **not** covered by an automated test, and why: everything requiring
a live Sarvam connection or a live telephony media transport — neither
exists in this environment (§18). The authorization-gate tests from the
brief's §24 ("locked customer cannot start runtime," etc.) are covered at
the *unit* level by reusing `checkTelephonyAccess` (Phase D's own function,
already exercised by Phase D's SQL acceptance checks) rather than
re-testing it here; Phase E's own tests focus on what Phase E actually
added. A live-DB, live-Sarvam, live-provider end-to-end test remains a
manual/staging exercise — see §17.

## 15. Build/typecheck/lint results

- **Typecheck** (`npx tsc --noEmit`): **PASS**
- **Build** (`npm run build`): **PASS**
- **Lint** (`npx eslint` on every Phase E file): **PASS**, zero errors.
  (`npm run lint` across the whole repo still reports the same
  pre-existing, pre-Phase-D formatting drift documented in
  `PHASE_D_FINAL_REPORT.md` §26 — unrelated to this phase, left alone.)
- **Tests** (`npm test`): **PASS**, 12/12.

## 16. Migration replay results

**N/A — no migration was added.** Phase D's report already recorded the
14-migration chain (13 + Phase D's) as ordering-consistent; Phase E adds a
15th file count of zero, so there is nothing new to replay. This was not
re-verified against a fresh database in this session (same constraint as
Phase D: no live Postgres/Supabase project is connected here) — **BLOCKED**,
stated plainly rather than assumed.

## 17. Real integration test status

- **Sarvam**: **BLOCKED** — no `SARVAM_API_KEY` exists in this environment
  (verified: `env | grep -i sarvam` → empty). Every Sarvam-calling code path
  was exercised only as far as its documented failure mode (`not_configured`)
  — verified by the tests in §14. No real STT/TTS session was opened; none
  is claimed to have been.
- **Telephony media transport**: **BLOCKED** — no provider implements
  `openMediaBridge` (§9/§11), independent of credentials; even with real
  Sarvam credentials, there is no live call audio to feed it in this
  environment.
- **Full phone call**: **NOT TESTED**, and not claimed to have been.

## 18. Known limitations

1. **No real telephony audio transport.** `openMediaBridge` returns `null`
   everywhere. Concrete next step: pick one real provider account, implement
   its actual media-streaming protocol (e.g. Twilio Media Streams: a
   provider-opened WebSocket carrying base64 mulaw/8kHz frames) as a second
   method on that provider's adapter class, and confirm whether the
   Cloudflare Workers deployment target this project builds for
   (`nitro`'s `cloudflare` preset, per `vite.config.ts`) can hold that
   connection open for a call's duration from within a single TanStack
   Start server-route handler, or whether it needs a Durable Object. This
   was investigated but not resolved in this session — implementing
   unverifiable infrastructure code with false confidence was judged worse
   than flagging it precisely.
2. **Sarvam realtime message schema unconfirmed against live docs** (§5) —
   re-verify before production use.
3. **LLM is REST, not streaming** (§7) — true token-level streaming isn't
   wired; sentence-level TTS streaming is, and materially helps
   time-to-first-audio anyway.
4. **No hard LLM request cancellation** — soft (generation-counter) only.
5. **Single business per organization assumed** when resolving which agent
   to run (matches every other part of this codebase — `workspaceQuery`,
   `getCustomerDetail`, etc. — which all make the same assumption).
   `phone_numbers.agent_config_id` (added in Phase D) is accepted as an
   input but not yet used to pick between multiple agents per organization,
   since none can exist under the current schema.
6. **No dedicated admin UI was added** (§20) — the existing customer
   self-service agent config screen (`app.agent.tsx`) already covers every
   field the brief lists, and admin already has read access to it via
   `getCustomerDetail`. Duplicating that as an admin-editable surface was
   judged out of scope ("do not overbuild") absent a concrete need for
   admin override, which was not identified.
7. **`agent_configs.status` only ever moves forward to `"live"`** — nothing
   resets it if a phone number is later suspended. Flagged, not fixed, to
   avoid scope creep into a liveness/health-check system.

## 19. Environment variables

See `.env.example` (new file). Summary: `SARVAM_API_KEY` (required for any
of this phase's code to do anything — matches the repository's existing
naming convention, already used by `sarvam.server.ts`, so no new/duplicate
name was introduced). Everything else documented there predates Phase E and
is included only for completeness.

## 20. Exact next step

Implement one real provider's live audio media transport (a second method
on that provider's `TelephonyProviderAdapter` implementation, per §18.1),
using a real account's credentials in a staging environment — that is the
one piece nothing in this phase could exercise end-to-end, and it is the
only thing standing between this runtime and an actual phone call.
