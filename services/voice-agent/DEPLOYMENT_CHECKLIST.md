# LiveKit voice agent: deployment checklist

An ordered checklist for staging, then production. Details live in the
documents linked from each step; this list only fixes the order and what
must be true before the next step. Nothing here is done yet. Production
stays on the existing Vobiz → Worker path until step 9, and only number by
number.

## 0. Before anything

- [ ] Migration automation answered (PRODUCTION_READINESS.md §4 B1, §5): does
      pushing a file in `supabase/migrations/` apply it automatically
      (Supabase GitHub integration, Branching, Lovable)? Until answered, a
      migration is applied only by hand, with approval.
- [ ] Read-only schema check in the target project:
      `scripts/staging/check-voice-agent-schema.sql`.

## 1. Database (in this order, each with approval)

| Order | Migration                                             | Needed for                                      |
| ----- | ----------------------------------------------------- | ----------------------------------------------- |
| 1     | `20261102090000_voice_agent_outbound_reservation.sql` | outbound calls only (outbound is not approved)  |
| 2     | `20261102100000_voice_agent_room_sweep_indexes.sql`   | room sweep performance (optional)               |
| 3     | `20261107090000_voice_agent_transcript_segments.sql`  | **every LiveKit call that stores a transcript** |

- [ ] Before 3: `select count(*) from call_logs where provider = 'livekit_sip' and transcript is not null;`
      Expected 0. The function rebuilds a call's transcript from its segments
      only, so a LiveKit transcript written by older code would be replaced
      by the first segment stored for that call.
- [ ] Apply 3, then check: the table `call_transcript_segments` exists with RLS
      on; `has_function_privilege('service_role', 'public.store_voice_agent_transcript_segment(uuid,text,text,jsonb,boolean,text)', 'execute')`
      is true and false for `anon` and `authenticated`.
- [ ] Apply the migration **before** deploying Worker code that calls the
      function. Without it, every session-end carrying a transcript fails
      (HTTP 500; the agent's checkpoints retry; nothing is reported as stored).
- [ ] Rollback for 3: deploy Worker code that does not call the function
      first, then the two `DROP` statements in the migration's header.

## 2. LiveKit server and SIP (self-hosted or LiveKit Cloud)

- [ ] LiveKit API/WebSocket behind TLS on 443 with a public certificate; never
      `--dev`; keys from a secret manager; separate key pairs per environment
      (LOCAL_LIVEKIT.md §9).
- [ ] Self-hosted: public IP with `use_external_ip`/`node_ip` and
      `nat_1_to_1_ip`; RTC TCP 7881 and the WebRTC UDP range open; SIP
      service on 5060 UDP/TCP and its RTP UDP range open, both ranges sized
      for peak calls (the local stack's 100-port ranges are for development
      only: deploy/docker-compose.dev.yml).
- [ ] `LIVEKIT_URL` (`wss://`) and `LIVEKIT_ALLOWED_HOSTS` set identically on
      the Worker and the agent (non-TLS and unlisted hosts are refused).
- [ ] Webhook to `https://<klyro host>/api/public/webhooks/livekit`
      (signed; billing depends on it).
- [ ] `npm run provision:sip` (dry run), review, then `-- --apply` (verified by
      read-back). `SIP_INBOUND_NUMBERS` starts with the test number only. No
      outbound trunk (`--with-outbound` is not approved). RUNBOOK.md step 4.

## 3. Redis (self-hosted LiveKit)

- [ ] Private network only, password set, **persistence on** (AOF or RDB): SIP
      trunks and dispatch rules live in Redis and are lost on a restart
      without it (LOCAL_LIVEKIT.md §4a).
- [ ] Start-up check that the trunk `clickai-vobiz-inbound` and dispatch rule
      `clickai-receptionist` exist; re-run `provision:sip -- --apply` if not.

## 4. Firewall and TLS summary

- [ ] Inbound: 443/TCP (LiveKit API, TLS); 7881/TCP and the WebRTC UDP range;
      5060 UDP/TCP and the SIP RTP UDP range **from Vobiz signalling/media
      IPs only** (the SIP inbound allow-list is required outside development;
      `0.0.0.0/0` is refused).
- [ ] Agent health port 8081 reachable only from the cluster (probes), never
      the internet.
- [ ] Agent egress: LiveKit, the klyro Worker, Sarvam (and Anthropic only if
      that provider is chosen). Recommended NetworkPolicy
      (PRODUCTION_READINESS.md §6).

## 5. Vobiz

- [ ] Test number only, pointed at the LiveKit SIP trunk; record its previous
      Voice Application id first (this is the rollback).
- [ ] Vobiz signalling and media IP list obtained and put in the SIP allow-list
      and firewall.
- [ ] No change to any other number's routing. Numbers move one at a time
      (RUNBOOK.md "Migrating a number").

## 6. Sarvam

- [ ] Staging key with a spend limit, in the secret manager, mounted into the
      agent (`voice-agent-secrets`), never in an env file or the image.
- [ ] `LLM_PROVIDER=sarvam` set explicitly (required outside development).
- [ ] Connectivity check from the agent's network (STT, TTS, LLM endpoints)
      before the first call. Paid calls only with approval.
- [ ] Sarvam LLM acceptance thresholds still open (SARVAM_LLM_MIGRATION.md §6).

## 7. Worker internal API

- [ ] `VOICE_AGENT_HMAC_SECRET` identical on the Worker and the agent;
      `VOICE_AGENT_CRON_SECRET` set and `VOICE_AGENT_CRON_REQUIRE_SIGNED=true`.
- [ ] Both voice cron routes scheduled (reconcile, room sweep), ≥ 25 s
      timeout.
- [ ] `VOICE_AGENT_ENV` unset or `production` in production (never runs an
      unpublished agent configuration); every business has a published agent
      version.
- [ ] WAF rate limits on the internal and webhook routes.

## 8. Health checks, logging, alerts

- [ ] Agent readiness/liveness on `GET :8081/` (200 only when connected to
      LiveKit with the inference process running).
- [ ] Alerts (RUNBOOK.md step 8), plus for transcripts: HTTP 5xx on
      `/api/internal/voice-agent/session-end`, and the warnings
      `voice_agent:transcript_checkpoint_unbound`,
      `voice_agent:end_report_transcript_refused`,
      `voice_agent:transcript_unbound_ignored`.
- [ ] Logs carry no transcripts or phone numbers (agent telemetry already
      excludes them).

## 9. Rollout and rollback

- [ ] Staging acceptance matrix passed (PRODUCTION_READINESS.md §15), including
      a call where the agent is killed mid-call: the dashboard shows the
      turns checkpointed before the crash.
- [ ] Launch gates (PRODUCTION_READINESS.md §12) all met.
- [ ] Rollback, fastest first (PRODUCTION_READINESS.md §13): re-link the number
      to its previous Vobiz application; scale the agent to 0; redeploy the
      previous Worker; unschedule the voice crons; database last (step 1).
