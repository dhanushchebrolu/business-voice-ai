# Sarvam LLM migration (Phase 2.18)

Target: Sarvam end to end (LLM `sarvam-105b-conversations`, STT Saaras v3, TTS Bulbul v3) on LiveKit Agents, Vobiz SIP, klyro on Cloudflare Workers, Supabase PostgreSQL. **No Anthropic in the target architecture and no LLM fallback.**

**Status: implemented behind `LLM_PROVIDER=sarvam` and tested with a fake Sarvam endpoint. NOT accepted:** no live Sarvam LLM call has been made (no key, no approval), so nothing in this document is experimentally verified against Sarvam. **Go/no-go: NO-GO for staging traffic on Sarvam; GO for the paid benchmark (§6) once approved.** The default stays `LLM_PROVIDER=anthropic` until acceptance; Claude is removed only after that (§9).

## 1. Part A: Sarvam chat API evidence

Status key: **DOC** = stated in Sarvam's documentation (or a Sarvam-owned repository); **3P** = third-party integration documentation only; **VER** = verified by a live request (none yet); **UNK** = not found.

| Item                                    | Finding                                                                                                                                                                                      | Status                                                                             | Source                                                                                                                                                          |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Endpoint                                | `POST https://api.sarvam.ai/v1/chat/completions`. A V2 endpoint (`/v2/chat/completions`) exists, may need account access (400 otherwise) and rejects legacy `functions`/`function_call`      | DOC                                                                                | [V1 reference](https://docs.sarvam.ai/api-reference/chat/chat-completions-v1), [V2 reference](https://docs.sarvam.ai/api-reference/chat/chat-completions-v2)    |
| Models                                  | `sarvam-105b` (128K context), `sarvam-105b-conversations` (32K, tuned for dialogue) on V1                                                                                                    | DOC                                                                                | [sarvam-105b model page](https://docs.sarvam.ai/api/getting-started/models/sarvam-105b)                                                                         |
| Auth                                    | `api-subscription-key: <key>`; `Authorization: Bearer <key>` accepted for OpenAI-compatible clients                                                                                          | DOC                                                                                | [Overview](https://docs.sarvam.ai/api/api-guides-tutorials/chat-completion/overview), [LangChain integration](https://docs.sarvam.ai/api/integration/langchain) |
| Request schema                          | OpenAI-style `messages` (system/user/assistant/tool), `temperature`, `top_p`, `max_tokens`, `stream`, `tools`, `tool_choice`                                                                 | DOC                                                                                | V1 reference                                                                                                                                                    |
| Tool calling                            | `tools: [{type:"function", function:{name, description, parameters}}]`; `tool_choice`: `auto`/`none`/`required`/named function. `required` with no tools → 400; unknown named function → 400 | DOC                                                                                | V1/V2 references, [Token Factory](https://docs.sarvam.ai/api/token-factory/chat-completions)                                                                    |
| Tool arguments                          | `arguments` as a JSON **string** (OpenAI format)                                                                                                                                             | DOC (format), UNK (whether ever an object)                                         | V1 reference                                                                                                                                                    |
| Multiple tool calls                     | Several `tool_calls` per response possible; `parallel_tool_calls: false` reported as not enforced on 105b (sources conflict)                                                                 | DOC, conflicting                                                                   | V2 reference                                                                                                                                                    |
| Continuation                            | Assistant message with `tool_calls`, then `role: "tool"` messages with `tool_call_id`                                                                                                        | DOC (OpenAI-compatible)                                                            | V1 reference                                                                                                                                                    |
| Streaming                               | `stream: true` → SSE `data:` chunks, terminated by `data: [DONE]`                                                                                                                            | DOC                                                                                | V1 reference                                                                                                                                                    |
| Usage                                   | `prompt_tokens`, `completion_tokens`, `total_tokens`; in streaming, in a final chunk with `choices: []`                                                                                      | DOC (fields), Sarvam SDK issue (streaming placement)                               | [sarvam-ai-sdk#20](https://github.com/sarvamai/sarvam-ai-sdk/issues/20)                                                                                         |
| `stream_options.include_usage`          | Accepted or ignored?                                                                                                                                                                         | UNK                                                                                | —                                                                                                                                                               |
| Reasoning                               | 105b reasons by default; reasoning tokens count as completion tokens; `reasoning_effort` control                                                                                             | DOC (default on), UNK (exact parameter and effect on latency for `-conversations`) | model page, [Pipecat](https://docs.pipecat.ai/server/services/llm/sarvam) (3P)                                                                                  |
| System messages after the first message | Accepted? (the receptionist inserts its per-turn directive as a system message)                                                                                                              | **UNK: first thing the benchmark checks**                                          | —                                                                                                                                                               |
| Errors                                  | 400 invalid request; 403 invalid/missing key; 422 validation; 429 rate limit or `insufficient_quota_error`; 500; 503 overloaded. Retry 429/503 with backoff                                  | DOC                                                                                | V1 reference, error guides                                                                                                                                      |
| Rate limits                             | No published per-minute numbers found                                                                                                                                                        | UNK                                                                                | —                                                                                                                                                               |
| Timeouts                                | No published server timeout                                                                                                                                                                  | UNK                                                                                | —                                                                                                                                                               |
| Pricing                                 | Not hard-coded here; take from Sarvam's pricing page on the day of the benchmark                                                                                                             | —                                                                                  | —                                                                                                                                                               |

No Sarvam host was reachable from this environment (blocked by the network policy) and no `SARVAM_API_KEY` was set, so no request (paid or free) was made.

## 2. Part B: adapter design (against the installed SDK, not guessed)

Inspected: `@livekit/agents` 1.9.5 (`llm/llm.js` LLMStream retry loop, `inference/llm.js` LLMStream parser, `voice/generation.js` tool executor, `llm/provider_format/openai.js`), `@livekit/agents-plugin-openai` 1.9.5 (`LLM`, `LLMOptions`), `@livekit/agents-plugin-sarvam` 1.9.5 (STT and TTS only, no LLM), `openai` 6.49.0.

```
AgentSession ──chat()──► openai.LLM (plugin 1.9.5)          src/agent/sarvam-llm.ts: createSarvamLlm
                          │  model sarvam-105b-conversations, temperature 0.2, parallel_tool_calls false
                          ▼
                         inference.LLMStream.run()            (LiveKit's parser, unchanged)
                          │  client.chat.completions.create({stream:true, stream_options, tools, ...},
                          │                                  {timeout: connOptions.timeoutMs, signal})
                          ▼
                         OpenAI client (openai 6.49.0)        baseURL https://api.sarvam.ai/v1, maxRetries 0,
                          │                                   Authorization: Bearer + api-subscription-key
                          ▼
                         sarvamFetch → normalizeSarvamSse     rewrites the SSE body (below)
                          ▼
                         POST https://api.sarvam.ai/v1/chat/completions
```

Why not a hand-written `llm.LLM`: the plugin already implements the installed SDK's `LLM`/`LLMStream` contract (chat context conversion, tool schemas, usage, metrics, cancellation, error classes). The risk is in its parser's assumptions, which the normaliser handles at the HTTP layer without forking LiveKit code.

| Concern                                         | Behaviour                                                                                                                                                                                                                                                      | Where                    |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| Streaming                                       | Text deltas forwarded as they arrive; `<think>…</think>` stripped by LiveKit's ThinkingTokenFilter; `reasoning_content` deltas ignored                                                                                                                         | LiveKit parser           |
| Tool-call streaming                             | Fragments accumulated per call; continuation fragments carry arguments only; object arguments serialised                                                                                                                                                       | normaliser               |
| Tool-call ids                                   | Provider id kept; missing id → `sarvam_<time>_<seq>_<index>` (unique per request). Without this the unwrapped plugin **drops the call** (control run)                                                                                                          | normaliser               |
| Several calls                                   | Split into one chunk per call; finish reason in its own chunk. Without this the plugin keeps only the first call of a multi-call delta and loses a call whose start carries the finish reason                                                                  | normaliser               |
| History and continuation                        | LiveKit's OpenAI provider format: assistant `tool_calls` followed directly by `tool` messages with matching `tool_call_id`; the receptionist's per-turn directive (system) comes after them. Tested end to end                                                 | LiveKit + test           |
| Cancellation / interruption                     | `stream.close()` aborts the HTTP request (the fetch signal is passed through the wrapper)                                                                                                                                                                      | tested                   |
| Timeouts                                        | Per request `connOptions.timeoutMs` (LiveKit default 10 s); timeout → `APITimeoutError`, retried                                                                                                                                                               | tested                   |
| Retries                                         | LiveKit's loop only (`maxRetry` 3 by default); SDK retries off. A request is retried only while nothing has reached the caller: the parser marks the stream non-retryable at the first text or tool call, so **a tool can never run twice because of a retry** | tested                   |
| Error classes                                   | 4xx except 408/429 → not retried (403 auth, 400, 422); 429, 5xx, network, timeout → retried                                                                                                                                                                    | LiveKit `APIStatusError` |
| Malformed responses                             | Bad JSON, `error` objects inside the stream, chunks without `choices`/`delta`, empty responses, streams cut without `[DONE]` → provider error (retried if nothing was said) or ignored safely                                                                  | normaliser, tested       |
| Truncated tool call (`finish_reason: "length"`) | Not emitted, so never executed                                                                                                                                                                                                                                 | tested                   |
| Usage and latency                               | LiveKit `llm_metrics`: time to first token, duration, prompt/completion tokens (from Sarvam's usage chunk)                                                                                                                                                     | tested                   |
| Secrets                                         | Key only in headers; never in errors (tested); base URL pinned to `https://api.sarvam.ai/v1` outside development                                                                                                                                               | config                   |

Configuration (`src/runtime/config.ts`): `LLM_PROVIDER=sarvam|anthropic` (default `anthropic` until acceptance), `SARVAM_LLM_MODEL` (`sarvam-105b-conversations` | `sarvam-105b`), `SARVAM_LLM_REASONING_EFFORT` (optional, unset = not sent), `SARVAM_LLM_BASE_URL` (development only). With `sarvam`: `SARVAM_API_KEY` is the only LLM credential, `ANTHROPIC_API_KEY` is ignored, `FALLBACK_LLM_BASE_URL` is **refused**, no `FallbackAdapter`.

## 3. Part C: booking guarantees (unchanged)

The LLM swap does not touch the booking path:

- The three tools (`check_availability`, `book_appointment`, `get_service_price`) take **no arguments** (`z.object({})`). Service, date, time, name and phone come from the deterministic call state built from the caller's words, not from the model.
- `book_appointment` refuses unless the read-back was confirmed (`readyToBook`); availability is only what klyro returns; prices only what the business published (and the reply guard removes any other price).
- All writes go through klyro's HMAC-authenticated internal API, which owns authorization, entitlement, availability validation, idempotency (same call + slot = same key), duplicate prevention and time zones. The model has no database access.
- Unknown tools and invalid arguments are rejected by LiveKit's executor before anything runs (tested: a `delete_all_bookings` call does nothing).
- The reply guard removes booking, availability and price claims not backed by a tool result, whatever the model.

## 4. Part D: tests

`tests/sarvam-llm.spec.ts`: 44 tests, real LiveKit stack, fake HTTP only:

- **Request:** endpoint, both auth headers, model, `stream`, `stream_options`, temperature, `parallel_tool_calls`, tools format; no tool fields without tools; `reasoning_effort` only when configured.
- **Text:** ordered Telugu/Hindi/English streaming; usage from a `choices: []` chunk and from a finish chunk; `llm_metrics` (TTFT, duration, tokens); `<think>` and `reasoning_content` never spoken; chunks without `choices`/`delta`; CRLF and SSE comments.
- **Tool calls:** single; missing id; three in one delta; two without ids or indexes; finish reason on the starting chunk; repeated names; object arguments; `[DONE]` without finish reason; `length` truncation (not executed); text plus call; orphan argument fragments.
- **Errors:** 429 and 503 retried, one request per attempt; 400/403/422 not retried; key never in errors; retries exhausted; malformed JSON; empty response; in-stream error; cut stream before and after speech; cut stream with a half-received call (not executed); no retry after a completed call; timeout; network failure; cancellation aborts the request.
- **Configuration:** sarvam builds only the Sarvam LLM even with an Anthropic key; no Anthropic key needed; fallback refused; base URL pinned outside development; unknown provider/model rejected; default unchanged.
- **Full lifecycle through AgentSession + ReceptionistAgent + Sarvam adapter + in-memory backend:** Telugu → code-mixed → Hindi, check → confirm → book, with provider ids and with **ids omitted** (every continuation's `tool_call_id` checked against the call it answers); exactly one booking, booked claim only after the tool; a model that books early, invents availability and calls an unknown tool changes nothing.

Database semantics are unchanged by this phase; the existing real-PostgreSQL suites for the booking path were re-run: `booking_concurrency`, `voice_booking_persistence`, `voice_reschedule` and `voice-agent-api` (179/179 pass). Voice-agent package: 183/183 pass; typecheck, ESLint and Prettier clean on all changed files.

**Not proven by these tests:** that Sarvam's responses have these shapes; how well sarvam-105b follows the receptionist's NEXT STEP directive, calls tools at the right time and speaks Telugu/Hindi; latency; cost. Those need §6.

## 5. Control run (why the normaliser exists)

Same SSE inputs through the unwrapped `openai.LLM`: three calls in one delta → 1 emitted; a call without id → 0 emitted; finish reason on the last call's first chunk → last call lost; repeated name → arguments `":1}"` instead of `{"x":1}`; no finish reason → 0 emitted; chunk without `choices` → `chunk.choices is not iterable`. With the normaliser all six behave correctly (tests above).

## 6. Part E: benchmark (harness ready, not run)

`bench/llm-compare.ts`: refuses to run unless `LLM_BENCH_APPROVED=yes`. Uses the production `buildLlm`, the real receptionist, tools and guards in a text-mode AgentSession, against the in-memory backend. Scenarios: Telugu, Hindi, English, code-mixed bookings, and an unknown-price question without booking. Reports per provider: TTFT and full latency p50/p95 per model request, tool correctness, booking success, guard interventions, provider errors, reply-script match (proxy for language), tokens, and cost per conversation, per booking and per assumed minute from **prices you supply** (`*_PRICE_IN_PER_1M`, `*_PRICE_OUT_PER_1M`); transcripts are included for native-speaker review.

Run plan (needs approval and keys with spend caps):

1. **Smoke (≈ 5 conversations, Sarvam only):** checks the UNK items in §1, starting with mid-conversation system messages, `stream_options`, `parallel_tool_calls`, tool-call shape and reasoning latency. Stop on any 4xx.
2. **Comparison:** `BENCH_RUNS=20` (100 conversations per provider), both providers, same day.
3. **Variants if latency fails:** `SARVAM_LLM_REASONING_EFFORT=low`; `SARVAM_LLM_MODEL=sarvam-105b`.

**Proposed acceptance thresholds (Sarvam, to confirm):** zero bookings without confirmation and zero unbacked availability/price claims reaching the caller (hard); booking success ≥ 95 % and no more than 3 points below Claude; tool correctness ≥ 98 %; provider errors after retries < 1 %; LLM TTFT p50 ≤ 800 ms and p95 ≤ 1.5 s; reply-script match ≥ 95 % plus native-speaker rating ≥ 4/5 on a sample per language; cost per booking recorded. Then staging calls A2, A3, A4, A7 (PRODUCTION_READINESS.md §15) on Sarvam. **A few successful completions do not establish production suitability.**

## 7. Risks and blockers

| #   | Risk / blocker                                                                                      | Severity    | Mitigation / next step                                                                                                                           |
| --- | --------------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| S1  | No live Sarvam LLM evidence (no key, host blocked here, no approval)                                | **Blocker** | Approve the §6 smoke run with a capped key                                                                                                       |
| S2  | Sarvam may reject or ignore system messages after the first (the receptionist's per-turn directive) | High        | Smoke run checks it first; if rejected, send the directive as a prefix of the last user/tool turn for Sarvam (receptionist-only change, re-test) |
| S3  | Reasoning on by default may make TTFT too slow for voice                                            | High        | Measure; try `reasoning_effort=low`; otherwise no-go                                                                                             |
| S4  | `stream_options` / `parallel_tool_calls` may be rejected (422)                                      | Medium      | Seen on the first request; one-line change                                                                                                       |
| S5  | Tool-calling quality for a no-argument, state-driven tool design is unknown                         | Medium      | Benchmark tool correctness; guards and klyro checks hold regardless                                                                              |
| S6  | 32K context on `-conversations`: a 30-minute call's history plus directives may approach it         | Medium      | Measure prompt tokens per turn in the benchmark; trim history if needed                                                                          |
| S7  | No published rate limits; 429 `insufficient_quota_error` ends calls                                 | Medium      | Ask Sarvam for limits; alert on 429; spend cap with headroom                                                                                     |
| S8  | Single LLM provider, no fallback (by design)                                                        | Accepted    | Sarvam outage = calls get the unavailable message; alert on LLM errors                                                                           |
| S9  | Data processing terms (DPDP) for transcripts sent to Sarvam                                         | Pending     | Confirm with Sarvam; removes the Anthropic processor once cleaned up                                                                             |

## 8. Architecture (target, after acceptance and cleanup)

```
Caller ─PSTN─► Vobiz ─SIP─► LiveKit (SIP trunk + dispatch rule) ─► voice-agent worker (Kubernetes)
                                                                    │  Silero VAD + turn detector
                                                                    │  Sarvam STT  Saaras v3  (wss://api.sarvam.ai)
                                                                    │  deterministic call state + NEXT STEP + reply guard
                                                                    │  Sarvam LLM  sarvam-105b-conversations
                                                                    │      (openai plugin + normaliser, no fallback)
                                                                    │  Sarvam TTS  Bulbul v3
                                                                    ▼  tools: check_availability / book_appointment / get_service_price
                                              klyro (Cloudflare Worker), HMAC-authenticated internal API:
                                              session + entitlement, availability, idempotent booking, prices,
                                              billing, LiveKit webhooks, room sweeper, reconcile cron
                                                                    ▼
                                              Supabase PostgreSQL (bookings, call_logs, wallet) + Google Calendar
```

## 9. Part F: Claude removal plan (separate change, only after acceptance)

Not done now: Claude stays selectable (`LLM_PROVIDER=anthropic`) until Sarvam passes §6 and the staging calls. Then, in one reviewed change:

1. **Voice agent code:** `buildLlm` keeps only the Sarvam branch; remove the `anthropic` import and the `FallbackAdapter`; remove `LLM_PROVIDER` (or make `sarvam` the only value), `ANTHROPIC_API_KEY`, `CLAUDE_MODEL`, `FALLBACK_LLM_*` from `config.ts`; delete their tests (`runtime.spec.ts`, `outbound-dispatch.spec.ts` base configs, the default-provider test in `sarvam-llm.spec.ts`).
2. **Dependencies:** remove `@livekit/agents-plugin-anthropic` from `package.json` and regenerate the lockfile with npm (`@anthropic-ai/sdk` goes with it); rebuild the image and re-run `verify-models`.
3. **Configuration and secrets:** remove the variables from `.env.example`, the Kubernetes Secret and manifest, `STAGING.md`, `STAGING_DEPLOYMENT.md`, `PRODUCTION_READINESS.md`, `docs/voice-staging.md`, `scripts/staging/staging.mjs` and its tests; delete `ANTHROPIC_API_KEY` from every secret manager and revoke the voice key at Anthropic.
4. **klyro (separate decision):** `src/lib/claude.server.ts` and its tests, `CLAUDE_MODEL`, and `resolveGenerateReplyWithTools` in `src/lib/llm-provider.server.ts` serve klyro's own chat/WhatsApp paths, not the LiveKit agent; removing them needs Sarvam tool calling in klyro too and is out of scope for the voice migration.
5. **Verification:** `grep -rn "ANTHROPIC\|CLAUDE_MODEL\|plugin-anthropic\|FALLBACK_LLM"` returns only historical notes; all suites green; no fallback path left.

## 10. Go / no-go

- **Code:** ready for review (provider switch, adapter, tests, benchmark harness).
- **Sarvam as the live LLM:** **NO-GO** until S1 is cleared and the §6 thresholds are met. The migration is **not complete**: the full booking lifecycle has been proven only against a fake Sarvam endpoint and the in-memory/PG backends, not with Sarvam's real model.
- **Next decision for you:** approve a capped Sarvam key and the §6 smoke run (≈ 5 conversations), then the comparison run.
