# Staging deployment package: LiveKit SIP voice agent (Phase 2.13)

The single checklist for a controlled staging deployment of klyro (`clickai-staging` Worker) + the voice agent (`services/voice-agent`) + LiveKit SIP + one Vobiz test number. Detailed background stays in [STAGING.md](STAGING.md) and [RUNBOOK.md](RUNBOOK.md).

Nothing in this document has been executed against an external service. Status words: **verified** = observed in this repository's sandbox (tests, local builds, local Worker); **unverified** = requires a dashboard, credentials or network access that was not available; **manual** = an action only the owner can take.

## 0. Readiness at a glance

| Area                                          | Status                                                                                        |
| --------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Application code, tests, type checks, lint    | **verified** (Phase 2.12: app 4,097 tests / 0 failures; agent 116/116; real PostgreSQL 25/25) |
| Staging Worker build + Wrangler dry-run       | **verified locally** with placeholder public values (§3)                                      |
| Cron route authentication on the built Worker | **verified locally** (`wrangler dev --local`, Phase 2.12)                                     |
| Migration automation (Supabase / Lovable)     | **unknown**: dashboard-only settings (§1)                                                     |
| Docker image with real model files            | **blocked**: huggingface.co is denied by this environment's network policy (§2)               |
| Cloudflare Workers Builds (`clickai-staging`) | **unverified**: Cloudflare API/dashboard denied; the failed builds' logs are unread (§3)      |
| LiveKit, Vobiz, Sarvam, Anthropic             | **unverified**: no credentials, no access (§4)                                                |
| Paid acceptance tests                         | **not run** (approval required) (§7)                                                          |

**Staging must not be exposed until §1 is answered, the image passes §2, and the Worker build passes §3.**

## 1. Migration safety checklist (manual, dashboard only)

Two migration files exist in the worktree, both **untracked** and **never executed**:

| File                                                                      | Purpose                                                    | Needed for inbound staging?                                    |
| ------------------------------------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------- |
| `supabase/migrations/20261102090000_voice_agent_outbound_reservation.sql` | `reserve_voice_agent_outbound_call` (atomic outbound caps) | No (outbound stays disabled; without it outbound fails closed) |
| `supabase/migrations/20261102100000_voice_agent_room_sweep_indexes.sql`   | two partial indexes for the room sweep                     | No (performance only; correct without it)                      |

Facts already verified from the repository and GitHub (STAGING.md §0a): no workflow runs the Supabase CLI; `supabase/config.toml` holds only `project_id`; PR #4, which added a migration on 2026-09-11, had no Supabase Preview check or comment.

Check **each** of the following in **both** the production project (`eorazvlmqwunmhwviocn`) and the staging project, write down the answer with a screenshot and date, and do not infer any unknown setting:

| #   | Where (dashboard)                                                                                                             | Record                                                                                                            | Safe answer                                                                          |
| --- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| S1  | Supabase → project → Project Settings → Integrations → **GitHub**                                                             | Is a repository connected? Which one?                                                                             | Not connected, or connected to another repository                                    |
| S2  | same page                                                                                                                     | **Production branch** name                                                                                        | any; see S3                                                                          |
| S3  | same page                                                                                                                     | **"Deploy to production"** (apply migrations on push/merge to the production branch): on/off                      | **off**, or on but the production branch never receives these files without approval |
| S4  | same page                                                                                                                     | **Supabase directory** (default `supabase`)                                                                       | record it (it determines which `migrations` folder is applied)                       |
| S5  | Supabase → project → **Branches** (Branching)                                                                                 | Branching enabled? Automatic preview branches for every PR?                                                       | **off**; if on, a PR containing a migration runs it on a paid preview database       |
| S6  | Supabase → Database → **Migrations** (or `select * from supabase_migrations.schema_migrations order by version desc limit 5`) | Latest applied version (also printed by `scripts/staging/check-voice-agent-schema.sql`)                           | record; any later change you did not make reveals automatic application              |
| L1  | Lovable → project → Settings → **GitHub**                                                                                     | Connected repository and synced branch (normally `main`)                                                          | record                                                                               |
| L2  | Lovable → project → **Supabase** connection                                                                                   | Which Supabase project Lovable controls (live `eorazvlmqwunmhwviocn` or the old `blr…` project)                   | record                                                                               |
| L3  | Lovable support / documentation                                                                                               | Does Lovable apply SQL files that arrive in `supabase/migrations` through GitHub sync, without a click in its UI? | **no** (confirmed in writing)                                                        |

