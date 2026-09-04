# PHASE D.1 — EXOTEL BIDIRECTIONAL MEDIA TRANSPORT — FINAL REPORT

## 1. Executive summary

Fills the one gap Phase D never closed and Phase E correctly declined to
fake: a real, live audio transport between a phone call and the Sarvam
voice runtime. Exotel's Voicebot Applet is the WebSocket **client** — it
connects to Vaani, not the other way around — which required a new inbound
WebSocket server endpoint that did not exist anywhere in this stack.
Investigation established, with concrete evidence from this project's own
installed dependencies (not assumption), that this deployment target
(Cloudflare Workers via Nitro's `cloudflare-module` preset) **can** accept
and hold such a connection open for a call's duration, and exactly where in
this codebase to do it — see §16 for the full trail.

No Exotel account/credentials exist in this environment, so — per explicit
instruction — no real phone call was tested. What was built is real,
complete, typed, and unit-tested against a deterministic protocol
simulator; what could not be verified against a live account is stated
plainly, not glossed over (§18).

## 2. Existing architecture

Inspected in full before writing anything: `PHASE_B/C/D/E_FINAL_REPORT.md`;
`telephony/adapter.ts`, `telephony.server.ts`, `generic-provider.ts`,
`mock-provider.ts`, `telephony-guard.server.ts`, `voice-runtime.server.ts`,
`telephony-runtime.ts`, `call_logs`/`phone_numbers` schemas,
`wallet_transactions`/billing, the entitlement gate
(`checkTelephonyAccess`), agent configuration, `src/routes/api/public/webhooks/telephony.ts`,
`src/server.ts`, `vite.config.ts`, and — critically — the actual installed
`nitro`/`crossws`/`@lovable.dev/vite-tanstack-config` packages (source, not
docs) to determine real WebSocket support (§16). Confirmed: Phase D/E's
call-control, entitlement, billing, and agent-configuration systems are
untouched and fully reused; the only genuine gap was the media transport
itself, exactly as Phase E's own report and the prior D-vs-E architecture
review concluded.

## 3. Exotel API contract verified

WebFetch could not reach `developer.exotel.com`/`support.exotel.com`
(egress-blocked, same constraint noted for Sarvam in Phase E), so this is
built from WebSearch summaries of Exotel's official docs, not a direct
read — stated plainly, not silently assumed to be exact. Confirmed via
multiple independent search results:

- Voicebot Applet media format: **16-bit signed linear PCM (raw/slin),
  little-endian, 8kHz, mono**, base64-encoded, ~100ms/3200-byte chunks.
- Bidirectional session events: `Connected`, `Start`, `Media`, `DTMF`,
  `Stop`, `Mark`, `Clear` (exact casing inconsistent across sources — this
  adapter matches case-insensitively; see exotel-media-bridge.server.ts).
- WSS URL supports **custom parameters**, max **3**, **≤256 characters
  total** — directly shaped this design's opaque-token approach (§7).
- Exotel does **not** sign webhooks with HMAC — their documented security
  model is HTTPS + a dashboard-configured "webhook verify token" + strict
  payload validation, a materially different mechanism than
  Razorpay/`GenericTelephonyAdapter` assume (§8).
- The Legs API's `content_type: audio/x-mulaw;rate=8000` bidirectional
  stream option exists but was **not** selected — see §4.

Sources: [Working with the Stream and Voicebot Applet](https://support.exotel.com/support/solutions/articles/3000108630-working-with-the-stream-and-voicebot-applet), [AgentStream developer guide](https://developer.exotel.com/docs/agentstream/developer-guide), [Quick Guide to Exotel Streaming](https://support.exotel.com/support/solutions/articles/3000132268-quick-guide-to-get-started-with-exotel-streaming-services), [Sarvam × Exotel voice agent guide](https://docs.sarvam.ai/api/integration/build-voice-agent-with-exotel), [Exotel authentication docs](https://developer.exotel.com/docs/references/authentication), [ExoVerify (GitHub)](https://github.com/exotel/ExoVerify).

## 4. Selected Exotel integration path

**Voicebot Applet** (linear16/PCM), not the Legs API (mulaw). Reasoning:
(a) it is the mechanism that naturally attaches to Phase D's existing
inbound-call architecture — a call flow configured once in the Exotel
dashboard, matching how every other inbound call already reaches Vaani's
webhook; (b) its native format (linear16/8kHz) is **exactly** what
`sarvam-realtime.server.ts` already accepts, so choosing it means **zero
audio transcoding** anywhere in this path (spec §11); (c) it is the path
Sarvam's own integration guide documents for Exotel. The Legs API's
mulaw-at-8kHz bidirectional-stream-on-connect mechanism is a different,
outbound-call-initiation-time pattern not required here and was not
implemented, per the explicit instruction not to build both.

## 5. Files changed

**New:**
- `src/lib/telephony/media-session-token.ts` — opaque signed short-lived token (mint/verify)
- `src/lib/telephony/exotel-media-registry.server.ts` — in-memory rendezvous between the webhook's `openMediaBridge` call and Exotel's own inbound WS connection, plus the duplicate-connection guard
- `src/lib/telephony/exotel-media-bridge.server.ts` — `AudioMediaBridge` implementation wrapping one Exotel WS connection; strict protocol parser
- `src/lib/telephony/exotel-media-route.server.ts` — the inbound WS route logic (upgrade handling, CallSid+DB authorization)
- `src/lib/telephony/exotel-provider.ts` — `ExotelTelephonyAdapter` (call control + `openMediaBridge`)
- `src/routes/api/public/webhooks/exotel.media-token.ts` — optional Passthru-callable endpoint to mint a media-session token mid-flow
- 6 test files (`*.test.ts`) alongside the above — see §17

**Modified:**
- `src/server.ts` — intercepts the one WS-upgrade path before delegating to TanStack Start (§6/§16)
- `src/lib/telephony/adapter.ts` — added optional `url?: URL` parameter to `verifyWebhookSignature` (§8); every other method unchanged
- `src/lib/telephony.server.ts` — wires `ExotelTelephonyAdapter` into `getTelephonyAdapter`; corrected `exotel`'s registry entry (`supportsPurchase: true → false`, `requiredSecrets` 2→3 values — see §34/§5 finding)
- `src/routes/api/public/webhooks/telephony.ts` — passes `url` through to `verifyWebhookSignature` (one line)
- `package.json` — fixed a real bug in the Phase E `test` script: `node --test src/**/*.test.ts` silently skipped every test file more than one directory deep (bash's default, non-`globstar` glob semantics) — this phase's own new nested test files exposed it. Fixed to `node --test` (Node's own recursive discovery from cwd), verified to find and run all 38 tests.

No Phase A–E file was rewritten; every change above is additive or a
narrowly-scoped, evidenced correction.

## 6. WebSocket architecture

```
Exotel (WS client) → src/server.ts (raw Cloudflare Workers fetch handler)
  → handleExotelMediaUpgrade(): path match, WebSocketPair(), server.accept()
  → wait for "start" message (CallSid) → authorize (§8) → claim (§18)
  → ExotelMediaBridge wraps the accepted socket
  → registerMediaBridge() wakes the webhook's pending openMediaBridge() call
  → telephony-runtime.ts's routeToAgentRuntime (UNCHANGED) starts the
    Phase E voice runtime against this bridge
```

`src/server.ts` was the correct interception point, not a new TanStack
Start route — see §16 for why TanStack Start's own routing has no
WebSocket support at all.

## 7. Call correlation

Exotel's Voicebot WSS URL is configured **once, statically**, in the
Exotel dashboard's call-flow — Vaani never dynamically generates it per
call for inbound calls, so the upgrade request itself carries no reliable
per-call identity. The only place Exotel's documented protocol reliably
carries the CallSid is the first WebSocket message (`Start`). Correlation
is therefore: accept the upgrade unauthenticated at the transport level →
wait for `Start` → extract CallSid → cross-check against `call_logs`
(mandatory, always available) → optionally verify a signed media-session
token if present as one of the (max 3, ≤256-char) custom parameters
(defense in depth, requires the Exotel account's call-flow to be built
with a Passthru step calling `exotel.media-token.ts` — §20/§24, not
verified against a live account). The token's absence never weakens the
CallSid+DB check; its presence, if internally inconsistent (wrong call,
wrong org), is rejected outright, never silently ignored.

## 8. Authentication/security

Two entirely separate channels, two separate mechanisms (spec §21 — the
HTTP status webhook and the WS media stream do not share one):
- **Status webhook** (`/api/public/webhooks/telephony?provider=exotel`):
  Exotel does not HMAC-sign (§3) — `ExotelTelephonyAdapter.verifyWebhookSignature`
  compares a `verify_token` query parameter, timing-safe, against
  `EXOTEL_WEBHOOK_SECRET`. This is why `TelephonyProviderAdapter.verifyWebhookSignature`
  gained an optional `url` parameter — the smallest change that could
  accommodate a provider with a genuinely different security model
  (Razorpay/generic-adapter's header-HMAC assumption doesn't fit Exotel).
- **Media WS**: CallSid cross-checked against `call_logs` (existence,
  status `answered`/`in_progress`, organization match) → Phase D's
  `checkTelephonyAccess` gate (reused exactly, not reimplemented) →
  optional media-session-token as a second factor → `claimMediaSession`
  (duplicate-connection guard). Any failure closes the socket (code 1008)
  before a bridge is ever created — no audio is ever forwarded, no runtime
  ever starts, for an unauthorized connection.

## 9. Audio format

Voicebot Applet native: 16-bit signed linear PCM, little-endian, 8kHz,
mono, base64. `ExotelMediaBridge.inboundFormat`/`outboundFormat` both
declare `{ encoding: "linear16", sampleRateHz: 8000 }`.

## 10. Codec conversion

**None.** Sarvam's realtime STT/TTS clients (Phase E,
`sarvam-realtime.server.ts`) already accept/emit `"linear16"` directly.
Choosing the Voicebot Applet path specifically to avoid transcoding (§4)
means `ExotelMediaBridge` passes decoded bytes straight through in both
directions — the honest, minimal-risk choice over writing an unverifiable
mulaw codec for a path that wasn't selected.

## 11. AudioMediaBridge implementation

`ExotelMediaBridge` implements the **existing, unmodified**
`AudioMediaBridge` interface from Phase E exactly — `onInboundFrame`,
`sendOutboundFrame`, `clearOutboundBuffer`, `onClose`, `close`. The one
interface change this phase made (`adapter.ts`'s optional `url` parameter,
§8) is unrelated to `AudioMediaBridge`, which was not touched at all,
matching "do not redesign the interface." Message parsing is strict:
every field is type/shape-validated (including a real base64-shape regex
check — Node's `Buffer.from(str, "base64")` is lenient and silently drops
invalid characters instead of throwing, which a test caught and fixed;
see §17), oversized messages (>64KB) and unrecognized events are logged
and dropped, never thrown, matching "do not crash the entire runtime
because of one malformed frame."

## 12. Barge-in

Unchanged from Phase E's design, now connected to something real:
`voice-runtime.server.ts`'s existing interruption logic calls
`bridge.clearOutboundBuffer()`, which `ExotelMediaBridge` sends as
`{"event":"clear","stream_sid":...}` — Exotel's documented mechanism for
exactly this. No new interruption logic was written; Phase E's was reused
verbatim.

## 13. Mark/Clear handling

`Mark` events received from Exotel are logged (`exotel_bridge:mark`) for
observability only — per the explicit instruction not to build "an
elaborate playback subsystem" when one isn't needed. `Clear` sent *to*
Exotel is real (§12); a `Clear` received *from* Exotel (if this account's
product surface ever sends one) is treated as informational, since this
bridge never buffers inbound audio itself.

## 14. Runtime integration

Zero duplication: `routeToAgentRuntime` (Phase E, `telephony-runtime.ts`)
was **not modified**. `ExotelTelephonyAdapter.openMediaBridge` satisfies
the exact contract Phase E already called — this phase only makes that
call resolve to something real instead of `null`.

## 15. Billing integration

Confirmed via grep across every new file: no reference to
`finalizeCallBilling`, `wallet_transactions`, `usage_records`, or
`debit_wallet` anywhere in Phase D.1's code. Billing remains exactly
Phase D's single, webhook-status-driven path.

## 16. Cloudflare/deployment compatibility

The load-bearing investigation of this phase, done by reading this
project's own installed dependencies rather than assuming:

- `.output/nitro.json` confirms the actual build preset:
  **`cloudflare-module`** (Nitro 3.0.260603-beta).
- `crossws` (Nitro's WebSocket layer, present in `node_modules`) ships a
  Cloudflare adapter whose non-Durable-Object path (`handleUpgrade`) uses
  the plain, standard `new WebSocketPair()` + `server.accept()` primitive
  — Cloudflare's own long-documented mechanism for a Worker to accept and
  hold a WebSocket connection open in a `fetch` handler, without a
  Durable Object.
- Nitro **also** ships a complete, ready-made `cloudflare-durable` preset
  (`node_modules/nitro/dist/presets/cloudflare/runtime/cloudflare-durable.mjs`)
  wiring a full `DurableObject` class with Cloudflare's Hibernatable
  WebSockets API — confirming Durable Objects are a **configuration
  choice** this framework already fully supports, not something requiring
  hand-written Cloudflare primitives, if ever needed for higher
  concurrency than a plain Worker handles well.
- **However**: neither `@tanstack/react-start` nor
  `@tanstack/start-server-core` reference "websocket" anywhere in their
  source (grepped directly) — TanStack Start's own file-route convention
  has **no WebSocket support**. `defineWebSocketHandler` exists only in
  `h3`/`h3-v2`, one layer below what TanStack Start exposes.
- The resolution: `src/server.ts` is **already** this project's raw
  Cloudflare Workers `fetch(request, env, ctx)` entry point (confirmed by
  reading it — it's a deliberate, pre-existing extension point, not
  something this phase invented), sitting in front of TanStack Start's own
  handler. That is where `handleExotelMediaUpgrade` was wired in — the
  smallest, most direct way to reach the platform's native `WebSocketPair`
  without bypassing the framework in an unsupported way.
- `WebSocketPair` is referenced only via runtime feature-detection
  (`typeof globalThis.WebSocketPair === "function"`), never assumed to
  exist at compile time — this repo has no `@cloudflare/workers-types`
  dependency (deliberately not added, to avoid an unnecessary dependency
  for one ambient global), and this code fails closed with **501, not a
  crash**, everywhere that global is absent — which is the actual,
  verified state of local `vite dev` and this Node test runner (§17's
  third `exotel-media-route.server.test.ts` test asserts exactly this).

**What this establishes with high confidence, and what remains
unverified**: the plain-Worker `WebSocketPair` approach is real,
standard, well-established Cloudflare Workers behavior (not proprietary
or exotic) that this project's own build already targets and that
crossws/Nitro rely on identically. It was **not** empirically confirmed
by an actual live deployment (no Cloudflare account/deploy access in this
environment) — that is the honest limit of what source-level verification
can establish. Durable Objects were deliberately **not** introduced: they
are a documented, available scaling optimization (Nitro's
`cloudflare-durable` preset), not a prerequisite for a single call's
connection to survive its duration on a plain Worker.

## 17. Tests

`node --test` (fixed script, §5) — **38/38 pass**, including the 12 from
Phase E and 26 new. Genuinely a **protocol/integration simulation**
(spec §29), not an end-to-end Exotel test:

| File | Covers |
|---|---|
| `media-session-token.test.ts` (6) | mint+verify round trip, expired token, tampered signature, cross-secret/forged-style rejection, malformed token, missing secret config |
| `exotel-media-registry.server.test.ts` (5) | duplicate-claim rejection (§18), release+reclaim, waiter resolves on register, resolves immediately if bridge arrived first, timeout-to-null |
| `exotel-media-bridge.server.test.ts` (3) | full `Connected→Start→Media→Media→Mark→Clear→Media→Stop` simulation (stream_sid correctly learned from Start and echoed on outbound/clear; inbound frames decoded correctly); 5 distinct malformed-message cases dropped without throwing (a real bug — lenient `Buffer.from` base64 decoding — was caught and fixed here); `close()` idempotency |
| `exotel-provider.test.ts` (7) | verify_token pass/fail/missing/no-url; form-urlencoded and JSON webhook parsing; unknown status → `null` (never guessed); missing CallSid → `null`; `provisionNumber`/`releaseNumber` fail honestly |
| `exotel-media-route.server.test.ts` (3) | non-matching path passes through (`null`); non-upgrade request to the media path → 400; **no `WebSocketPair` global → 501, not a crash** (the real, current state of this test environment) |

**Not covered**, and why: the `handleExotelMediaUpgrade`'s internal
`call_logs`/`phone_numbers`/`checkTelephonyAccess` authorization chain
(spec §31 items 6–11: inactive call, completed call, locked customer,
locked service, missing entitlement, inactive phone number) requires a
live database — none exists in this environment (same constraint as every
prior phase's DB-dependent code). The *logic* is not new, though: it's a
direct call to Phase D's own `checkTelephonyAccess`, already the
authoritative, previously-established gate — what's new here is only the
wiring, which is a straightforward function call away from the same
tested function, not new authorization logic.

## 18. Real Exotel test results

**BLOCKED — explicitly, not glossed over.** No Exotel account or
credentials exist in this environment (`env | grep -i exotel` → empty).
None of spec §30's 13 live-call tests were performed, and none is claimed
to have been. What *is* real: the protocol parser, the token
mint/verify logic, the correlation/duplicate-guard registry, the
Cloudflare WebSocket mechanism (source-verified, §16), and their
integration — all independently exercised by real, passing tests.

## 19. Known limitations

1. **No live account verification** of exact webhook field names, the
   Connect API's exact request/response shape, or the Voicebot event
   casing (§3) — flagged in code comments at each point, not silently
   assumed correct.
2. **Custom-parameter/Passthru token wiring unverified** — whether a given
   Exotel account's call-flow builder can actually template a per-call
   value from a Passthru response into the Voicebot Applet's WSS URL
   custom parameters was not confirmed. The mandatory CallSid+`call_logs`
   check does not depend on this working.
3. **DTMF is received but not forwarded** to the runtime — out of scope
   for a conversational voice agent; would matter for IVR-menu-style
   flows, a different feature.
4. **No live Cloudflare deployment test** (§16) — source-level evidence is
   strong but not empirical.
5. **`Mark` events are logged only**, not used for precise playback-sync
   timing — deliberately minimal per spec §15.
6. **Outbound calls do not get a Voicebot stream attached automatically**
   — `initiateOutboundCall` starts the call via Exotel's Connect API with
   a `StatusCallback` only; attaching a bidirectional stream to an
   *outbound*-initiated call is a distinct Exotel call-flow/App
   configuration this phase did not need, since Phase D's own runtime
   handoff (`routeToAgentRuntime`) only ever triggers for inbound calls
   (§14's report on Phase D's own architecture) — not implemented, not
   invented, per the explicit instruction not to build an unsupported
   outbound mechanism.

## 20. Required Exotel dashboard configuration

Documented, not claimed to have been performed (no account exists to
perform it against):
1. An incoming-call **App Bazaar flow** whose entry point is a Voicebot
   Applet, WSS URL set to
   `wss://<your-vaani-host>/api/public/media-stream/exotel`.
2. *(Optional, for the token second factor)* A **Passthru** applet step
   before the Voicebot Applet, calling
   `https://<your-vaani-host>/api/public/webhooks/exotel/media-token?verify_token=<EXOTEL_WEBHOOK_SECRET>&CallSid={{CallSid}}`
   (exact templating syntax for `{{CallSid}}` must be confirmed against
   the account's flow builder), feeding its `token` response field into
   the Voicebot Applet's custom parameters.
3. The account's **status callback** configured to
   `https://<your-vaani-host>/api/public/webhooks/telephony?provider=exotel&verify_token=<EXOTEL_WEBHOOK_SECRET>`.
4. `EXOTEL_SID`/`EXOTEL_API_KEY`/`EXOTEL_TOKEN` (from the Exotel account's
   API settings) and `EXOTEL_WEBHOOK_SECRET` (a value you choose,
   configured identically in the flow's URLs above) set as environment
   variables — never committed.

## 21. Required environment variables

See `.env.example` (updated). New/corrected this phase: `EXOTEL_SID`,
`EXOTEL_API_KEY` (new — the registry previously only listed 2 of Exotel's
3 real credential values), `EXOTEL_TOKEN`, `EXOTEL_SUBDOMAIN`,
`EXOTEL_WEBHOOK_SECRET` (repurposed from a generic HMAC-secret name to
Exotel's actual verify-token value — same env var name, correct semantics
documented), `MEDIA_SESSION_TOKEN_SECRET` (new).

## 22. Exact next step

Get a real Exotel trial/account, configure it per §20, set the
environment variables per §21, deploy this branch to a real Cloudflare
Workers environment, and run spec §30's 13 live-call tests in order —
that is the one thing nothing in this session could do, and everything
else was built specifically so that step is the only one left.
