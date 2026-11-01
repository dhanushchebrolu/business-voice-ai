# Voice agent runbook (LiveKit SIP path)

Every step that touches production, a paid call or call routing needs explicit approval first.

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
- klyro Worker: `VOICE_AGENT_HMAC_SECRET` (same value), `VOICE_AGENT_HMAC_SECRET_PREVIOUS` (during rotation only), `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`.
- klyro Worker, outbound only: `VOICE_AGENT_OUTBOUND_ENABLED=true`. Leave it unset (endpoint answers 404) until outbound calls are started from klyro's authenticated UI.

## Deploy (per environment)

1. klyro: deploy the commit containing `src/lib/voice-agent/` and the new routes (normal Workers Builds flow). The routes are inert until `VOICE_AGENT_HMAC_SECRET` and the LiveKit keys are set; without them they answer 503 (fail closed).
2. Image: `docker build -f services/voice-agent/Dockerfile -t REGISTRY/clickai-voice-agent:$SHA .` (needs huggingface.co for the turn-detector model), then push.
3. Agent: `kubectl -n <ns> apply -f services/voice-agent/deploy/k8s/voice-agent.yaml` with the image tag set. Wait until `kubectl rollout status` succeeds and every pod is Ready (Ready = connected to LiveKit, inference process up).
4. LiveKit SIP: `npm run provision:sip` (dry run), review the plan, then `npm run provision:sip -- --apply`. Initially `SIP_INBOUND_NUMBERS` lists only the test number.
5. LiveKit webhooks: in the LiveKit project, set the webhook URL to `https://<klyro host>/api/public/webhooks/livekit` (signed with the project's API key).
6. Cron: schedule `POST /api/public/cron/reconcile-sip-calls` every 15 min, with the same cron auth as the other sweeps. It closes calls whose signed end event never arrived (without billing) and deletes replay-protection records older than 24 h.
7. Cloudflare WAF: add a rate-limit rule for `/api/internal/voice-agent/*` (e.g. 600 requests/min per IP) and `/api/public/webhooks/livekit`.

## Smoke tests (after every deploy)

- `curl -s https://<pod>:8081/` returns 200 `OK`; `/worker` shows `agent_name` and `active_jobs`.
- klyro: an unsigned `POST /api/internal/voice-agent/session` returns 401. Without secrets it returns 503.
- Test number: call it; expect the greeting, a booking for a test business, then the call ends. `call_logs` shows one row (provider `livekit_sip`) that is `completed` with a duration. The wallet is debited once. Logs carry `call.connected`, `turn.*`, `tool`, `booking.result` and `call.ended` for that call id, with no transcript text.

## Migrating a number (one at a time; the answer-URL path stays deployed)

1. Preconditions: staging acceptance passed (REPORT §Acceptance), and the number's business has `calendar_read` / `calendar_book` capabilities as intended.
2. LiveKit: add the number to `SIP_INBOUND_NUMBERS`, then run `provision:sip --apply`.
3. Vobiz console: link the number to the inbound trunk whose Primary URI is the LiveKit SIP host. This replaces its Voice Application (answer URL) link. Record the previous application id.
4. Place one test call (approval needed: paid). Watch the logs and `call_logs` for 24 h.
5. **Rollback for that number:** in Vobiz, re-link the number to its previous Voice Application (answer URL). Calls immediately go back to the existing Worker media-stream path. Then remove the number from `SIP_INBOUND_NUMBERS` and run `--apply`. No database change is involved.

## Rollback (whole path)

- Re-link every migrated number to its Voice Application (as above). The old path was never removed.
- Scale the agent to 0: `kubectl -n <ns> scale deploy/voice-agent --replicas=0`. Active calls drain first.
- klyro: the new routes can stay; they are unused without SIP traffic. Calls already recorded keep their `call_logs` rows.

## Secret rotation (`VOICE_AGENT_HMAC_SECRET`)

1. klyro: set `VOICE_AGENT_HMAC_SECRET_PREVIOUS` = old value and `VOICE_AGENT_HMAC_SECRET` = new value.
2. Agent: set the new value with `VOICE_AGENT_HMAC_KEY_ID=current` and roll out.
3. After the rollout, remove `VOICE_AGENT_HMAC_SECRET_PREVIOUS` from klyro.
