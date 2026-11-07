# LiveKit SIP voice agent: production and staging readiness (master document)

**Date:** 2026-11-02 (Phase 2.16). **Branch:** `feat/livekit-voice-agent`, HEAD `1b62bc9`; everything from Phase 2.2 onward is **uncommitted** in the feature worktree and has not been reviewed into a commit.

**Status words:** **VERIFIED** = observed in this repository's sandbox (automated tests, local builds, local Worker, real disposable PostgreSQL) · **IMPLEMENTED** = code/config exists and is unit-tested, but has not run against the real external system · **BLOCKED** = cannot proceed without access or an action outside this sandbox · **PENDING** = waiting for an approval, a decision or a scheduled step · **UNKNOWN** = not determinable without information we do not have.

**Verdict:** **not production-ready; not yet deployable to staging.** The repository side is complete for an inbound-only staging test. Every remaining blocker is external (dashboards, credentials, network access, approvals). No real call has been placed; no external integration has been exercised. Companion documents: [STAGING_DEPLOYMENT.md](STAGING_DEPLOYMENT.md) (step-by-step staging package), [STAGING.md](STAGING.md) (background and detail), [RUNBOOK.md](RUNBOOK.md) (operations).

## 1. Completed implementation

| Area                                                                                                                                                                 | Status                                                               |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Agent service (`services/voice-agent`): LiveKit Agents 1.9.5 worker, Sarvam STT/TTS, Claude LLM, multilingual (Telugu/Hindi/English) conversation state, reply guard | IMPLEMENTED                                                          |
| klyro internal API (`/api/internal/voice-agent/*`): HMAC-signed, replay-protected, entitlement gate shared with the existing phone path, tenant from the call row    | IMPLEMENTED                                                          |
| Signed LiveKit webhooks → completion and single billing (dedupe, billing lease)                                                                                      | IMPLEMENTED                                                          |
| Reconcile sweep (15 min): lost end events, billing retries, pruning                                                                                                  | IMPLEMENTED                                                          |
| Provider-failure cleanup in the agent (apology, room deletion with retries, idempotent close)                                                                        | IMPLEMENTED                                                          |
| Per-call agreed maximum duration (min of klyro and agent), recorded on the call row                                                                                  | IMPLEMENTED                                                          |
| Independent room sweep (5 min): stranded callers, orphan `call-` rooms, verify-before-close, never while an agent is connected, never bills stranded time            | IMPLEMENTED                                                          |
| Optimistic concurrency on `call_logs.provider_metadata` across billing, end reports and the sweep                                                                    | IMPLEMENTED; SQL semantics VERIFIED on real PostgreSQL               |
| LiveKit URL allow-listing before any token is minted; least-privilege LiveKit tokens                                                                                 | IMPLEMENTED                                                          |
| Route-specific cron authentication (`VOICE_AGENT_CRON_SECRET`; signed + replay-protected, or route-scoped bearer), per-IP and per-route limits                       | IMPLEMENTED; locally VERIFIED on the built Worker                    |
| Indian number normalization (`+91…`, `91…`, `0…`, 10-digit)                                                                                                          | IMPLEMENTED                                                          |
| SIP provisioning (`provision:sip`): idempotent, `ListUpdate`-correct updates, read-back verification, no accidental outbound                                         | IMPLEMENTED (real SDK client against a model of LiveKit's API)       |
| Container: digest-pinned base, tini PID 1, non-root, drain-safe shutdown, build fails if model assets don't load offline                                             | IMPLEMENTED; image with real models BLOCKED                          |
| Kubernetes manifest (probes, grace period 1920 s, HPA, PDB)                                                                                                          | IMPLEMENTED                                                          |
| Outbound calling (reservation, claim, dial, toll-fraud controls)                                                                                                     | IMPLEMENTED, **disabled** (kill switch unset; migration not applied) |
| Staging tooling: `schedule-cron.sql` (host-pinned, pgcrypto-signed), `check-voice-agent-schema.sql` (read-only)                                                      | IMPLEMENTED; schema check VERIFIED read-only                         |

## 2. Automated test evidence (re-run in Phase 2.16)

All mocked unless marked "real". Commands run from the repository root of the feature worktree.

| Command                                                                                                                                                              | Result                                                                                                                                                                     | Kind                                                                           |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `npm test`                                                                                                                                                           | 4,097 tests: 4,088 pass, 0 fail, 9 skipped (all "no PostgREST binary")                                                                                                     | mocked + the real-PostgreSQL files below                                       |
| `node --test src/lib/voice-agent/voice-agent-api.test.ts`                                                                                                            | 130 / 130                                                                                                                                                                  | mocked (in-memory DB, fake LiveKit)                                            |
| `node --test supabase/migrations/voice_agent_room_sweep.pg.test.ts`                                                                                                  | 8 / 8                                                                                                                                                                      | **real PostgreSQL** (disposable)                                               |
| `node --test supabase/migrations/voice_agent_outbound_reservation.pg.test.ts`                                                                                        | 8 / 8                                                                                                                                                                      | **real PostgreSQL**                                                            |
| `node --test supabase/migrations/voice_agent_rate_limits.pg.test.ts`                                                                                                 | 9 / 9                                                                                                                                                                      | **real PostgreSQL**                                                            |
| `cd services/voice-agent && npm test`                                                                                                                                | 139 / 139 (agent-session 12, conversation-state 14, klyro-client 7, outbound-dispatch 17, runtime 31, shutdown 12, sip-provisioning 23, understanding 18, verify-models 5) | mocked; SDK request/grant parity checked with livekit-server-sdk's own classes |
| `npx tsc --noEmit` (app) / `npx tsc --noEmit -p services/voice-agent`                                                                                                | 0 errors / 0 errors                                                                                                                                                        | static                                                                         |
| `npx eslint .`                                                                                                                                                       | 0 errors, 10 pre-existing warnings                                                                                                                                         | static                                                                         |
| `npx prettier --check` (all changed files)                                                                                                                           | clean                                                                                                                                                                      | static                                                                         |
| `npx vite build` / `CLICKAI_DEPLOY_TARGET=staging npx vite build`                                                                                                    | exit 0 / exit 0; Worker names `klyro` / `clickai-staging`                                                                                                                  | local build (placeholder public values)                                        |
| `npx wrangler deploy --dry-run`                                                                                                                                      | exit 0; 6,029.75 KiB (gzip 1,401.44 KiB)                                                                                                                                   | local                                                                          |
| Mutation checks (Phases 2.9–2.15): 24 deliberate defects (Phase 2.9: 3, 2.11: 10, 2.12: 7, 2.15: 4) in the sweep, billing guards, URL/cron security and provisioning | every one detected by the tests                                                                                                                                            | mocked                                                                         |

## 3. External integration verification

| Integration                                                  | Status                                                                                  |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| Hugging Face (turn-detector model download)                  | **BLOCKED**: egress policy 403 (re-checked 2026-11-02)                                  |
| Cloudflare Workers Builds / API                              | **BLOCKED**: egress policy 403; failed `clickai-staging` builds' logs unread            |
| LiveKit Cloud (rooms, SIP, webhooks, agent dispatch)         | **UNKNOWN**: open-source server/SDK behaviour inferred from source only; no credentials |
| Vobiz (SIP trunk, number routing, signalling IPs)            | **UNKNOWN**: no access                                                                  |
| Sarvam STT/TTS (`saaras:v3`, `bulbul:v3`) incl. Telugu/Hindi | **UNKNOWN**: no live call                                                               |
| Anthropic (Claude)                                           | **UNKNOWN**: no live call                                                               |
| Supabase staging project (schema, Vault, pg_cron, pg_net)    | **PENDING**: read-only schema check prepared; never run against a hosted project        |
| Google Calendar sync on voice bookings                       | **UNKNOWN**: reuses the existing path; not exercised by a call                          |

## 4. Outstanding infrastructure blockers

| #   | Blocker                                                                                                               | Status      | Owner                                                       |
| --- | --------------------------------------------------------------------------------------------------------------------- | ----------- | ----------------------------------------------------------- |
| B1  | Migration automation (Supabase GitHub integration, Branching, Lovable) unanswered: §5                                 | **BLOCKED** | you (dashboards)                                            |
| B2  | Agent image with real model files and offline verification (STAGING_DEPLOYMENT.md §2)                                 | **BLOCKED** | you (build host with Hugging Face access, or allow it here) |
| B3  | Cloudflare `clickai-staging` build: variables, branch control, a green build log (STAGING_DEPLOYMENT.md §3)           | **BLOCKED** | you (dashboard)                                             |
| B4  | LiveKit staging project, keys, `provision:sip` (dry run → `--apply`), webhook (X1–X3)                                 | **PENDING** | you                                                         |
| B5  | Vobiz test number, signalling IP list, previous application id (X4)                                                   | **PENDING** | you                                                         |
| B6  | Sarvam and Anthropic staging keys with spend limits (X5, X6)                                                          | **PENDING** | you                                                         |
| B7  | Secrets: `VOICE_AGENT_HMAC_SECRET`, `VOICE_AGENT_CRON_SECRET`, staging Vault (3 entries), `schedule-cron.sql` (X7–X9) | **PENDING** | you                                                         |
| B8  | Kubernetes namespace, `voice-agent-secrets`, image registry (X10)                                                     | **PENDING** | you                                                         |
| B9  | Cloudflare WAF rules and alerting (X11, X12)                                                                          | **PENDING** | you                                                         |
| B10 | Approval: commit/push the branch (after B1), staging deploy, paid acceptance calls                                    | **PENDING** | you                                                         |

No new critical or high-severity code blocker was found in Phase 2.16 (§14).

## 5. Migration safety

| Item                                                                                                                                                              | Status                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `20261102090000_voice_agent_outbound_reservation.sql` untracked, never executed                                                                                   | VERIFIED (`git status`: `??`; `git ls-files`: 0)          |
| `20261102100000_voice_agent_room_sweep_indexes.sql` untracked, never executed                                                                                     | VERIFIED                                                  |
| Neither is needed for inbound-only staging (outbound-only RPC; indexes not referenced by code)                                                                    | VERIFIED (code search)                                    |
| `20261107090000_voice_agent_transcript_segments.sql` IS needed for inbound: transcripts are stored only through its function (atomic; DEPLOYMENT_CHECKLIST.md §1) | PENDING (apply by hand, with approval, before the Worker) |
| No workflow runs the Supabase CLI; `supabase/config.toml` has only `project_id`                                                                                   | VERIFIED                                                  |
| PR #4 (added a migration, 2026-09-11) had no Supabase Preview check/comment                                                                                       | VERIFIED                                                  |
| Supabase "Deploy to production" (S1–S4), Branching (S5), applied versions (S6)                                                                                    | **UNKNOWN** (dashboard)                                   |
| Lovable GitHub sync and migration behaviour (L1–L3)                                                                                                               | **UNKNOWN** (dashboard / Lovable support)                 |
| Schema compatibility for inbound (`scripts/staging/check-voice-agent-schema.sql`, read-only)                                                                      | PENDING (run it in the staging SQL editor, D0)            |

Rule: until S3/S5/L3 are confirmed safe, both files stay out of every commit (checklist: STAGING_DEPLOYMENT.md §1).

## 6. Security checklist

| Control                                                                                                                                   | Status                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Internal API: HMAC-SHA256, ±60 s, single-use nonce, body limit, schema validation, key rotation                                           | IMPLEMENTED (tested)                                    |
| Pre-auth limiter counts only failed authentications; shared per-scope limits in Postgres (fail closed)                                    | IMPLEMENTED (tested; SQL VERIFIED real PG)              |
| LiveKit webhooks: JWT signature, body hash, `exp`, dedupe                                                                                 | IMPLEMENTED (tested)                                    |
| End reports bound to room and `sip.callID` (409 on mismatch)                                                                              | IMPLEMENTED (tested)                                    |
| Tenant isolation: organization from the call row; tool registry default-deny; tenant-looking inputs stripped                              | IMPLEMENTED (tested)                                    |
| LiveKit URL: TLS + `*.livekit.cloud` (or allow-list) before any token; agent config same rule outside development                         | IMPLEMENTED (tested; no request for rejected URLs)      |
| LiveKit tokens: DeleteRoom `{roomCreate}` 30 s (no narrower grant exists), ListRooms `{roomList}` 30 s, room-scoped `roomAdmin` otherwise | IMPLEMENTED (grants checked against livekit-server-sdk) |
| Voice cron routes: own secret, signed + replay-protected or route-scoped bearer, 10 failed auths/IP/min, 6 runs/route/min, generic errors | IMPLEMENTED; VERIFIED on the locally built Worker       |
| Shared `LOVABLE_CRON_SECRET` no longer opens voice cron routes once `VOICE_AGENT_CRON_SECRET` is set                                      | IMPLEMENTED (tested); PENDING the secret being set      |
| Secrets never in logs/responses; bundle contains no secret literals                                                                       | VERIFIED (tests + bundle scan)                          |
| Container: non-root, tini, digest-pinned base, SHA-256-pinned tini                                                                        | IMPLEMENTED                                             |
| SIP inbound allow-list required outside development (`0.0.0.0/0` and empty refused)                                                       | IMPLEMENTED (tested)                                    |
| Toll-fraud controls for outbound (owner/admin, prefixes, atomic caps)                                                                     | IMPLEMENTED; outbound disabled                          |
| Cloudflare WAF rate limits                                                                                                                | PENDING (B9)                                            |
| Agent egress NetworkPolicy; secrets from a secret manager; image vulnerability scan / SBOM                                                | PENDING (recommended, not staging blockers)             |

## 7. Billing validation

| Property                                                                                                                  | Status                                                         |
| ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Billing only from the signed LiveKit end event (or klyro's own timestamps when it is lost and the agent reported the end) | IMPLEMENTED (tested)                                           |
| Exactly once per call: conditional completion + billing lease CAS + idempotent `debit_wallet_for_call`                    | IMPLEMENTED (tested, incl. concurrent and both race orderings) |
| Stranded time after an agent failure is never billed (sweep records its decision; the webhook applies it)                 | IMPLEMENTED (tested)                                           |
| Calls with no trustworthy duration (agent died, no end event) are closed unbilled                                         | IMPLEMENTED (tested); product policy PENDING confirmation      |
| Outbound ringing time excluded                                                                                            | IMPLEMENTED (tested); outbound disabled                        |
| Real wallet debits match `duration_seconds` and pricing rules                                                             | PENDING (staging A15, paid calls)                              |
| Per-minute cost of a call (LiveKit, Sarvam, Claude, Vobiz, compute)                                                       | UNKNOWN (pricing and usage unavailable)                        |

## 8. Monitoring and alerting

| Item                                                                                                                                                                                                                                             | Status                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| Structured logs: agent telemetry (no transcripts), `sip_reconcile:tick`, `sip_room_sweep:tick`/`tick_failed` with counters, `voice_agent:*` events                                                                                               | IMPLEMENTED                                                                   |
| Health: agent `GET :8081/` (200 only when connected to LiveKit and the inference process runs; 503 otherwise), `/worker` (`agent_name`, `active_jobs`)                                                                                           | VERIFIED (LiveKit Agents 1.9.5 source)                                        |
| Alert rules (RUNBOOK.md step 8): missing ticks, `tick_failed`, `room_sweep_failed/agent_stuck/mismatch/invalid_room/expired/db_error/unconfigured`, `orphan_room_mismatch`, `call.cleanup_failed`, `cron_auth_failed` spikes, `cron_legacy_auth` | PENDING (no alerting exists in the repository; configure in the log platform) |
| Kubernetes: restarts, readiness failures                                                                                                                                                                                                         | PENDING                                                                       |
| Dashboards (call volume, latency, failures, debits)                                                                                                                                                                                              | PENDING                                                                       |

## 9. Performance and load testing

| Item                                                                                                                                        | Status                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| In-process latency (understanding 0.04 ms median; AgentSession turn overhead 4.4 ms; signed klyro tool call 2.1 ms)                         | VERIFIED (`bench/latency.ts`, appendix)          |
| STT, LLM first token, TTS first audio, end-of-turn, SIP/network latency                                                                     | UNKNOWN (no live call)                           |
| Concurrent calls per pod (`MAX_CONCURRENT_SESSIONS` 8 is an estimate), HPA thresholds                                                       | UNKNOWN (no load test)                           |
| Room sweep within budget (≤ 18 s, ≤ 45 subrequests per run)                                                                                 | IMPLEMENTED (tested with simulated time/budgets) |
| Proposed acceptance thresholds: first agent audio p50 ≤ 1.2 s / p95 ≤ 2.0 s; barge-in ≤ 300 ms; dropped calls ≤ 1 %; booking success ≥ 95 % | PENDING (confirm, then measure in staging)       |
| Load test plan (synthetic SIP callers against staging)                                                                                      | PENDING (needs paid minutes and approval)        |

## 10. Privacy and compliance

| Item                                                                                                                        | Status                                                                                       |
| --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Transcripts never logged; phone numbers masked in logs; telemetry redacts sensitive keys                                    | IMPLEMENTED (tested)                                                                         |
| klyro stores outcome codes and a short summary, never the transcript                                                        | IMPLEMENTED                                                                                  |
| No call recording (no egress configured)                                                                                    | VERIFIED (code search)                                                                       |
| Data processors: audio to Sarvam; transcribed text and business context to Anthropic; media through LiveKit; PSTN via Vobiz | PENDING: confirm data-processing terms and cross-border transfer under India's DPDP Act 2023 |
| Disclosure that the caller is speaking with an AI assistant (greetings come from business configuration)                    | PENDING: product/legal decision                                                              |
| Retention of `call_logs` (caller number, summary) and logs                                                                  | PENDING: retention policy                                                                    |
| Outbound (TRAI/DLT, consent, calling hours)                                                                                 | Not applicable while outbound is disabled; PENDING before enabling                           |

## 11. Staging deployment procedure

Full detail with health checks: STAGING_DEPLOYMENT.md §6. Prerequisites: B1–B3 resolved, B4–B8 done.

| Step | Action                                                                                         | Must pass before continuing                                                                                                             |
| ---- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| D0   | Run `scripts/staging/check-voice-agent-schema.sql` (read-only) in the staging SQL editor       | every required row `ok = true`; record the latest migration versions                                                                    |
| D1   | Agent: apply the rendered manifest (`APP_ENV: staging`, verified image tag)                    | pods Ready; `GET :8081/` 200; `/worker` shows `clickai-receptionist`, `active_jobs: 0`                                                  |
| D2   | klyro: Workers Builds deploys the branch to `clickai-staging` with all secrets                 | unsigned internal and cron requests → 401; runtime `SUPABASE_URL` host = staging `VITE_SUPABASE_URL` host                               |
| D3   | Cron: `schedule-cron.sql` (staging)                                                            | one `sip_room_sweep:tick` (5 min) and `sip_reconcile:tick` (15 min); no `cron_legacy_auth`; then `VOICE_AGENT_CRON_REQUIRE_SIGNED=true` |
| D4   | LiveKit: `npm run provision:sip` (dry run) → `-- --apply` (verified by read-back); webhook URL | plan shows only the staging number and Vobiz IPs; apply exits 0                                                                         |
| D5   | WAF rules and alerts                                                                           | a test alert delivered                                                                                                                  |
| D6   | Vobiz **[approval]**: point the staging test number at LiveKit                                 | acceptance test A1                                                                                                                      |

Environment variables (names only; full list: STAGING_DEPLOYMENT.md §5):

- **Worker build-time:** `CLICKAI_DEPLOY_TARGET`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`.
- **Worker secrets:** `SUPABASE_SERVICE_ROLE_KEY`, `VOICE_AGENT_HMAC_SECRET`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `VOICE_AGENT_CRON_SECRET`, `LOVABLE_CRON_SECRET` (rotation: `*_PREVIOUS`).
- **Worker variables:** `SUPABASE_URL`, `LIVEKIT_URL`, `VOICE_AGENT_NAME`; optional `VOICE_AGENT_MAX_CALL_SECONDS`, `VOICE_AGENT_CRON_REQUIRE_SIGNED`, `LIVEKIT_ALLOWED_HOSTS`; leave unset `VOICE_AGENT_OUTBOUND_ENABLED` and the other `VOICE_AGENT_OUTBOUND_*`.
- **Agent:** `APP_ENV`, `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `SARVAM_API_KEY`, `ANTHROPIC_API_KEY`, `KLYRO_BASE_URL`, `VOICE_AGENT_HMAC_SECRET`; optional tuning variables; leave unset `SIP_OUTBOUND_TRUNK_ID`.
- **Provisioning laptop:** `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `APP_ENV`, `AGENT_NAME`, `SIP_INBOUND_NUMBERS`, `VOBIZ_SIP_SIGNALING_IPS` (never `--with-outbound`).
- **Staging Vault:** `clickai_staging_base_url`, `clickai_staging_cron_secret`, `clickai_staging_voice_cron_secret`.

External dashboard actions required (all PENDING, owner: you): S1–S6 and L1–L3 (migration automation), Cloudflare build variables / branch control / secrets / WAF, LiveKit staging project + keys + webhook, Vobiz test number + IP list + previous application id, Sarvam and Anthropic keys with spend limits, staging Vault + cron, Kubernetes namespace + Secret + registry, alert rules, cost caps on all four providers.

## 12. Production launch gates

All must be met; none is met today.

1. Staging acceptance matrix (§15) passed, signed off, including paid tests A1–A19 and 24 h of staging traffic without `room_sweep_mismatch/invalid_room/expired`, `tick_failed` or double debits.
2. Migration automation answered (B1) and any needed migration applied by hand with approval; branch reviewed, committed and merged.
3. LiveKit Cloud behaviour confirmed (T7, A11, A13): participant kinds, 404 on missing rooms, ListRooms fields, SIP hang-up on room deletion.
4. Latency and quality thresholds (§9) agreed and met in staging for Telugu, Hindi and English.
5. Billing accuracy confirmed against real debits (A15); abandoned-call policy confirmed.
6. Production secrets distinct from staging; `VOICE_AGENT_CRON_SECRET` set and `VOICE_AGENT_CRON_REQUIRE_SIGNED=true`; production scheduler (both voice cron routes, ≥ 25 s timeout); WAF; alerts delivered.
7. Privacy/compliance decisions (§10) made and implemented where required.
8. Load test at the planned peak concurrency with headroom; HPA/limits tuned.
9. Rollback rehearsed in staging (§13).
10. Production numbers migrated one at a time (RUNBOOK.md "Migrating a number"); outbound stays disabled until separately approved.

## 13. Rollback procedure

Independent steps, fastest first (detail: STAGING_DEPLOYMENT.md §6, RUNBOOK.md):

1. **Number:** re-link the number to its previous Vobiz Voice Application (instant; the old path was never removed). Then remove it from `SIP_INBOUND_NUMBERS` and `provision:sip -- --apply` (verified); removing the last number: delete the trunk and rule in the LiveKit dashboard.
2. **Agent:** `kubectl -n <ns> scale deploy/voice-agent --replicas=0` (active calls drain, ≤ 31 min) or `kubectl rollout undo`.
3. **klyro:** redeploy the previous Worker build from the Cloudflare dashboard; the voice routes are inert without SIP traffic.
4. **Cron:** `select cron.unschedule('clickai-staging-sweep-sip-rooms'); select cron.unschedule('clickai-staging-reconcile-sip-calls');` (production: remove both from the scheduler; this re-opens the stranded-caller risk).
5. **Database:** transcript migration, if applied: first redeploy a Worker that does not call it, then `DROP FUNCTION IF EXISTS public.store_voice_agent_transcript_segment(uuid, text, text, jsonb, boolean, text); DROP TABLE IF EXISTS public.call_transcript_segments;` (call_logs.transcript keeps what was written). Index migration, if applied: `DROP INDEX IF EXISTS public.idx_call_logs_livekit_inbound_answered; DROP INDEX IF EXISTS public.idx_call_logs_livekit_room;`. Outbound migration, if applied: `DROP FUNCTION public.reserve_voice_agent_outbound_call(...)` (outbound then fails closed).

## 14. Phase 2.16 review: new blockers

- **Critical / high:** none found. Re-verified: Phase 2.12 security fixes wired in (both voice cron routes use `authenticateVoiceCron`; `livekitApiBase` runs before every LiveKit token and in the sweep; DeleteRoom grant `{roomCreate}` only); Phase 2.15 provisioning (`ListUpdate` for trunk and rule updates, read-back `verifyState`, 23 tests); both migrations untracked; all suites green.
- **Medium (process, not code):** the Phase 2.2–2.15 work is a large uncommitted change set (≈ 46 paths) on top of `1b62bc9`: it needs a review and a single deliberate commit after B1, before any staging build can use it.
- **Low:** `wrangler.json` declares only `SUPABASE_SERVICE_ROLE_KEY` as required (voice secrets fail closed at runtime instead); no root `.dockerignore` (BuildKit sends only the copied files); no alerting in the repository.

## 15. Staging acceptance test matrix

Cost: **Free** = no external service (once staging is deployed) · **Ext** = external service/API, no phone call · **Paid** = a real call (approval, one at a time). All tests: **PENDING**.

| ID  | Area                 | Test                                                                         | Expected                                                                                 | Cost     |
| --- | -------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------- |
| T1  | Authorization        | Unsigned / wrong-secret / replayed internal request                          | 401; replay 401; no row                                                                  | Free     |
| T2  | Authorization        | Voice cron routes: unsigned, shared bearer, forged, stale                    | 401 `{"error":"unauthorized"}`                                                           | Free     |
| T3  | Cron replay / limits | Same signed request twice; 8 runs/min; 11 bad attempts/IP                    | replay 401; runs 7–8 → 429; 11th → 429                                                   | Free     |
| T4  | Webhook auth         | Unsigned / tampered webhook; replay a captured one                           | 401; replay `duplicate: true`, no second debit                                           | Ext      |
| T5  | Schema               | `check-voice-agent-schema.sql`                                               | all required rows ok                                                                     | Ext      |
| T6  | Image                | Offline `verify-models` and offline worker start                             | `verify-models: ok`; no model errors                                                     | Ext      |
| T7  | LiveKit Cloud API    | ListParticipants kinds, DeleteRoom on missing room, ListRooms `creationTime` | as assumed (STAGING.md §6c)                                                              | Ext      |
| T8  | Provisioning         | `provision:sip` dry run, `--apply`, second `--apply`                         | plan as expected; apply verified; second run changes nothing                             | Ext      |
| A1  | Inbound English      | Call, ask hours, hang up                                                     | one row `completed`, duration ≈ call, one debit, `max_call_seconds` recorded             | Paid     |
| A2  | Inbound Hindi        | Hindi only                                                                   | Hindi replies; `language` hi-IN                                                          | Paid     |
| A3  | Inbound Telugu       | Telugu and Romanized Telugu                                                  | Telugu replies; `language` te-IN                                                         | Paid     |
| A4  | Language switch      | English → Hindi                                                              | agent follows                                                                            | Paid     |
| A5  | Interruptions        | Interrupt twice                                                              | agent stops and listens                                                                  | Paid     |
| A6  | Silence              | Stay silent                                                                  | prompt, polite hang-up, billed once                                                      | Paid     |
| A7  | Booking              | Book a test appointment                                                      | booking row; correct service/time                                                        | Paid     |
| A8  | Google Calendar      | A7 with Calendar connected                                                   | event created; failure → "saved" + retry                                                 | Paid+Ext |
| A9  | Caller hang-up       | Hang up mid-sentence                                                         | completed, billed once with LiveKit's duration                                           | Paid     |
| A10 | Duplicate webhooks   | Re-POST A1's `participant_left`                                              | `duplicate: true`; no second debit                                                       | Ext      |
| A11 | Agent crash          | `VOICE_AGENT_MAX_CALL_SECONDS=300`; force-delete the agent pod mid-call      | caller disconnected by ~10–15 min; `failed/max_duration_exceeded`; no debit              | Paid     |
| A12 | Restart / drain      | `kubectl rollout restart` during a call                                      | call finishes; new pod takes the next call                                               | Paid     |
| A13 | Room cleanup failure | Test pod with a revoked LiveKit key; end a call                              | `call.cleanup_failed`; sweep disconnects within ~10 min; billed once with agent duration | Paid     |
| A14 | Orphan room          | Unknown/unentitled number with the agent's room deletion disabled            | room deleted after 10–15 min; no billing                                                 | Paid     |
| A15 | Billing accuracy     | Compare debits of A1, A6, A9, A11, A13 with durations and pricing            | exactly one debit per billed call; none for A11/A14                                      | Ext      |
| A16 | Entitlement refusal  | Empty wallet / blocked plan                                                  | denial; `failed/not_entitled`; no debit                                                  | Paid     |
| A17 | LiveKit outage       | Wrong `LIVEKIT_URL` host on the Worker for 35 min                            | sweep 503 `livekit_url_rejected`; recovery after restore                                 | Ext      |
| A18 | Database outage      | Rotate the staging service-role key briefly                                  | 5xx; `tick_failed`; agent rejects politely; recovery                                     | Ext      |
| A19 | klyro outage         | Wrong `KLYRO_BASE_URL` on a test pod; call                                   | unavailable message; no row; orphan sweep removes the room                               | Paid     |
| A20 | Outbound stays off   | `startAgentOutboundCall` as owner                                            | "not enabled"; no row, no dispatch                                                       | Ext      |

## 16. Phase 2.18: Sarvam LLM migration

Detail: [SARVAM_LLM_MIGRATION.md](SARVAM_LLM_MIGRATION.md).

- **IMPLEMENTED:** `LLM_PROVIDER=sarvam` builds the Sarvam LLM only (`sarvam-105b-conversations` via LiveKit's OpenAI plugin plus an SSE normaliser; no Anthropic, no fallback, `FALLBACK_LLM_BASE_URL` refused). Default stays `anthropic` until acceptance.
- **Tests:** 44 new adapter tests including the full booking lifecycle through AgentSession against a fake Sarvam endpoint (voice-agent 183/183); booking-path PostgreSQL suites re-run 179/179.
- **UNKNOWN:** every Sarvam LLM behaviour against the real API (no key, host blocked, no approval). **BLOCKED:** benchmark (`bench/llm-compare.ts`, refuses to run without `LLM_BENCH_APPROVED=yes`).
- **Go/no-go:** NO-GO for Sarvam on staging calls until the paid smoke and comparison runs meet the thresholds in SARVAM_LLM_MIGRATION.md §6. Claude is removed only afterwards (§9 there).

---

# Appendix A: earlier report (2026-11-01) and phase notes

Historical record, kept for traceability. **Where it conflicts with §§1–16 above, the sections above are current.** Superseded statements include: "No rate limiting in app code" (pre-auth and shared limits were added in Phase 2.2, cron limits in Phase 2.12); "Replay records … only `voice_agent_request`" (cron replay records `voice_agent_cron` are pruned too); the original "Remaining blockers" list (replaced by §4); `provision:sip` behaviour before Phase 2.15.

## Original report header

Date: 2026-11-01. Branch `feat/livekit-voice-agent` (local only, not committed or pushed), on `origin/main` 935f3b3.
**Verdict: NOT production-ready.** The code, tests and deployment configuration are done and verified here. No real call has been made: there is no network access to LiveKit, Sarvam, Vobiz or Hugging Face, and no credentials or approvals. Production readiness has not been demonstrated.

### 1. Architecture implemented

```
Caller ─PSTN─ Vobiz ─SIP (inbound trunk, Primary URI = LiveKit SIP host)─▶ LiveKit SIP + media
   ▲                                                                         │ dispatch rule → room "call-*",
   └──────────── outbound: LiveKit outbound trunk ◀── createSipParticipant ──┤ explicit agent dispatch
                                                                             ▼
                         services/voice-agent (Node 22, long-running, k8s) — one job per call
                           Sarvam STT saaras:v3 (auto language, codemix) → conversation/ (deterministic
                           understanding + provenance state + one next step) → Claude (LiveKit Anthropic
                           plugin; optional OpenAI-compatible fallback via FallbackAdapter) → reply guard →
                           Sarvam TTS bulbul:v3
                                    │ HMAC-signed HTTPS (session start / tool / session end)
                                    ▼
                         klyro Worker: /api/internal/voice-agent/*  ── reuses, unchanged:
                           resolveActivePhoneNumberByDestination + checkTelephonyAccess (same entitlement gate
                           as the answer URL), loadSnapshot/buildAgentInstructions, resolveAvailableTools +
                           executeAiTool (tenant from the call row), booking RPCs + Google Calendar mirror
                                    ▲
                         LiveKit webhooks (signed JWT) → /api/public/webhooks/livekit → completes the call
                           and runs finalizeCallBilling once (deduplicated)
```

Business logic stays in klyro. The agent only knows what klyro returns for the call: services, prices, instructions, and tool results.

### 2. Files

**Changed (1):**

- `src/routeTree.gen.ts`: regenerated by the build to include the new routes.

**Added in klyro (11):**

- `src/lib/voice-agent/internal-auth.ts`
- `src/lib/voice-agent/livekit-webhook.ts`
- `src/lib/voice-agent/sessions.server.ts`
- `src/lib/voice-agent/http.server.ts`
- `src/lib/voice-agent/voice-agent-api.test.ts`
- `src/routes/api/internal/voice-agent/{session,tool,session-end}.ts` (the HMAC `outbound` route was removed in staging preparation; see §3a)
- `src/routes/api/public/webhooks/livekit.ts`
- `src/routes/api/public/cron/reconcile-sip-calls.ts`

**Added in `services/voice-agent/` (28):**

- `src/{worker.ts, agent/{call,receptionist}.ts, backend/{types,in-memory,klyro-client,klyro-backend}.ts, conversation/{understanding,state,guard}.ts, runtime/{config,telemetry}.ts}`
- `tests/{understanding,conversation-state,agent-session,klyro-client,runtime}.spec.ts`
- `bench/latency.ts`
- `deploy/{k8s/voice-agent.yaml, livekit/provision-sip.ts, docker-compose.dev.yml}`
- `Dockerfile`, `.dockerignore`, `.env.example`, `package.json`, `package-lock.json`, `tsconfig.json`
- `RUNBOOK.md`, this report

**Added CI:**

- `.github/workflows/voice-agent.yml`

**Not touched:** no database migrations, the Vobiz answer-URL/media-stream path, WhatsApp, and existing secrets.

### 3. Verification run in this session

| Check                                                    | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Baseline before changes (origin/main 935f3b3)            | tests 3,942: 3,933 pass, 0 fail, 9 skip; tsc ok; eslint 0 errors / 10 warnings; build ok                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Repo after changes                                       | tests **3,962: 3,953 pass, 0 fail**, 9 skip (same skips); tsc ok; eslint **0 errors** / same 10 warnings; `vite build` ok                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| New klyro tests (`voice-agent-api.test.ts`)              | **20/20**: failed webhook processing releases its claim so LiveKit's retry bills once; outbound endpoint off by default; replay records pruned (other providers untouched); signing (tamper/stale/replay/wrong key/unconfigured); LiveKit webhook (forged/issuer/expired/body swap); entitlement gate kept on SIP; unknown number; retried session start (1 row); outbound only via klyro-authorised row; tenant ids from call row, model-supplied ids stripped; tools outside capabilities refused; ended/unknown call refused; unsigned + replayed HTTP rejected; billing once despite duplicate webhook; forged webhook never bills; agent end report never bills; stale-call sweep closes without billing, idempotent                                                                                                       |
| Service typecheck (strict)                               | ok                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Service tests                                            | **64/64**: 18 understanding; 14 conversation state (incl. Smile Dental replay); 12 real LiveKit `AgentSession` (Smile Dental books end to end, bad-model containment ×4, availability failure + retry, idempotent booking retry + repeat refusal, two callers one slot, calendar sync failure → "saved, team will confirm" never "confirmed", backend timeout, concurrent calls isolated, real `interrupt()`); 7 klyro client (signature accepted by klyro's own verifier, retry with fresh nonce, no 4xx retry, deadline, outcome mapping incl. SLOT_NO_LONGER_AVAILABLE and saved_calendar_sync_failed); 13 runtime (config refusals, no secret echo, log redaction, denial/backend-unreachable rejection, silence check-in then goodbye, max duration, SIP disconnect, timezone-aware dates, weekdays ×3 languages, intents) |
| Worker process (real, `start` mode, LiveKit unreachable) | health `/` → **503 "not connected to livekit"**; `/worker` → agent name + active jobs; connection retry logged; **SIGTERM → exit 143 in 1.7 s**; without model files the default turn detector **fails fast** with LiveKit's "run download-files" error                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Docker image build                                       | **blocked**: Docker Hub 429 (rate limit) pulling the base image                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

#### 3a. Staging preparation (uncommitted at the time of writing; see STAGING.md)

| Check                   | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Repo                    | tests **3,977: 3,968 pass, 0 fail**, 9 skip; tsc ok; eslint 0 errors / same 10 warnings; `vite build` ok (default `klyro` and `CLICKAI_DEPLOY_TARGET=staging` → `clickai-staging`)                                                                                                                                                                                                                                                                                                                                                                                                                           |
| klyro voice-agent tests | **35/35** (+15): pre-auth per-IP 429 before any signature work or DB write; per-call tool limit (other calls unaffected, limited call never executed); per-number session-start limit (no row); limiter failure fails closed; webhook 429 before the claim, then billed exactly once; outbound: owner/admin only, other tenant indistinguishable from missing number, flag only a kill switch, refusals before any row/dispatch, dispatch failure → failed row, dial failure → failed row (never billed); HMAC outbound route gone; rate-limit pruning scoped to voice-agent keys; staging cron every 15 min |
| Service tests           | **73/73** (+9): klyro's dispatch token accepted by `livekit-server-sdk` `TokenVerifier` (wrong key/secret/expired rejected); CreateDispatch request shape; metadata parsing (trunk in metadata ignored); dial through the configured trunk with the organization's caller ID; failed dial / missing trunk reported to klyro                                                                                                                                                                                                                                                                                  |
| Docker image            | built from the digest-pinned base via `mirror.gcr.io` (digest identical to Docker Hub's), with the model-download step skipped (huggingface.co unreachable); runs as `node`; health 503 without LiveKit; SIGTERM after start-up exits 143 in 2–4 s; SIGTERM in the first ~5–12 s could hang until SIGKILL: fixed in §3b (H3)                                                                                                                                                                                                                                                                                 |

#### 3b. Phase 2.2 remediation of the Phase 2.1 review (uncommitted)

| Finding                                      | Status                               | Remediation (where)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H1 ambiguous dispatch / dial before re-check | fixed                                | Outbound claim-and-dial: the agent claims the row from klyro (`claimOutboundCall`, signed `/api/internal/voice-agent/outbound-claim`) before dialling; the claim is one conditional UPDATE `initiated → ringing` (one job, within 5 min) and returns the destination and caller ID from the row. Dispatch outcomes: dispatched / rejected (4xx → row failed) / unknown (row stays initiated, reported `pending`, safe to retry).                                                                                                                                                    |
| H2 outbound row not single-use               | fixed                                | `startSipSession` outbound: one conditional UPDATE `ringing → answered` with `provider_call_id IS NULL`, room must be `out-<callId>`; the same SIP call retrying is idempotent, any other is refused (`already_started`).                                                                                                                                                                                                                                                                                                                                                           |
| H3 container SIGTERM hang                    | fixed                                | Three causes (each reproduced): Node as PID 1 ignoring an early SIGTERM → tini (pinned by SHA-256) as entrypoint; @livekit/agents 1.9.5 `close()` before `run()` deadlock, and process-pool warm-up race (`SupervisedProc.close()` no-op before start, then started anyway) → bounded watchdog `src/runtime/shutdown.ts` (exits when the framework's `/worker` reports 0 active jobs for 2 polls after a 5 s grace; waits while calls are active; hard cap drain + 30 s < 960 s grace). Container SIGTERM at 0.3–30 s after start: all exit 143 in ≤ 5.3 s (before: hung at ≤ 6 s). |
| H4 pre-auth limiter DoS                      | fixed                                | Counts only FAILED authentications per source (IPv4 /32, IPv6 /64); valid signed traffic is never counted or refused; bounded table evicts the oldest instead of refusing unseen sources. Cloudflare WAF documented as the required volumetric layer.                                                                                                                                                                                                                                                                                                                               |
| M1 webhook retry / billing recovery          | fixed (to the extent testable)       | Signed webhooks are never rate-limited; completion is one conditional transition + a billing lease (CAS); failed billing marked `retry`; the sweep bills once from klyro's own timestamps when the signed end event is missing but the agent reported the end. LiveKit's actual retry policy remains unverified.                                                                                                                                                                                                                                                                    |
| M2 outbound idempotency                      | fixed                                | Required `idempotencyKey`; the call row id is derived from (org, user, key), so the primary key deduplicates concurrent requests (no migration).                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| M3 dispatch metadata trust                   | fixed                                | Metadata carries only the row id; destination, caller ID from the claim; trunk from agent config.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| M4 toll fraud                                | fixed                                | India-only by default, regular subscriber numbers only (no 1800/1860/1900), explicit blocks, no self-calls, ≤ 3 active and ≤ 100/24 h per org (configurable).                                                                                                                                                                                                                                                                                                                                                                                                                       |
| M6 failed-dial room cleanup                  | fixed                                | The agent deletes the room after a failed dial on a call it owns (never after a refused claim).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| M7 ringing billed                            | mitigated (not confirmed on LiveKit) | Outbound duration capped at `event time − answered_at` (klyro sets answered_at at session start, after the answer).                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| M8 model cache                               | partially verified                   | Build-time `verify-models.mjs` (plugin's own offline loaders, as `node`) fails the build if files are misplaced; verified to fail without files and to find the ONNX file under the node user's home; positive path needs huggingface.co.                                                                                                                                                                                                                                                                                                                                           |
| L1 LIKE cleanup                              | fixed + verified on real PostgreSQL  | Pattern without escapes (`voice_agent_%`), proven not to match other key formats.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| L3 error classes                             | fixed                                | not_available / not_entitled / conflict / internal_error / dispatch_rejected / limit_reached / destination_not_allowed.                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| L5 cron guard                                | fixed + verified on real PostgreSQL  | The helper re-validates the exact `clickai-staging.<sub>.workers.dev` host and a fixed route list on every run.                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| L6 reconcile counts / subrequests            | fixed                                | Bulk conditional updates returning rows (counts = rows changed); ≤ 4 billing operations per run, the rest deferred.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

#### 3c. Phase 2.3 remediation of the independent review (uncommitted)

| Finding                                          | Status                   | Remediation                                                                                                                                                                                                |
| ------------------------------------------------ | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1 watchdog could exit with calls active         | fixed                    | Count read in-process from the AgentServer (prototype `run` capture, synchronous `activeJobs` getter); no HTTP self-probe; an unavailable count after it was once known is "active".                       |
| F2 IP failure budget could block healthy senders | fixed                    | Signatures verified first; valid requests never refused by the budget; clock-skew failures (`stale`, `expired`, `not_yet_valid`) not counted.                                                              |
| F3 model verification incomplete                 | fixed (synthetic assets) | Checks ONNX, `languages.json` and the tokenizer offline. Found and fixed a real offline failure: transformers 4.2.0 needs `tokenizer_config.json` under the "main" key (`deploy/prepare-model-cache.mjs`). |
| F4 caps not atomic                               | fixed (real PostgreSQL)  | `reserve_voice_agent_outbound_call` (migration 20261102090000, NOT executed): check-and-insert under a per-org advisory lock; idempotent; slots released by status.                                        |
| F5 drain < max call                              | fixed                    | Start-up check `DRAIN_TIMEOUT_MS ≥ MAX_CALL_SECONDS + 60 s`; default drain 31 min; k8s grace 1920 s (checked by a test).                                                                                   |
| F6 lease completion                              | fixed                    | "done" written only while still holding the lease; a stale holder cannot clobber the new holder.                                                                                                           |
| F7 ringing ownership                             | fixed                    | Closing a ringing call requires the claiming job's id.                                                                                                                                                     |
| F8 expiry UX                                     | fixed                    | Replays after the claim window report `expired`.                                                                                                                                                           |

#### 3d. Phase 2.5 staging blockers (uncommitted)

| Finding                                 | Status                                           | Remediation                                                                                                                                         |
| --------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| H-A migration automation                | not conclusively known (dashboard-only settings) | Migration kept untracked; pre-push checklist in STAGING.md §0a.                                                                                     |
| H-B caller stranded on provider failure | fixed                                            | Apology (bounded, skipped on TTS failure) + room deletion with fallback and retries; idempotent; caller hang-up and our own hang-up are not errors. |
| M-A number formats                      | fixed                                            | `src/lib/voice-agent/phone.ts`: four Indian forms normalized; foreign E.164 kept; nothing guessed.                                                  |

#### 3e. Phase 2.6 real Docker model validation (uncommitted)

**Blocked, not passed.** The real build fails at `npx livekit-agents download-files` because the sandbox egress policy denies huggingface.co and its CDNs (403 on CONNECT). No image with real model files exists; offline turn-detector initialization in a container is unverified. Exact evidence and the commands to run on a build host with access: STAGING.md §4. Staging audit additions: owner checklist for migration automation (STAGING.md §0a), the k8s manifest's `APP_ENV: production` overriding the Secret (§5 step 4), and the alert list for failed room cleanup (§6a).

#### 3f. Phase 2.7 staging blockers (uncommitted, documentation only)

Hugging Face still blocked (403 on CONNECT), so the Docker validation remains blocked. Cloudflare staging: two failure modes proven locally (missing `VITE_SUPABASE_*` build variables → build exits 1; missing `CLICKAI_DEPLOY_TARGET=staging` → the build targets the Worker `klyro`); which one the staging builds hit needs the Cloudflare build log (STAGING.md §1). `APP_ENV`: staging-only render at apply time (§5 step 4). Reconcile smoke test expectation corrected (§8). Cleanup alerting gap and the missing automatic backstop after `call.cleanup_failed` documented (§6a).

#### 3g. Phase 2.8 (uncommitted, documentation only)

Cloudflare staging build: not verifiable from this environment (Cloudflare API, dashboard and docs answer 403; no credentials; the branch head is still `1b62bc9`, so no newer push-triggered build exists). Local comparison repeated: default → `klyro`, `CLICKAI_DEPLOY_TARGET=staging` → `clickai-staging`, dry-run ok for both; missing `VITE_SUPABASE_*` → build exit 1. Failed-room-cleanup audit and an independent call-duration cap proposed, not implemented (STAGING.md §6b): inbound has no limit independent of the agent; outbound already has LiveKit's `maxCallDuration`.

#### 3h. Phase 2.9 independent inbound call termination (uncommitted)

- **Implemented: klyro room sweep** (`src/lib/voice-agent/room-sweep.server.ts`, cron route `sweep-sip-rooms`, every 5 min): deletes the LiveKit room of inbound calls the agent could not end (crashed, partitioned, cleanup failed), with the row closed first so stranded time is never billed; compare-and-swap on every write, per-row lease, room bound to the call (`sip.callID`), bounded retries, alerts and manual recovery in STAGING.md §6c. klyro now returns its maximum call duration at session start; the agent uses the smaller limit.
- **LiveKit room API** (`livekit-api.ts`): `ListParticipants` (roomAdmin, room-scoped) and `DeleteRoom` (roomCreate), request shapes and grants checked against `livekit-server-sdk`'s `RoomServiceClient`; not_found semantics from LiveKit's open-source server source.
- **Not implemented: inbound-trunk `max_call_duration`** (enforced by open-source LiveKit SIP per source; LiveKit Cloud enforcement, the server's clamp value and the safety of `replace` with the SDK's older protocol are unresolved; STAGING.md §6b).
- No migration: the sweep's state lives in `call_logs.provider_metadata`.

#### 3i. Phase 2.11 remediation of the Phase 2.10 review (uncommitted)

| Finding                  | Fix                                                                                                                                                                    |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1 premature agent-end   | End reports bound to room + `sip.callID` (409 on mismatch; older agents marked unbound); the sweep never closes or deletes while an agent participant is connected.    |
| F2 per-call limit        | min(klyro, agent) recorded on the row at session start and returned; the sweep uses the row's value; older agents/rows: 7200 s ceiling.                                |
| F3 database errors       | Every PostgREST result checked (`DbError`); selection error -> route 500; per-row DB errors counted and logged; route 500 on any DB/row error.                         |
| F4 orphan rooms          | `ListRooms`-based sweep of agent-less `call-` rooms with no active row (unknown number, refused, klyro unreachable).                                                   |
| F5 execution budget      | 18 s / 45-subrequest run budget, per-row isolation, claim-time lease, abandoned lease = failed attempt.                                                                |
| F6 lost updates          | All `provider_metadata` writers conditional on every shared key, merge-retry on conflict (`call-meta.ts`). Assessed: no migration needed; verified on real PostgreSQL. |
| F7 close ordering        | Verify -> record decision (requires active) -> delete -> close; webhook applies the recorded decision; a webhook that wins prevents deletion.                          |
| F8 prolonged outages     | Exponential backoff 5..60 min until the 24 h window ends (`expired`); one alert per row.                                                                               |
| F9 production scheduling | RUNBOOK: external scheduler table, WAF for `/api/public/cron/*`, alert list, go-live checklist.                                                                        |
| F10 indexes              | `20261102100000_voice_agent_room_sweep_indexes.sql` prepared (NOT executed); real-PostgreSQL test shows the sweep's queries can use them.                              |

LiveKit Cloud behaviour (participant kinds, 404 on a missing room, ListRooms fields, SIP hang-up on room deletion) is still unverified: open-source source reading only. STAGING.md §6c acceptance criterion 3 covers it.

#### 3j. Phase 2.12 security hardening (uncommitted)

- **F13:** `LIVEKIT_URL` validated before any token is minted (TLS + `*.livekit.cloud` or `LIVEKIT_ALLOWED_HOSTS`; plaintext only to localhost; no credentials/path/query); same host rule in the agent's config outside development. DeleteRoom token reduced to `{ roomCreate }` (no narrower grant exists in LiveKit) with 30 s lifetime; ListRooms `{ roomList }` 30 s.
- **F14:** voice cron routes use their own credential (`VOICE_AGENT_CRON_SECRET`): signed + replay-protected requests (pgcrypto-compatible, verified on real PostgreSQL) or route-scoped bearer tokens; the shared `LOVABLE_CRON_SECRET` no longer opens them once set; per-IP failed-auth limit and per-route run limit; generic responses; no secrets in logs (verified on the built Worker locally).
- **Migration automation:** still not conclusively known (STAGING.md §0a evidence table).

### 4. Bugs fixed (from the evaluation)

Hindi and Telugu midnight now give 00:00, and noon gives 12:00. A bare "12" is uncertain until clarified.

"After 2 PM" is now a constraint, not a 2 PM slot. Bare clinic hours are inferred and confirmed by read-back.

"Yes that one" and "ek minute" are no longer read as 1 o'clock. Phone digits are never read as times.

Negated services and times are handled ("not cleaning, root canal"; "3 बजे नहीं, 4 बजे").

A Hindi or Telugu yes followed by more words ("हाँ जी, इसी नंबर पर") counts as a yes.

All of these are covered by tests. The production parser (`src/lib/voice-runtime.server.ts`, `voice-intent-lexicon.ts`) is **not** changed. The midnight defect remains there for the current answer-URL path; fixing it there is a separate, small change.

### 5. Vobiz compatibility evidence

- **Source:** only Vobiz's official repo `vobiz-ai/vobiz-mcp-server` 1.4.3, read earlier. `staging.vobiz.ai` is blocked here.
  - LiveKit is reached over SIP: an inbound trunk whose Primary URI is the LiveKit SIP host.
  - LiveKit's Allowed Addresses must list Vobiz's signalling IPs.
  - Outbound uses the trunk domain `<id>.sip.vobiz.ai` with digest credentials.
- **Not verified on the account:** trunks enabled, limits, codecs, DTMF and REFER transfer, recording. That needs Vobiz credentials.
- **Implemented:**
  - inbound and outbound with caller ID preserved (`sip.phoneNumber`);
  - answer and reject (klyro's gate; a denied call hears a fixed message, then hangs up);
  - hangup (room deletion);
  - SIP disconnect (session close finishes the call);
  - billing from **signed** LiveKit events only;
  - duplicate-webhook dedupe;
  - a stale-call sweep.
- **Not implemented:** DTMF handling, recording (no egress configured), and transfer.

### 6. Sarvam integration evidence (`@livekit/agents-plugin-sarvam` 1.9.5 source)

- **STT:** `saaras:v3` with `languageCode:"unknown"` and `mode:"codemix"`. It supports Telugu, Hindi and English. It **returns no interim transcripts** (`interimResults:false`).
  - Mitigation: Silero VAD plus endpointing delays plus the turn detector; `preemptiveGeneration` is off; barge-in is VAD-driven.
  - The plugin's WebSocket endpoint differs from production's `saaras:v3-realtime`, so accuracy has to be re-measured.
- **TTS:** `bulbul:v3` with a per-turn language switch. The business's voice is used when it is a v3 speaker; otherwise it's `priya`.
- **No Sarvam LLM plugin.** Claude is kept, via LiveKit's Anthropic plugin 1.9.5, using the same `CLAUDE_MODEL` as klyro.
- **No live Sarvam call was made** (blocked).
- **Turn detector:** the multilingual model's language list is downloaded at runtime and wasn't reachable, so **Telugu and Hindi support is unverified**. Unsupported languages fall back to VAD silence.

### 7. Actual call test results

**None.** No real call has been placed (development, staging or production). Audio-level tests weren't run: noise, long pauses, slow speakers, accents, codec. Neither were the real end-to-end lifecycle and the comparison against the current implementation.

### 8. Security findings

**Implemented and tested:**

- signed internal API: HMAC, 60 s window, single-use nonces, 64 KB limit, schema validation, key rotation;
- LiveKit webhook signature and body hash, required `exp`, dedupe;
- unsigned Vobiz trunk webhooks are not used;
- tenant isolation: the organization comes from the call row; tools = voice set ∩ agent capabilities; tenant-looking inputs are stripped; the registry also ignores them;
- model tools take no business values;
- caller ID is inferred until confirmed;
- logs mask phone numbers and redact text;
- the agent sends klyro outcome codes only, never a transcript;
- configuration fails closed and never echoes secrets.

**Open findings:**

1. **No rate limiting** in app code (true of all webhooks today). It needs a Cloudflare WAF rule (RUNBOOK §Deploy 7).
2. **Replay records:** mitigated in code. The reconcile cron now deletes `voice_agent_request` rows older than 24 h; nothing else in `webhook_events` is touched. The cron still has to be scheduled (RUNBOOK §Deploy 6).
3. **Outbound initiation:** resolved. The HMAC `/outbound` endpoint is removed. Outbound calls start only from the authenticated server function `startAgentOutboundCall` (`src/lib/voice-agent/outbound.functions.ts`): the organization is derived from the number row; the caller must be owner/admin of that organization; then per-org/per-user rate limits, wallet, entitlement gate and the call row, then a LiveKit agent dispatch. `VOICE_AGENT_OUTBOUND_ENABLED` remains as a kill switch only. A failed dispatch or dial closes the row as failed (never billed). No UI calls it yet.
4. **Recording:** not configured. If enabled, it needs consent prompts, restricted storage, access control and retention.
5. **Lost LiveKit webhook:** the call is closed as failed and not billed. That's revenue-safe for the customer, but needs operations reconciliation.
6. **SIP allow-list:** the provisioning script refuses `0.0.0.0/0` outside development. It must be fed Vobiz's published IPs.

### 9. Latency (measured here; `bench/latency.ts`)

| Path                                                                 | Median   | p95     |
| -------------------------------------------------------------------- | -------- | ------- |
| Understanding + state + next step                                    | 0.039 ms | 0.21 ms |
| LiveKit AgentSession turn overhead (model 0)                         | 4.4 ms   | 6.1 ms  |
| Signed klyro tool call through klyro's real handler (localhost HTTP) | 2.1 ms   | 3.3 ms  |

Not measured: STT, LLM time to first token, TTS first audio, end-of-turn model, SIP and network. **Proposed acceptance thresholds** (to confirm before testing):

- time to first agent audio after the caller stops: p50 ≤ 1.2 s, p95 ≤ 2.0 s;
- barge-in stop ≤ 300 ms;
- false booking or confirmation claims = 0;
- booking success on scripted calls ≥ 95%;
- intent and slot accuracy on the Telugu/Hindi/English script set ≥ 95%;
- dropped calls ≤ 1%.

### 10. Per-minute operating cost

**Not available.** Pricing pages were blocked and no usage data exists. The components:

- LiveKit (Cloud agent-minutes plus SIP-minutes, or self-hosted VMs);
- the agent compute: a 2–4 vCPU pod for about 8 concurrent calls (a starting estimate, unmeasured);
- Sarvam STT and TTS minutes;
- Claude tokens per turn (state plus instructions plus tool schemas);
- Vobiz SIP-trunk minutes.

### 11. Outstanding risks

- Real-call quality, latency and turn-taking in Telugu and Hindi are unknown.
- The Sarvam plugin endpoint differs from production's.
- The Vobiz account's SIP capabilities are unverified.
- `call_logs.status` is `answered` for SIP calls in progress, which existing dashboards may treat differently.
- The production parser's midnight defect remains on the old path.

### 12. Remaining blockers (exact)

1. **Network:** allow `docs.livekit.io`, `livekit.io`, `*.livekit.cloud`, `staging.vobiz.ai`, `api.vobiz.ai`, `docs.sarvam.ai`, `api.sarvam.ai`, `huggingface.co` and Docker Hub (or a mirror).
2. **Credentials (development first):** a LiveKit project, a Sarvam key, an Anthropic key, Vobiz API credentials, and a development Vobiz number.
3. **Approvals:**
   - commit and push this branch;
   - deploy klyro with the new routes;
   - create LiveKit SIP trunks and webhooks;
   - link the development number to SIP;
   - paid test calls;
   - any production number migration.
4. **Decisions:**
   - LiveKit Cloud vs self-hosted;
   - where the agent runs (Kubernetes provider);
   - the outbound initiation path (finding 3);
   - recording policy;
   - the acceptance thresholds above.