Decision rule: if S3 is on, S5 is on, or L3 is unknown/yes, keep both migration files out of every commit. When all answers are safe, commit them only on a feature branch with no open PR, and apply them by hand (SQL editor or `supabase db push --db-url`) with approval: the index migration first (build the indexes `CONCURRENTLY` by hand on a large table), the outbound migration only when outbound is approved.

## 2. Docker image and model assets

### What the image must contain (verified from the installed packages)

| Asset                                                 | Source                                                         | Needed at runtime                     | Where it is cached in the image                                                                                                                                          |
| ----------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Turn detector ONNX `onnx/model_q8.onnx`               | huggingface.co `livekit/turn-detector`                         | revision `v0.4.1-intl` (multilingual) | `/home/node/.cache/huggingface/hub/models--livekit--turn-detector/…` (`@livekit/agents-plugin-livekit` hf_utils: `~/.cache/huggingface/hub`)                             |
| `languages.json` (per-language thresholds)            | same repository                                                | same revision                         | same cache                                                                                                                                                               |
| Tokenizer (`tokenizer.json`, `tokenizer_config.json`) | same repository, via `@huggingface/transformers` 4.2.0         | same revision                         | `services/voice-agent/node_modules/@huggingface/transformers/.cache/livekit/turn-detector/<revision>/` + the `main`-key copy written by `deploy/prepare-model-cache.mjs` |
| Silero VAD `silero_vad.onnx` (2.3 MB)                 | **bundled** in the npm package `@livekit/agents-plugin-silero` | yes                                   | `node_modules/@livekit/agents-plugin-silero/dist/silero_vad.onnx` (no download)                                                                                          |
| Sarvam STT/TTS, Anthropic LLM                         | **remote APIs**                                                | API keys only                         | none (no local models)                                                                                                                                                   |

`npx livekit-agents download-files` fetches the tokenizer, ONNX model and `languages.json` for **both** revisions (`v1.2.2-en` and `v0.4.1-intl`); only the multilingual one is used (`TURN_DETECTION=multilingual`, the default).

Download hosts the build host must reach: `huggingface.co`, `hf.co`, and its file CDNs (`cdn-lfs.huggingface.co`, `cdn-lfs-us-1.hf.co`, `cas-bridge.xethub.hf.co`); plus `registry-1.docker.io` (or `mirror.gcr.io`), `registry.npmjs.org`, `github.com` (tini, SHA-256 pinned).

### Failure behaviour when assets are missing

- **Build:** `deploy/verify-models.mjs` runs in the final stage as the `node` user with remote access disabled; it fails the build (`verify-models: FAILED …`) if the ONNX model, `languages.json` or the tokenizer cannot be loaded offline. **verified** (synthetic cache layout tests + Phase 2.2/2.6 builds stopping there).
- **Runtime (if the check were skipped):** the plugin throws `Required model files not found locally` when the inference process initializes the turn detector (source: `turn_detector/base.js`). The pod's readiness probe (`GET :8081/`, LiveKit's health server) is meant to answer 200 only when the inference process runs; **not observed** with missing models. Never build with `--build-arg VERIFY_TURN_DETECTOR=0` unless the pod runs `TURN_DETECTION=vad`.

### Image size

Measured in this sandbox: the image **without** model files is 1.84 GB on disk (514 MB compressed content). The model files' size could not be measured (huggingface.co blocked). Record on the build host: `docker image inspect <tag> --format '{{.Size}}'` and `docker run --rm --entrypoint du <tag> -sh /home/node/.cache/huggingface node_modules/@huggingface/transformers/.cache`.

### Build procedure (this environment is blocked; run elsewhere)

