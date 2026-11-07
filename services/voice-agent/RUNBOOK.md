# Voice agent runbook (LiveKit SIP path)

Every step that touches production, a paid call or call routing needs explicit approval first.
Staging specifics (build fix, network, smoke tests, costs): [STAGING.md](STAGING.md).

## Environments

|                 | development              | staging                                     | production                    |
| --------------- | ------------------------ | ------------------------------------------- | ----------------------------- |
| LiveKit project | separate dev project     | separate staging project                    | production project            |
| klyro           | local / preview          | `clickai-staging` Worker + staging Supabase | `klyro` + production Supabase |
| Vobiz number    | 1 dev number             | 1 staging number                            | migrated number by number     |
| Agent runtime   | `npm run dev` or compose | k8s namespace `clickai-staging`             | k8s namespace `clickai-prod`  |
| `APP_ENV`       | development              | staging                                     | production                    |

Secrets per environment (names in `.env.example`; values only in each environment's secret store):

- agent: LiveKit key/secret, Sarvam key, Anthropic key, `VOICE_AGENT_HMAC_SECRET`;
- klyro Worker: `VOICE_AGENT_HMAC_SECRET` (same value), `VOICE_AGENT_HMAC_SECRET_PREVIOUS` (during rotation only), `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `VOICE_AGENT_NAME` (= the agent's `AGENT_NAME`).
- Outbound: agent `SIP_OUTBOUND_TRUNK_ID`; klyro `VOICE_AGENT_OUTBOUND_ENABLED=true` (kill switch) and optionally the `VOICE_AGENT_OUTBOUND_*` toll-fraud settings (root `.env.example`). Outbound calls start only from the authenticated server function `startAgentOutboundCall` (owner/admin of the number's organization, client-generated `idempotencyKey`); the agent's signing key cannot start calls, and the agent dials only the destination and caller ID it receives from klyro's claim endpoint (one job per call). Lifecycle: STAGING.md §7.

## Deploy (per environment)

0. **Order (Phase 2.11):** roll out the agent image first, then klyro. The agent sends its own `MAX_CALL_SECONDS` at session start and binds its end reports to the call; klyro records the per-call limit and refuses mismatching reports. Older agents keep working (their calls get the 7200 s ceiling; their end reports are accepted and marked unbound).
1. klyro: deploy the commit containing `src/lib/voice-agent/` and the new routes (normal Workers Builds flow). The routes are inert until `VOICE_AGENT_HMAC_SECRET` and the LiveKit keys are set; without them they answer 503 (fail closed).
2. Image: `docker build -f services/voice-agent/Dockerfile -t REGISTRY/clickai-voice-agent:$SHA .` (needs huggingface.co for the turn-detector model), then push. Docker Hub 429: add `--build-arg BASE_REGISTRY=mirror.gcr.io/library` (same digest-pinned base image).
3. Agent: `kubectl -n <ns> apply -f services/voice-agent/deploy/k8s/voice-agent.yaml` with the image tag set. Wait until `kubectl rollout status` succeeds and every pod is Ready (Ready = connected to LiveKit, inference process up).
4. LiveKit SIP: `npm run provision:sip` (dry run: lists only, changes nothing), review the plan, then `npm run provision:sip -- --apply`, which applies the plan, reads the trunk and rule back and exits non-zero if LiveKit's state differs from the request (it prints the steps already applied; re-running converges). Initially `SIP_INBOUND_NUMBERS` lists only the test number. No outbound trunk is created unless `--with-outbound` is given (outbound is not approved).
5. LiveKit webhooks: in the LiveKit project, set the webhook URL to `https://<klyro host>/api/public/webhooks/livekit` (signed with the project's API key).
   5b. Outbound only: apply `supabase/migrations/20261102090000_voice_agent_outbound_reservation.sql` (approval required). Without it every outbound request fails closed with `internal_error`; inbound is unaffected.
6. Cron (production: the same **external scheduler** as the other klyro sweeps, request timeout ≥ 25 s, no automatic retries on 5xx; staging: `scripts/staging/schedule-cron.sql` via pg_cron/pg_net). The two voice routes do **not** accept `LOVABLE_CRON_SECRET` once `VOICE_AGENT_CRON_SECRET` is set (Phase 2.12, F14; `src/lib/voice-agent/cron-auth.server.ts`). Configure the scheduler with ONE of:
   - **Signed (preferred, replay-protected):** headers `X-Voice-Cron-Timestamp: <unix seconds>` and `X-Voice-Cron-Signature: <hex HMAC-SHA256>` over `v1\n<timestamp>\nPOST\n/api/public/cron/<route>`, fresh per request (±300 s, each signature accepted once). Staging SQL does this with pgcrypto.
   - **Route-scoped bearer** (scheduler that can only send fixed headers): `Authorization: Bearer <token>` where the token is per route: `printf 'v1\nbearer\n/api/public/cron/sweep-sip-rooms' | openssl dgst -sha256 -hmac "$VOICE_AGENT_CRON_SECRET" -r | cut -d' ' -f1` (same with `reconcile-sip-calls`). Store the two tokens in the scheduler, never the secret. Disable this mode with `VOICE_AGENT_CRON_REQUIRE_SIGNED=true` once signing is in place.
   - Limits: 10 failed authentications per client IP per minute, then 429; 6 authenticated runs per route per minute, then 429. Responses are `{"error":"unauthorized"}` without detail; logs carry only the route and a reason.
   - Rotation: set `VOICE_AGENT_CRON_SECRET_PREVIOUS` = old, `VOICE_AGENT_CRON_SECRET` = new, update the scheduler (new tokens), then remove `_PREVIOUS`.

   | Route                                  | Schedule        | Log per run                               | Purpose                                                                                                                                                                                                    |
   | -------------------------------------- | --------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `/api/public/cron/reconcile-sip-calls` | every 15 min    | `sip_reconcile:tick`                      | closes calls whose signed end event never arrived (without billing), billing retries, prunes replay records and rate-limit windows older than 24 h                                                         |
   | `/api/public/cron/sweep-sip-rooms`     | **every 5 min** | `sip_room_sweep:tick` (or `:tick_failed`) | independent maximum-duration backstop: deletes the LiveKit rooms of calls the agent could not end, and orphan `call-` rooms (STAGING.md §6c). 500 = database/row errors; 503 = LiveKit credentials missing |

   Configure both in the scheduler **before** routing any production number to LiveKit. Verify with one manual authenticated `POST` each (expect 200 and a JSON summary) and the tick lines in the Worker logs.

7. Cloudflare WAF rate-limiting rules (required before production): `/api/internal/voice-agent/*` and `/api/public/webhooks/livekit` (e.g. 600 requests/min per IP), `/api/public/cron/*` (e.g. 30 requests/min per IP; only the scheduler calls them; match the path prefix for every method: verified on the built Worker, only POST reaches the cron handlers, GET/PUT fall through to the app's HTML shell, a trailing slash still reaches the handler), and the outbound server-function path. Optionally restrict `/api/public/cron/*` to the scheduler's egress IPs if it has fixed ones. The Worker's own pre-auth limiter only refuses sources that keep failing authentication; it is not volumetric protection (STAGING.md §7).
8. Alerts (log platform), before production: no `sip_room_sweep:tick` for 15 min; no `sip_reconcile:tick` for 30 min; any `sip_room_sweep:tick_failed`; any `voice_agent:room_sweep_failed`, `voice_agent:room_sweep_agent_stuck`, `voice_agent:room_sweep_mismatch`, `voice_agent:room_sweep_invalid_room`, `voice_agent:room_sweep_expired`, `voice_agent:room_sweep_db_error`, `voice_agent:room_sweep_unconfigured`, `voice_agent:orphan_room_mismatch` (page); `voice_agent:room_swept` / `voice_agent:orphan_room_swept` (warn: the agent failed to end a call); `call.cleanup_failed` from the agent (page). Details and manual recovery: STAGING.md §6c.

## Go-live checklist (production)

- [ ] H-A: Supabase GitHub integration / Branching / Lovable migration behaviour confirmed (STAGING.md §0a).
- [ ] Migrations `20261102090000_voice_agent_outbound_reservation.sql` (outbound only) and `20261102100000_voice_agent_room_sweep_indexes.sql` (indexes; build CONCURRENTLY by hand first on a large table) applied by the owner, with approval.
- [ ] Agent image built with real model files (`verify-models: ok`), offline start verified.
- [ ] Agent rolled out before klyro (step 0).
- [ ] Both cron routes scheduled in the external scheduler (step 6) and their tick lines seen.
- [ ] WAF rules (step 7) and alerts (step 8) in place; one test alert delivered.
- [ ] LiveKit: webhook URL set; `VOICE_AGENT_MAX_CALL_SECONDS` (Worker) ≥ the agent's `MAX_CALL_SECONDS` (or unset: 1800 both).
- [ ] Staging acceptance criteria in STAGING.md §6c passed, including the paid crash / cleanup-failure tests (approval).
- [ ] Outbound stays disabled (`VOICE_AGENT_OUTBOUND_ENABLED` unset) until separately approved.

## Smoke tests (after every deploy)

- `curl -s https://<pod>:8081/` returns 200 `OK`; `/worker` shows `agent_name` and `active_jobs`.
- klyro: an unsigned `POST /api/internal/voice-agent/session` returns 401. Without secrets it returns 503.
- Test number: call it; expect the greeting, a booking for a test business, then the call ends. `call_logs` shows one row (provider `livekit_sip`) that is `completed` with a duration. The wallet is debited once. Logs carry `call.connected`, `turn.*`, `tool`, `booking.result` and `call.ended` for that call id, with no transcript text.

## Migrating a number (one at a time; the answer-URL path stays deployed)

1. Preconditions: staging acceptance passed (REPORT §Acceptance), and the number's business has `calendar_read` / `calendar_book` capabilities as intended.
2. LiveKit: add the number to `SIP_INBOUND_NUMBERS`, run `provision:sip` (the plan must show only that number added), then `provision:sip -- --apply` (verified by read-back).
3. Vobiz console: link the number to the inbound trunk whose Primary URI is the LiveKit SIP host. This replaces its Voice Application (answer URL) link. Record the previous application id.
4. Place one test call (approval needed: paid). Watch the logs and `call_logs` for 24 h.
5. **Rollback for that number:** in Vobiz, re-link the number to its previous Voice Application (answer URL). Calls immediately go back to the existing Worker media-stream path. Then remove the number from `SIP_INBOUND_NUMBERS` and run `--apply`. No database change is involved.

## Rollback (whole path)

- Re-link every migrated number to its Voice Application (as above). The old path was never removed.
- Scale the agent to 0: `kubectl -n <ns> scale deploy/voice-agent --replicas=0`. Active calls drain first.
- klyro: the new routes can stay; they are unused without SIP traffic. Calls already recorded keep their `call_logs` rows.
- Room sweep: remove `sweep-sip-rooms` from the scheduler to stop it (it only acts on rooms of calls past their limit or without an agent; stopping it re-opens the stranded-caller risk).

## Secret rotation (`VOICE_AGENT_HMAC_SECRET`)

1. klyro: set `VOICE_AGENT_HMAC_SECRET_PREVIOUS` = old value and `VOICE_AGENT_HMAC_SECRET` = new value.
2. Agent: set the new value with `VOICE_AGENT_HMAC_KEY_ID=current` and roll out.
3. After the rollout, remove `VOICE_AGENT_HMAC_SECRET_PREVIOUS` from klyro.