This sandbox cannot download the models (`huggingface.co` → 403 from the egress policy). **Placeholder assets must not be used.** On any machine or CI runner with the hosts above:

```sh
git checkout <the reviewed commit>
docker build -f services/voice-agent/Dockerfile -t REGISTRY/clickai-voice-agent:$GIT_SHA .
#   Docker Hub rate limit? add: --build-arg BASE_REGISTRY=mirror.gcr.io/library  (same digest)
#   The log must contain: "prepare-model-cache: ok" and "verify-models: ok (onnx model, languages.json and tokenizer load offline)"
docker image inspect REGISTRY/clickai-voice-agent:$GIT_SHA --format '{{.Size}}'
# Offline, as the runtime user:
docker run --rm --network none REGISTRY/clickai-voice-agent:$GIT_SHA node deploy/verify-models.mjs
# Full worker start offline: expect no huggingface / "tokenizer_class" / "not found locally" errors before the LiveKit connection error:
docker run --rm --network none -e APP_ENV=staging -e LIVEKIT_URL=wss://offline.livekit.cloud \
  -e LIVEKIT_API_KEY=x -e LIVEKIT_API_SECRET=xxxxxxxxxxxxxxxxxxxx -e SARVAM_API_KEY=x -e ANTHROPIC_API_KEY=x \
  -e KLYRO_BASE_URL=https://offline.invalid -e VOICE_AGENT_HMAC_SECRET=$(openssl rand -hex 24) \
  REGISTRY/clickai-voice-agent:$GIT_SHA      # stop with Ctrl-C after ~30 s
docker push REGISTRY/clickai-voice-agent:$GIT_SHA
```

Alternatives if no such machine exists: (a) allow the Hugging Face hosts in this environment's network settings and build here; (b) a GitHub Actions job (GitHub-hosted runners have internet access) running the same `docker build` and pushing to a registry you choose; this needs a new workflow and registry credentials, so it is **not** added without your approval.

## 3. Cloudflare staging (dry-run only)

Verified locally (this phase, placeholder public Supabase values, `npx vite build` then `npx wrangler deploy --dry-run`):

| Check                                                         | Result                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLICKAI_DEPLOY_TARGET=staging`                               | generated Worker name **`clickai-staging`**                                                                                                                                                                                                                                                                     |
| Target unset                                                  | name `klyro` (production): the staging project **must** set the variable                                                                                                                                                                                                                                        |
| Unknown target (`prod`)                                       | build fails: `Unknown CLICKAI_DEPLOY_TARGET "prod"`                                                                                                                                                                                                                                                             |
| `VITE_SUPABASE_URL` / `VITE_SUPABASE_PUBLISHABLE_KEY` missing | build fails (repository guard)                                                                                                                                                                                                                                                                                  |
| Generated config                                              | `main index.mjs`, `compatibility_date 2026-09-16`, `nodejs_compat`, Durable Objects `CALL_SESSION`, `VOBIZ_CALL_SESSION` (migrations `v1-call-session`, `v2-vobiz-call-session`), `keep_vars: true`, `secrets.required: [SUPABASE_SERVICE_ROLE_KEY]`, no `triggers` (cron is external), no routes (workers.dev) |
| Dry-run                                                       | exit 0; upload 6,029.75 KiB (gzip 1,401.49 KiB); bindings `CALL_SESSION`, `VOBIZ_CALL_SESSION`, `ASSETS`                                                                                                                                                                                                        |
| Secrets in the bundle                                         | none (only the word `service_role` in library comments; no JWT/`sb_secret_`/`sk-ant-` literals)                                                                                                                                                                                                                 |

Not verifiable here: the Workers Builds project settings and the failed builds' logs (Cloudflare blocked). Manual settings for the **`clickai-staging`** Workers Builds project:

1. Build variables (build-time): `CLICKAI_DEPLOY_TARGET=staging`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` (staging project's public values).
2. Branch control: only `feat/livekit-voice-agent` (no other branches, no production branch).
3. Worker variables/secrets: §5.
4. Re-run the build; the log must show the Worker name `clickai-staging`. Send the log if it fails.

Note: `wrangler.json` declares only `SUPABASE_SERVICE_ROLE_KEY` as required; the voice-agent secrets are not declared there (it is shared with production). Missing voice secrets fail closed at runtime (internal routes 503, cron 503/legacy, room sweep 503).

Cron routes (external scheduler, `POST`, timeout ≥ 25 s, no automatic retries): `/api/public/cron/sweep-sip-rooms` every 5 min, `/api/public/cron/reconcile-sip-calls` every 15 min, authenticated with `VOICE_AGENT_CRON_SECRET` (signed headers or route-scoped bearer; RUNBOOK.md step 6). Staging: `scripts/staging/schedule-cron.sql` (signs with pgcrypto).

## 4. External configuration checklist (manual; never paste values into tickets or chat)

| #   | System             | Action                                                                                                                                                                                                                                                             | Evidence to record                                                              |
| --- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| X1  | LiveKit Cloud      | Create a **staging** project (separate from production). Note its `wss://<project>.livekit.cloud` URL; create an API key/secret pair for staging only.                                                                                                             | project name, URL                                                               |
| X2  | LiveKit SIP        | On a laptop with the staging env: `npm run provision:sip` (dry run), review, then `npm run provision:sip -- --apply`. Creates inbound trunk (Vobiz signalling IPs, staging number only), dispatch rule `individual` prefix `call-` → agent `clickai-receptionist`. | trunk id, rule id, the dry-run plan                                             |
| X3  | LiveKit webhook    | Staging project → Settings → Webhooks: `https://clickai-staging.<subdomain>.workers.dev/api/public/webhooks/livekit` (signed with the project key).                                                                                                                | screenshot                                                                      |
| X4  | Vobiz              | One **test** number; inbound trunk/primary URI = the LiveKit SIP host; record the number's previous Voice Application id (rollback). Obtain Vobiz's published SIP signalling IPs for `VOBIZ_SIP_SIGNALING_IPS`.                                                    | number, previous application id, IP list source                                 |
| X5  | Sarvam             | A staging API key (STT `saarika`, TTS `bulbul:v3`); spending limit if available.                                                                                                                                                                                   | key name only                                                                   |
| X6  | Anthropic          | A staging API key with a spend limit.                                                                                                                                                                                                                              | key name only                                                                   |
| X7  | Cron secret        | Generate `VOICE_AGENT_CRON_SECRET` (`openssl rand -base64 48`); set on the staging Worker and in staging Vault as `clickai_staging_voice_cron_secret`.                                                                                                             | set (yes/no)                                                                    |
| X8  | Staging Vault      | `clickai_staging_base_url`, `clickai_staging_cron_secret` (`LOVABLE_CRON_SECRET`), `clickai_staging_voice_cron_secret`; then run `scripts/staging/schedule-cron.sql` in the **staging** SQL editor.                                                                | `select jobname, schedule from cron.job where jobname like 'clickai-staging-%'` |
| X9  | HMAC secret        | `VOICE_AGENT_HMAC_SECRET` (`openssl rand -base64 48`), same value on the Worker and the agent.                                                                                                                                                                     | set (yes/no)                                                                    |
| X10 | Container platform | Namespace `clickai-staging`, Secret `voice-agent-secrets` (agent variables, §5), image from §2, manifest rendered with `APP_ENV: staging` (STAGING.md §5 step 4).                                                                                                  | `kubectl get pods -n clickai-staging`                                           |
| X11 | Cloudflare WAF     | Rate-limit rules: `/api/internal/voice-agent/*`, `/api/public/webhooks/livekit` (~600/min/IP), `/api/public/cron/*` (~30/min/IP, any method).                                                                                                                      | rule ids                                                                        |
| X12 | Alerts             | RUNBOOK.md step 8 list (missing ticks, `tick_failed`, `room_sweep_*`, `cron_auth_failed` spikes, `call.cleanup_failed`); one test alert delivered.                                                                                                                 | alert ids, test delivery                                                        |

## 5. Environment variables (names only)

**Worker `clickai-staging`, build-time (Workers Builds variables):** `CLICKAI_DEPLOY_TARGET` (`staging`), `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`.

**Worker `clickai-staging`, runtime secrets:** `SUPABASE_SERVICE_ROLE_KEY`, `VOICE_AGENT_HMAC_SECRET`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `VOICE_AGENT_CRON_SECRET`, `LOVABLE_CRON_SECRET` (other sweeps). Rotation only: `VOICE_AGENT_HMAC_SECRET_PREVIOUS`, `VOICE_AGENT_CRON_SECRET_PREVIOUS`, `LOVABLE_CRON_SECRET_PREVIOUS`.

**Worker runtime variables:** `SUPABASE_URL`, `LIVEKIT_URL` (`wss://<staging>.livekit.cloud`), `VOICE_AGENT_NAME` (= agent `AGENT_NAME`, default `clickai-receptionist`). Optional: `VOICE_AGENT_MAX_CALL_SECONDS` (default 1800), `VOICE_AGENT_CRON_REQUIRE_SIGNED` (`true` once signing works; staging SQL signs), `LIVEKIT_ALLOWED_HOSTS` (self-hosted LiveKit only). **Leave unset:** `VOICE_AGENT_OUTBOUND_ENABLED` (outbound stays off); outbound-only: `VOICE_AGENT_OUTBOUND_ALLOWED_PREFIXES`, `VOICE_AGENT_OUTBOUND_BLOCKED_PREFIXES`, `VOICE_AGENT_OUTBOUND_MAX_CONCURRENT`, `VOICE_AGENT_OUTBOUND_DAILY_LIMIT`. (The rest of klyro's existing variables are unchanged by this work.)

**Agent (`voice-agent-secrets`):** required `APP_ENV` (`staging`; set through the rendered manifest, not the Secret), `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `SARVAM_API_KEY`, `ANTHROPIC_API_KEY`, `KLYRO_BASE_URL` (`https://clickai-staging.<subdomain>.workers.dev`), `VOICE_AGENT_HMAC_SECRET`. Optional: `VOICE_AGENT_HMAC_KEY_ID`, `AGENT_NAME`, `CLAUDE_MODEL`, `FALLBACK_LLM_BASE_URL`, `FALLBACK_LLM_API_KEY`, `FALLBACK_LLM_MODEL`, `MAX_CONCURRENT_SESSIONS`, `HEALTH_PORT`, `DRAIN_TIMEOUT_MS`, `KLYRO_TIMEOUT_MS`, `SILENCE_TIMEOUT_S`, `MAX_CALL_SECONDS` (≤ klyro's), `TURN_DETECTION`, `LIVEKIT_ALLOWED_HOSTS`. **Leave unset:** `SIP_OUTBOUND_TRUNK_ID` (outbound off).

**Provisioning laptop only (`npm run provision:sip`):** `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `APP_ENV`, `AGENT_NAME`, `SIP_INBOUND_NUMBERS` (the staging number only), `VOBIZ_SIP_SIGNALING_IPS`. Outbound only (not now): `VOBIZ_OUTBOUND_SIP_DOMAIN`, `VOBIZ_OUTBOUND_SIP_USERNAME`, `VOBIZ_OUTBOUND_SIP_PASSWORD`.

**Staging Supabase Vault:** `clickai_staging_base_url`, `clickai_staging_cron_secret`, `clickai_staging_voice_cron_secret`.

## 6. Deployment sequence, health checks, rollback

Prerequisites: §1 answered safely; §2 image built and verified offline; §3 build green; §4 X1–X9 done.

| Step | Action                                                                                                                       | Health check (must pass before the next step)                                                                                                                             |
| ---- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D0   | Run `scripts/staging/check-voice-agent-schema.sql` (read-only) in the **staging** SQL editor.                                | Every non-optional row `ok = true`; record the latest migration versions. (Verified to run without error and change nothing on a disposable PostgreSQL.)                  |
| D1   | **Agent first:** `kubectl -n clickai-staging apply` the rendered manifest (`APP_ENV: staging`, image tag); `rollout status`. | Pods Ready; `GET :8081/` 200; `GET :8081/worker` shows `agent_name: clickai-receptionist`, `active_jobs: 0`; logs show worker registration, no `verify`/model errors.     |
| D2   | **klyro:** Workers Builds deploys `feat/livekit-voice-agent` to `clickai-staging` (after X1–X9 secrets).                     | Unsigned `POST /api/internal/voice-agent/session` → **401** (503 = HMAC secret missing); unsigned `POST /api/public/cron/sweep-sip-rooms` → **401**; app home page loads. |
| D3   | **Cron:** run `schedule-cron.sql` (staging).                                                                                 | Within 5 min one `sip_room_sweep:tick` (`unconfigured: false`, `dbErrors: 0`); within 15 min one `sip_reconcile:tick`; no `voice_agent:cron_auth_failed`.                 |
| D4   | **LiveKit:** `provision:sip --apply` (staging number only), webhook URL set.                                                 | Dry-run plan matches; trunk lists only the staging number and Vobiz IPs.                                                                                                  |
| D5   | **WAF + alerts** (X11, X12).                                                                                                 | Test alert delivered.                                                                                                                                                     |
| D6   | **Vobiz [approval]:** point the staging test number at LiveKit.                                                              | First acceptance call (§7 A1).                                                                                                                                            |

Rollback (fastest first, each independent):

1. **Number:** re-link the staging number to its previous Vobiz Voice Application (instant); remove it from `SIP_INBOUND_NUMBERS`, `provision:sip -- --apply` (verified by read-back). Removing the LAST number is refused (`SIP_INBOUND_NUMBERS` must not be empty: an inbound trunk without numbers could match any number); to retire the path entirely, delete the trunk `clickai-vobiz-inbound` and the rule `clickai-receptionist` in the LiveKit dashboard.
2. **Agent:** `kubectl -n clickai-staging scale deploy/voice-agent --replicas=0` (active calls drain first, ≤ 31 min) or `kubectl rollout undo`.
3. **klyro:** redeploy the previous `clickai-staging` build from the Cloudflare dashboard. The new routes are inert without SIP traffic.
4. **Cron:** `select cron.unschedule('clickai-staging-sweep-sip-rooms'); select cron.unschedule('clickai-staging-reconcile-sip-calls');`.
5. **Database:** nothing to roll back (no migration is applied for inbound staging). If the index migration was applied: `DROP INDEX IF EXISTS public.idx_call_logs_livekit_inbound_answered; DROP INDEX IF EXISTS public.idx_call_logs_livekit_room;`.

Compatibility notes: the agent must be deployed before klyro (older agents work with newer klyro; the reverse is also safe but loses the per-call limit agreement). No schema change is required for inbound; the code only adds keys inside `call_logs.provider_metadata` (JSON).

## 7. Acceptance test matrix

Cost: **Free** = no external service; **Ext** = needs a configured external service but no paid call (API/dashboard); **Paid** = places a real phone call (approval required, one at a time, costs per STAGING.md §10). Logs: Worker logs + agent pod logs.

| ID  | Area                      | Test                                                                                                                                        | Expected                                                                                                                                       | Cost     |
| --- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| T1  | Authorization             | Unsigned / wrong-secret / replayed `POST /api/internal/voice-agent/session`                                                                 | 401 each; replay 401; no `call_logs` row                                                                                                       | Free*    |
| T2  | Authorization             | Unsigned, `LOVABLE_CRON_SECRET` bearer, forged and stale signatures on both voice cron routes                                               | 401 `{"error":"unauthorized"}`; logs show route + reason only                                                                                  | Free*    |
| T3  | Cron replay / rate limits | Same valid signed request twice; 8 valid runs in one minute; 11 bad attempts from one IP                                                    | 2nd → 401 (replayed); runs 7–8 → 429; 11th bad attempt → 429                                                                                   | Free*    |
| T4  | LiveKit webhook auth      | Unsigned / tampered webhook; valid captured webhook replayed                                                                                | 401; replay `200 {"duplicate":true}`, no second debit                                                                                          | Ext      |
| T5  | Schema                    | `check-voice-agent-schema.sql`                                                                                                              | all required rows ok                                                                                                                           | Ext      |
| T6  | Image                     | §2 offline commands                                                                                                                         | `verify-models: ok`; no model errors offline                                                                                                   | Ext      |
| T7  | LiveKit API (Cloud)       | On a staging room: `ListParticipants` (agent kind `AGENT`, caller `sip.callID`), `DeleteRoom` on a missing room, `ListRooms` `creationTime` | as documented in STAGING.md §6c criterion 3                                                                                                    | Ext      |
| A1  | Inbound, English          | Call the staging number; greeting; ask hours; hang up                                                                                       | one `call_logs` row `provider=livekit_sip`, `completed`, duration ≈ call; one wallet debit; `max_call_seconds` recorded; no transcript in logs | Paid     |
| A2  | Inbound, Hindi            | Speak only Hindi                                                                                                                            | greeting/replies in Hindi; `language` hi-IN                                                                                                    | Paid     |
| A3  | Inbound, Telugu           | Speak only Telugu (and Romanized Telugu)                                                                                                    | replies in Telugu; `language` te-IN                                                                                                            | Paid     |
| A4  | Language switch           | Start English, switch to Hindi                                                                                                              | agent follows the switch; one switch counted                                                                                                   | Paid     |
| A5  | Interruptions             | Interrupt the agent mid-sentence twice                                                                                                      | agent stops and listens; `turn.interrupted` events                                                                                             | Paid     |
| A6  | Silence                   | Stay silent after the greeting                                                                                                              | prompt after `SILENCE_TIMEOUT_S`, then polite hang-up; room deleted; billed once                                                               | Paid     |
| A7  | Booking                   | Book a test appointment end to end                                                                                                          | booking row created; `booking.result` ok; correct service/time                                                                                 | Paid     |
| A8  | Google Calendar           | A7 for a business with Calendar connected                                                                                                   | calendar event created; on sync failure the caller hears "saved", sweep retries                                                                | Paid+Ext |
| A9  | Caller hang-up            | Hang up mid-sentence                                                                                                                        | `completed`, billed once with LiveKit's duration                                                                                               | Paid     |
| A10 | Duplicate webhooks        | Re-POST the captured `participant_left` of A1                                                                                               | `duplicate: true`; no second debit                                                                                                             | Ext      |
| A11 | Agent crash               | `VOICE_AGENT_MAX_CALL_SECONDS=300` on staging; call; delete the agent pod with force                                                        | caller disconnected by ~10–15 min; row `failed`/`max_duration_exceeded`, `room_sweep=done`; no debit                                           | Paid     |
| A12 | Agent restart / drain     | `kubectl rollout restart` during a call                                                                                                     | the active call finishes (drain); new pod takes the next call                                                                                  | Paid     |
| A13 | Room cleanup failure      | Test pod with a revoked LiveKit key; end a call normally                                                                                    | `call.cleanup_failed`; agent leaves; sweep disconnects the caller within ~10 min; billed once with the agent-reported duration                 | Paid     |
| A14 | Orphan room               | Call an unknown/unentitled staging number with the agent's room deletion disabled                                                           | refusal message; room deleted after 10–15 min by the orphan sweep; no billing                                                                  | Paid     |
| A15 | Billing accuracy          | Compare A1, A6, A9, A11, A13 debits with `duration_seconds` and pricing                                                                     | exactly one debit per billed call; none for A11/A14; amounts match the pricing rules                                                           | Ext      |
| A16 | Entitlement refusal       | Call with the test organization's wallet empty / plan blocked                                                                               | denial message; row `failed` (`not_entitled`); no debit                                                                                        | Paid     |
| A17 | LiveKit API outage        | Wrong `LIVEKIT_URL` host on the staging Worker for 35 min (agent unaffected)                                                                | sweep 503 `livekit_url_rejected` (or retries + one `room_sweep_failed` with a reachable-but-wrong project); recovers after restore             | Ext      |
| A18 | Database outage           | Revoke/rotate the staging service-role key briefly (staging only)                                                                           | routes answer 5xx; sweep `tick_failed` 500 (DB error, not "nothing to do"); agent rejects new calls politely; recovery after restore           | Ext      |
| A19 | klyro outage              | Agent's `KLYRO_BASE_URL` wrong on one test pod; call                                                                                        | caller hears the unavailable message; no row; orphan sweep removes the room                                                                    | Paid     |
| A20 | Outbound stays off        | As owner, call `startAgentOutboundCall`                                                                                                     | "AI outbound calling is not enabled"; no row, no dispatch                                                                                      | Ext      |

\* Free once the staging Worker is deployed (requests to it cost nothing); run locally they are already covered by the automated tests.

Pass criteria for staging sign-off: T1–T7 and A1–A20 pass; no `voice_agent:room_sweep_mismatch`/`invalid_room`/`expired`, no `tick_failed`, no double debit over 24 h of staging traffic.

## 7a. Phase 2.14 go-live review: findings and extra checks

**Fixed in Phase 2.15: provisioning updates.** `provision:sip` previously sent empty updates for an existing trunk/rule (plain arrays where livekit-server-sdk expects `ListUpdate`: `{"update":{"numbers":{},"allowedAddresses":{}}}`) and printed `applied`. It now sends `ListUpdate { set }` (`{"update":{"numbers":{"set":["+91…"]},"allowedAddresses":{"set":["…"]}}}`; an empty list is `{ clear: true }`), changes the dispatch rule's trunk binding with `ListUpdate` and its agent/room shape with a full replace built from the rule as read, reads both back after applying and exits non-zero on any difference. It refuses an empty number list, duplicate managed objects and invalid IPs, never creates an outbound trunk without `--with-outbound`, and is idempotent (a second run changes nothing). Code: `deploy/livekit/sip-provisioning.ts`; tests: `tests/sip-provisioning.spec.ts` (the real SDK client against an in-process model of LiveKit's SIP API; LiveKit itself not exercised).

**Extra checks for the deployment sequence (§6):**

- D2: the Worker's runtime `SUPABASE_URL` host must equal the staging `VITE_SUPABASE_URL` host (a staging frontend with a production backend would be invisible otherwise): compare both in the Cloudflare dashboard.
- D3: no `voice_agent:cron_legacy_auth` warning in the Worker logs (it means `VOICE_AGENT_CRON_SECRET` is unset and the shared secret still opens the voice cron routes); then set `VOICE_AGENT_CRON_REQUIRE_SIGNED=true` (the staging scheduler signs).
- D1/D4: the LiveKit URL, key and webhook all belong to the **staging** LiveKit project (dashboard project name); the agent and klyro must use the same project.
- Cost caps before any paid test: spending limits on Sarvam, Anthropic, LiveKit and Vobiz; `MAX_CONCURRENT_SESSIONS` and HPA `maxReplicas` reduced for staging (e.g. 2 / 2).

**Further safeguards recommended (not blockers for a controlled staging test):** a Kubernetes NetworkPolicy limiting agent egress to LiveKit, Sarvam, Anthropic and the staging Worker; secrets from a secret manager instead of a plain Kubernetes Secret; an image vulnerability scan / SBOM at build time; Docker BuildKit for the build (default; it only transfers the files the Dockerfile copies, verified at 34 KB of context; the legacy builder would send the whole repository, including any local `.env` files, because there is no root `.dockerignore`).

## 8. Risks

- LiveKit Cloud behaviour (participant kinds, 404 on missing rooms, ListRooms fields, SIP hang-up on room deletion, inbound `max_call_duration`) is inferred from open-source code; T7/A11/A13 must confirm it.
- Migration automation is unknown until §1 is answered; until then a push or merge that includes the migration files could apply them.
- The image's model size and offline behaviour are unmeasured (T6).
- Vobiz signalling IPs, SIP attribute formats and the number-to-trunk procedure are unverified until A1.
- The voice cron routes accept the shared `LOVABLE_CRON_SECRET` only while `VOICE_AGENT_CRON_SECRET` is unset (with a warning); set it before exposure.
- Paid tests are needed to validate billing, crash recovery and cleanup; costs per STAGING.md §10.
