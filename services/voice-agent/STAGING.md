# Staging runbook: LiveKit SIP voice agent

> **Phase 2.13:** the consolidated deployment checklist, environment-variable list, acceptance matrix and rollback are in [STAGING_DEPLOYMENT.md](STAGING_DEPLOYMENT.md). This file keeps the detailed background.

Scope: the `clickai-staging` Worker + staging Supabase + a LiveKit **dev/staging** project + one Vobiz **test** number.
Nothing here touches production, production numbers or production traffic.
Steps marked **[approval]** spend money or change call routing: do them only with explicit approval.

Status words used below: **verified** = done and observed in this repository's sandbox; **unverified** = needs credentials or external access we did not have.

## 0. Prerequisites (who provides what)

| Item                                                                                                                                                     | Owner / access needed | Status                                                                             |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | ---------------------------------------------------------------------------------- |
| Cloudflare Workers Builds for `clickai-staging` builds this branch successfully                                                                          | Cloudflare dashboard  | **failing** (see §1)                                                               |
| Staging Supabase with all migrations applied, **plus `20261102090000_voice_agent_outbound_reservation.sql` for outbound** (not executed; needs approval) | Supabase dashboard    | unverified                                                                         |
| LiveKit Cloud project for dev/staging (URL, API key/secret)                                                                                              | LiveKit account       | unverified                                                                         |
| Vobiz test number + SIP trunk (inbound IP allow-list, outbound digest creds)                                                                             | Vobiz console         | unverified                                                                         |
| Sarvam API key (STT `saarika`, TTS `bulbul:v3`)                                                                                                          | Sarvam dashboard      | unverified                                                                         |
| Anthropic API key                                                                                                                                        | Anthropic console     | unverified                                                                         |
| Container runtime (k8s namespace `clickai-staging` or a VM with Docker)                                                                                  | infra                 | unverified                                                                         |
| Container registry                                                                                                                                       | infra                 | unverified                                                                         |
| huggingface.co reachable from the image build host                                                                                                       | build host network    | unreachable from this sandbox; use `TURN_DETECTION=vad` if it must be skipped (§4) |

## 0a. Before ANY push of this branch: migration automation (H-A)

`supabase/migrations/20261102090000_voice_agent_outbound_reservation.sql` is outbound-only and must not reach a database without approval. Nothing in this repository applies migrations (CI only uses disposable local clusters; `supabase/config.toml` has only `project_id`; the docs apply migrations by hand with `supabase db push --db-url` or the SQL editor). But two dashboard-only settings, not visible in the repo, could apply it on push:

- **Supabase → Project Settings → Integrations → GitHub:** if connected with "Deploy to production" enabled, pushes/merges to the production branch run `supabase/migrations`; with **Branching** enabled, preview branches run them too ([Supabase GitHub integration](https://supabase.com/docs/guides/deployment/branching/github-integration)).
- **Lovable** (two-way GitHub sync of the default branch): no official statement found on applying externally pushed migration files.

Until both are confirmed off, keep the migration file uncommitted (inbound does not need it).

**Owner checklist (the project owner, not an agent, confirms each item, for BOTH the production and the staging Supabase projects, before any push that contains a file under `supabase/migrations/`):**

1. Supabase Dashboard → the project → Project Settings → Integrations → **GitHub**: is a repository connected? If yes, record (a) which repository, (b) the **Production branch** name, (c) whether **"Deploy to production"** (apply migrations on push/merge to that branch) is ON, (d) the **Supabase directory** setting (default `supabase`, so `supabase/migrations` is what it applies).
2. Same page / Project Settings → **Branching**: is Branching enabled? If yes, pushes of ANY branch with an open PR can create a preview branch that runs every migration on a preview database (paid compute; not production data, but the migration still runs).
3. If (c) is ON and the production branch is the branch Lovable syncs (normally `main`): merging a PR that contains the migration **applies it to production**. Either turn it off first, or do not merge migration files until approved.
4. **Lovable** project → Settings → GitHub / Supabase integration: confirm whether Lovable's Supabase connection points at the live project (`eorazvlmqwunmhwviocn`) or the old `blr…` project, and whether Lovable applies SQL migration files that arrive via GitHub sync (there is no official documentation; ask Lovable support or test with a no-op migration on a throwaway project). Lovable's own editor writes migrations it proposes only after the user clicks "apply" in its UI; externally pushed files are the open question.
5. Supabase Dashboard → Database → **Migrations** (or `supabase_migrations.schema_migrations`): record the latest applied version in each project, so any unexpected application is detectable afterwards.
6. Write the answers down (who, when, screenshot). Only then may the migration be committed, and only to a branch whose push cannot reach a database (feature branch, no PR, Branching off) until outbound is approved.

If any answer is "unknown", treat it as "applies automatically".

**Evidence gathered in Phase 2.12 (repository and GitHub only; the Supabase and Lovable dashboards and docs are not reachable from this environment):**

| Fact                                                                                                                                                                        | Status                                                        |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| No GitHub Actions workflow runs the Supabase CLI (`.github/workflows/test.yml`, `voice-agent.yml`: no `supabase db push/link`, no access token)                             | verified                                                      |
| `supabase/config.toml` contains only `project_id`; no branching/remotes configuration in the repository                                                                     | verified                                                      |
| PR #4 (2026-09-11) added `supabase/migrations/20260911090000_demo_requests_admin_crm.sql`; its only check was "Workers Builds: klyro" and its only bot comment Cloudflare's | verified: no Supabase Preview check/comment on that PR        |
| PR #5 (2026-10-31): only the GitHub Actions `test` check, no comments                                                                                                       | verified                                                      |
| Supabase Branching enabled today                                                                                                                                            | **unknown** (PR #4 suggests it was not enabled on 2026-09-11) |
| Supabase GitHub integration "Deploy to production" on the production branch                                                                                                 | **unknown** (it does not comment on PRs; dashboard only)      |
| Lovable applying migration files that arrive via GitHub sync                                                                                                                | **unknown** (no official documentation reachable)             |

Conclusion: not conclusively safe. Both migration files stay untracked; the checklist above remains required.

## 1. Fix the `clickai-staging` build first

Observed: the GitHub check `Workers Builds: clickai-staging` failed on `29a7f6d`, `935f3b3` and `1b62bc9`, while `klyro` built `935f3b3` successfully. The checks carry no log text, so the exact error must be read in the Cloudflare dashboard (Workers & Pages > clickai-staging > Deployments > the failed build > View logs).

Most likely cause (**configuration**, not code): the repository's `wrangler.json` names the Worker `klyro`. The staging project must build with `CLICKAI_DEPLOY_TARGET=staging`, which renames the generated `.output/server/wrangler.json` to `clickai-staging` (verified locally: build exit 0, name `clickai-staging`, both Durable Objects and migrations present). Without it, the deploy step targets a Worker named `klyro` from the staging project.

In the staging Workers Builds project settings:

1. Build variables: `CLICKAI_DEPLOY_TARGET=staging`, `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` (the **staging** project's public values; build-time, not runtime).
2. Branch control: build only the branch under test (here `feat/livekit-voice-agent`), not every branch.
3. Re-run the build and confirm the log shows the Worker name `clickai-staging`.

If the log shows something else (for example an auth or account error), the classification changes. Send the log text before changing anything else.

**Phase 2.7 evidence (local, this branch, no deploy).** The root cause is NOT yet proven: the GitHub check (`124961033510`, build `194e5556-…`) still carries no log text, its start and end times are equal for successful `klyro` builds too (so they say nothing about where it failed), and this environment has no Cloudflare credentials. Two repository-side failure modes are proven; the build log decides which one applies:

| Staging build configuration                                 | Local result                                                                                                                       | What the Cloudflare log would show                                                               |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `VITE_SUPABASE_URL` / `VITE_SUPABASE_PUBLISHABLE_KEY` unset | `vite build` exit 1: `Build-time environment variable(s) missing: VITE_SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY` (repo guard)   | that exact message, during the build command                                                     |
| both set, `CLICKAI_DEPLOY_TARGET` unset                     | build exit 0; `.wrangler/deploy/config.json` → `.output/server/wrangler.json` with `name: "klyro"`; `wrangler deploy --dry-run` ok | a Worker-name mismatch at the deploy step (the project is `clickai-staging`, the config `klyro`) |
| both set, `CLICKAI_DEPLOY_TARGET=staging`                   | build exit 0; generated `name: "clickai-staging"`, both Durable Objects; `wrangler deploy --dry-run` ok                            | expected to pass                                                                                 |

No repository change fixes either: the build is the same source for both Workers (`klyro` and `clickai-staging`), so the staging name and the staging Supabase values have to come from the staging project's own build variables. (Whether Workers Builds injects any variable naming the target Worker was not checked: developers.cloudflare.com is not reachable from this environment. Relying on such a variable would also silently change production builds, so it is not proposed.) If the log shows neither message, the cause is outside this repository (token, account, branch control).

## 2. Configuration

### klyro (`clickai-staging` Worker): runtime variables and secrets

| Name                               | Kind     | Value / rule                                                                                                                                                                              |
| ---------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VOICE_AGENT_HMAC_SECRET`          | secret   | ≥ 32 random bytes (`openssl rand -base64 48`). The same value goes to the agent. Unset: internal routes answer 503.                                                                       |
| `VOICE_AGENT_HMAC_SECRET_PREVIOUS` | secret   | Only during a rotation.                                                                                                                                                                   |
| `LIVEKIT_URL`                      | variable | `wss://<staging project>.livekit.cloud`                                                                                                                                                   |
| `LIVEKIT_API_KEY`                  | secret   | LiveKit staging project key. Verifies webhooks and signs outbound dispatches.                                                                                                             |
| `LIVEKIT_API_SECRET`               | secret   | LiveKit staging project secret.                                                                                                                                                           |
| `VOICE_AGENT_NAME`                 | variable | Must equal the agent's `AGENT_NAME` (default `clickai-receptionist`).                                                                                                                     |
| `VOICE_AGENT_OUTBOUND_ENABLED`     | variable | Leave **unset** until outbound smoke tests are approved. It is a kill switch only; authorization is always owner/admin.                                                                   |
| `LOVABLE_CRON_SECRET`              | secret   | Already used by the other staging sweeps.                                                                                                                                                 |
| `VOICE_AGENT_MAX_CALL_SECONDS`     | variable | Optional, default 1800 (60..7200). klyro's maximum inbound call duration; returned to the agent at session start; the room sweep acts 5 min after it (§6c).                               |
| `VOICE_AGENT_CRON_SECRET`          | secret   | ≥ 32 random chars. Credential of the two voice cron routes (§6d); the shared `LOVABLE_CRON_SECRET` no longer opens them. Staging Vault: `clickai_staging_voice_cron_secret` = same value. |
| `VOICE_AGENT_CRON_SECRET_PREVIOUS` | secret   | Only during a rotation.                                                                                                                                                                   |
| `VOICE_AGENT_CRON_REQUIRE_SIGNED`  | variable | `true` = signed requests only (no route bearer tokens). Recommended once the scheduler signs (staging SQL does).                                                                          |
| `LIVEKIT_ALLOWED_HOSTS`            | variable | Only for self-hosted LiveKit: exact extra hosts. Otherwise `LIVEKIT_URL` must be `wss://<project>.livekit.cloud` (§6d).                                                                   |

### Agent (`services/voice-agent`): environment

Names and defaults are in `services/voice-agent/.env.example`; values live only in the secret store (`voice-agent-secrets` in k8s).
The process validates its configuration at start-up and refuses to start on a bad config without echoing any value.

Required: `APP_ENV=staging`, `LIVEKIT_URL` (wss), `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `SARVAM_API_KEY`, `ANTHROPIC_API_KEY`, `KLYRO_BASE_URL` (https, the staging Worker), `VOICE_AGENT_HMAC_SECRET`.
Optional: `SIP_OUTBOUND_TRUNK_ID` (needed for outbound; without it outbound dials are refused and the call row is closed as failed), `CLAUDE_MODEL` (default `claude-sonnet-4-6`), `TURN_DETECTION`, `MAX_CONCURRENT_SESSIONS`, timeouts.
Provisioning-only (laptop/CI, not the pod): `VOBIZ_SIP_SIGNALING_IPS`, `VOBIZ_OUTBOUND_SIP_DOMAIN`, `VOBIZ_OUTBOUND_SIP_USERNAME`, `VOBIZ_OUTBOUND_SIP_PASSWORD`, `SIP_INBOUND_NUMBERS`.

## 3. Network requirements

| From          | To                                                            | Port / protocol                                          | Why                                                           |
| ------------- | ------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------- |
| agent pod     | LiveKit Cloud                                                 | 443 wss/https                                            | worker registration, rooms, SIP API                           |
| agent pod     | `api.sarvam.ai`                                               | 443                                                      | STT/TTS streaming                                             |
| agent pod     | `api.anthropic.com`                                           | 443                                                      | LLM                                                           |
| agent pod     | staging Worker host                                           | 443                                                      | signed internal API                                           |
| LiveKit Cloud | staging Worker `/api/public/webhooks/livekit`                 | 443                                                      | signed webhooks (billing)                                     |
| Vobiz         | LiveKit SIP endpoint                                          | SIP 5060/UDP-TCP or 5061/TLS + RTP media range (LiveKit) | inbound calls; LiveKit restricts to `VOBIZ_SIP_SIGNALING_IPS` |
| LiveKit SIP   | Vobiz outbound domain `<trunk>.sip.vobiz.ai`                  | SIP + RTP                                                | outbound calls (digest auth)                                  |
| image build   | registry (Docker Hub or `mirror.gcr.io`), npm, huggingface.co | 443                                                      | base image, packages, turn-detector model                     |

The pod needs **no inbound** ports except the health port (8081) from the cluster.

## 4. Build the image

```sh
# From the repository root. Base image pinned by digest (same bytes on both registries; verified 2026-11-02).
docker build -f services/voice-agent/Dockerfile -t REGISTRY/clickai-voice-agent:$GIT_SHA .
# Docker Hub rate limit (429)? Same digest from Google's Docker Hub mirror:
docker build --build-arg BASE_REGISTRY=mirror.gcr.io/library -f services/voice-agent/Dockerfile -t REGISTRY/clickai-voice-agent:$GIT_SHA .
docker push REGISTRY/clickai-voice-agent:$GIT_SHA
```

The build needs huggingface.co (the turn-detector model) and github.com (tini, pinned by SHA-256). After `download-files`, `deploy/prepare-model-cache.mjs` makes the tokenizer loadable offline (@huggingface/transformers 4.2.0 looks up `tokenizer_config.json` under the "main" cache key, which download-files does not write; without this an offline pod fails to load the turn detector, and a pod with network fetches from huggingface.co on every start). The build **fails** unless every asset the runtime loads (ONNX model, `languages.json`, tokenizer) loads offline as the `node` user (`deploy/verify-models.mjs`, the runtime's own loaders, remote access disabled). Only for an image that will run with `TURN_DETECTION=vad`, pass `--build-arg VERIFY_TURN_DETECTOR=0`.

What was verified in the sandbox (huggingface.co and deb.debian.org are blocked there; the build used a copy of this Dockerfile that differs only in (a) mounting the sandbox proxy CA for `npm ci` and (b) skipping `download-files`):

- base image from `mirror.gcr.io` by digest; tini fetched by `ADD --checksum` (SHA-256 matched); `npm ci` from the lockfile;
- with `VERIFY_TURN_DETECTOR=1` the build **fails** at `verify-models: FAILED` (models absent): the guard works;
- with `VERIFY_TURN_DETECTOR=0`: image builds; `ENTRYPOINT ["/usr/local/bin/tini","--"]`, user `node`, tini 0.19.0 with the pinned hash;
- SIGTERM at 0.3 s, 1 s, 3 s, 6 s, 9 s, 15 s and 30 s after start: every container exits 143 within seconds (before: hung until SIGKILL at ≤ 6 s). See PRODUCTION_READINESS.md §H3.

**Phase 2.6 (2026-11-02), real build attempted, BLOCKED, not passed:** the unmodified Dockerfile stopped at `npm ci` (the sandbox's TLS-intercepting proxy is not trusted inside the build; npm "Exit handler never called!"). A copy that only mounts the sandbox proxy CA as a build secret got past `npm ci` and failed at `npx livekit-agents download-files`: `Unable to fetch file metadata for "https://huggingface.co/livekit/turn-detector/resolve/main/tokenizer_config.json"` → `FATAL … turn-detector (@livekit/agents-plugin-livekit@1.9.5)`, build exit 1. The sandbox egress policy answers 403 to CONNECT for huggingface.co, hf.co, cdn-lfs.huggingface.co, cdn-lfs-us-1.hf.co and cas-bridge.xethub.hf.co. No image was produced; no synthetic assets were substituted. The `clickai-voice-agent:p22/p23/verify` images in that sandbox were built with `VERIFY_TURN_DETECTOR=0` and contain no model files: they are NOT valid staging images.

Required on a build host that can reach `huggingface.co` (and its LFS/Xet CDNs: `cdn-lfs*.hf.co`, `cas-bridge.xethub.hf.co`), npm, Docker Hub or `mirror.gcr.io`, and github.com:

```sh
docker build -f services/voice-agent/Dockerfile -t clickai-voice-agent:$GIT_SHA .   # must print "verify-models: ok", no build args
docker image inspect clickai-voice-agent:$GIT_SHA --format '{{.Size}}'
docker run --rm --user node --entrypoint sh clickai-voice-agent:$GIT_SHA -c 'ls -lR /home/node/.cache/huggingface | head; ls -l node_modules/@huggingface/transformers/.cache/livekit/turn-detector'
docker run --rm --network none clickai-voice-agent:$GIT_SHA node deploy/verify-models.mjs    # offline, as node: "verify-models: ok"
# Full worker start offline (inference process loads the turn detector; LiveKit connection is expected to fail, nothing else):
docker run --rm --network none -e APP_ENV=staging -e LIVEKIT_URL=wss://offline.invalid -e LIVEKIT_API_KEY=x -e LIVEKIT_API_SECRET=xxxxxxxxxxxxxxxxxxxx \
  -e SARVAM_API_KEY=x -e ANTHROPIC_API_KEY=x -e KLYRO_BASE_URL=https://offline.invalid -e VOICE_AGENT_HMAC_SECRET=$(openssl rand -hex 24) \
  clickai-voice-agent:$GIT_SHA   # expect no huggingface/"tokenizer_class"/"localFileOnly" errors before the LiveKit connection error; stop with Ctrl-C
```

Pinned versions this build uses: base `node:22.11-bookworm-slim@sha256:f035ba7f…3c12da` (Node v22.11.0), tini 0.19.0 (SHA-256 pinned), `@livekit/agents` and all plugins 1.9.5, `@livekit/rtc-node` 1.2.1, `livekit-server-sdk` 2.19.2, `@huggingface/transformers` 4.2.0, `onnxruntime-node` 1.24.3, turn-detector repo `livekit/turn-detector` revision `v0.4.1-intl` (`onnx/model_q8.onnx`, `languages.json`, tokenizer). Note: `download-files` logs that the text-based turn detector is deprecated in favour of `@livekit/agents` inference `TurnDetector`; not a blocker for 1.9.5, track before upgrading.

**Not verified here:** a build with the REAL model files (needs huggingface.co). The success path of `verify-models.mjs` is verified only with synthetic assets in the exact cache layout (tests/verify-models.spec.ts). Do one `docker build` without build args on the build host before staging, then start a pod with no egress to huggingface.co.

Provider failure (H-B): if the conversation session closes for any reason other than the caller hanging up (repeated STT/LLM/TTS failures, job shutdown), the agent speaks a short apology in the caller's language (skipped if TTS failed; at most 6 s), then deletes the room (fallback: removes the caller), retried 4 times; `call.cleanup_failed` in the logs means the caller may still be connected (alert on it).

Inbound numbers (M-A): klyro normalizes the called and caller numbers from LiveKit's SIP attributes: `+91XXXXXXXXXX`, `91XXXXXXXXXX`, `0XXXXXXXXXX` and `XXXXXXXXXX` (10-digit subscriber number starting 2-9) become `+91XXXXXXXXXX`; valid foreign E.164 is kept; anything else (toll-free 1800/1860/1900, `00` prefix, ambiguous lengths, withheld IDs) is not guessed (called -> unknown number, caller -> no caller ID).

Shutdown (H3): tini is PID 1 (Node as PID 1 ignored an early SIGTERM). The worker's watchdog (`src/runtime/shutdown.ts`) ends the process within ~5–7 s of SIGTERM when no call is active, also in the two @livekit/agents start-up races (signal before `AgentServer.run()`, signal during process-pool warm-up) that otherwise wait forever. The active-call count is read in-process from the AgentServer (no HTTP self-probe); an unavailable count after it was once known is treated as "calls active". With calls active it waits for them (drain). `DRAIN_TIMEOUT_MS` (default 31 min) must cover `MAX_CALL_SECONDS` (default 30 min) + 60 s (enforced at start-up); the hard cap is `DRAIN_TIMEOUT_MS` + 30 s = 1890 s, below the pod's 1920 s grace period.

## 5. Deploy (staging)

1. **klyro:** let Workers Builds deploy the branch to `clickai-staging` (after §1). Set the secrets from §2. With `VOICE_AGENT_HMAC_SECRET` unset, the internal routes answer 503 (fail closed).
2. **Cron** (Supabase SQL editor of the **staging** project): run `scripts/staging/schedule-cron.sql`. The Vault URL must be exactly `https://clickai-staging.<subdomain>.workers.dev`; the helper re-checks that host (and a fixed list of routes) on **every** run, so a later Vault edit cannot redirect the jobs. It also schedules `clickai-staging-reconcile-sip-calls` every 15 minutes and `clickai-staging-sweep-sip-rooms` (the independent call-duration backstop, §6c) every 5 minutes. Undo is in the file header.
3. **Cloudflare WAF (edge rate limit, REQUIRED before production, recommended for staging):** rate-limiting rules on the zone, counting by IP (IPv6 by /64 if the plan offers it): e.g. 600 requests/min for `/api/internal/voice-agent/*`, 600/min for `/api/public/webhooks/livekit`, 60/min for the outbound server function path. This is the volumetric protection. The Worker's own limiter verifies signatures first and only limits sources that keep FAILING authentication (per isolate, best effort); a validly signed request is never refused by it, and clock-skew rejections are not counted, so it cannot lock out the agent or LiveKit (§7).
4. **Agent:** `kubectl -n clickai-staging apply -f services/voice-agent/deploy/k8s/voice-agent.yaml` with the image tag, then `kubectl -n clickai-staging rollout status deploy/voice-agent`. **The manifest sets `APP_ENV: production` in `env`, and `env` overrides the same key from `envFrom` (the Secret), so putting `APP_ENV=staging` in `voice-agent-secrets` has no effect.** Impact if left as is: low (in the agent, `APP_ENV` only drives start-up validation; `production` additionally refuses a localhost `KLYRO_BASE_URL`), but logs and runbooks would mislabel the environment. Safest staging-only correction (the shared manifest, which production uses, stays unchanged, and no pod ever starts with the wrong value, unlike a `kubectl set env` after `apply`, which first rolls out `production`): render a staging copy at apply time.

```sh
sed -e 's#{ name: APP_ENV, value: production }#{ name: APP_ENV, value: staging }#' \
    -e "s#REGISTRY/clickai-voice-agent:GIT_SHA#$REGISTRY/clickai-voice-agent:$GIT_SHA#" \
    services/voice-agent/deploy/k8s/voice-agent.yaml > /tmp/voice-agent.staging.yaml
grep -c 'value: staging' /tmp/voice-agent.staging.yaml        # must print 1
kubectl -n clickai-staging apply --dry-run=server -f /tmp/voice-agent.staging.yaml
kubectl -n clickai-staging apply -f /tmp/voice-agent.staging.yaml
```

For a small staging cluster, also consider `replicas: 1` and HPA `minReplicas: 1` (each pod requests 2 CPU / 3 GiB). Check with `kubectl -n clickai-staging get deploy voice-agent -o jsonpath='{.spec.template.spec.containers[0].env}'`.

5. **LiveKit SIP:** `npm run provision:sip` (dry run, prints the plan), review it, then `npm run provision:sip -- --apply` (applies, reads back, exits non-zero on any difference). `SIP_INBOUND_NUMBERS` contains only the staging test number. Outbound (not approved): only with `--with-outbound` and `VOBIZ_OUTBOUND_SIP_DOMAIN`; then set the printed outbound trunk id as the agent's `SIP_OUTBOUND_TRUNK_ID`. **Unverified:** whether Vobiz requires the outbound trunk to list the caller-ID numbers (`numbers`); the agent passes the organization's number as `fromNumber` on every dial.
6. **LiveKit webhook:** in the LiveKit staging project, set the webhook URL to `https://<staging host>/api/public/webhooks/livekit`. It is signed with the project's API key.
7. **Vobiz [approval]:** point only the staging test number at the inbound trunk whose primary URI is the LiveKit SIP host. Record the number's previous Voice Application id for rollback.

## 6. Health checks

- Agent: `GET :8081/` returns 200 only when the worker is connected to LiveKit and its inference process runs; `GET :8081/worker` shows `agent_name` and `active_jobs`. The k8s readiness and liveness probes use these.
- klyro: an unsigned `POST /api/internal/voice-agent/session` returns **401** (configured) or **503** (secret missing); never 200.
- Reconcile cron: one `sip_reconcile:tick` log line every 15 minutes in the Worker logs, carrying `{ notDialed, dialNotCompleted, endEventMissing, billedFromAgentReport, billingRetried, deferred }` (rows actually changed). A missing tick means the schedule is not running. `endEventMissing` or `billedFromAgentReport` > 0 means LiveKit end events are being lost: check the webhook URL and the `livekit_webhook:*` logs. `deferred` > 0 for several runs means more billing recoveries than one run handles (4 per run, to stay within the Workers subrequest budget).
- Outbound: `voice_agent:outbound_dispatch` with `outcome` dispatched / rejected / unknown; `voice_agent:outbound_claim_refused` (a duplicate dispatch losing the claim is normal and harmless).
- Agent shutdown: a `shutdown.watchdog_exit` log line with `reason` idle (normal) or hard_cap (a call outlived the drain timeout).
- Rate limiting: `voice_agent:rate_limited` / `livekit_webhook:rate_limited` mean a source kept failing authentication (or a shared per-call limit was hit); any sustained rate means abuse or a mis-sized limit.

### 6a. Alerts (none are configured in this repository; set them up in the log platform)

The agent writes one JSON line per event to stdout (`{ts, event, call_id, sip_call_id, room, t_ms, …}`, values redacted). Room-cleanup events and suggested alerts:

| Event                                                   | Meaning                                                                         | Suggested alert                                   |
| ------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------- |
| `call.cleanup_failed`                                   | all disconnect attempts failed: **the caller may still be connected, silently** | page on ANY occurrence; end the room by hand      |
| `room.disconnect_failed`                                | one disconnect attempt failed (retried 0/1/3/8 s)                               | warn if > 5 in 10 min                             |
| `room.delete_failed`                                    | room deletion after a failed outbound dial failed                               | warn on any (outbound only)                       |
| `call.aborted` (with `error_type`)                      | provider failure ended the call                                                 | warn if > 3 in 10 min, or > 5 % of calls per hour |
| `call.apology_failed`                                   | apology TTS failed or timed out (6 s)                                           | warn if > 3 in 10 min                             |
| `klyro.end_failed`                                      | session-end report to klyro failed (the reconcile sweep closes the row)         | warn on any                                       |
| `shutdown.watchdog_exit` with `reason=hard_cap`         | a call outlived the drain timeout                                               | warn on any                                       |
| Worker: missing `sip_reconcile:tick` for 30 min         | reconcile cron not running                                                      | warn                                              |
| Worker: `sip_reconcile:tick` with `endEventMissing` > 0 | LiveKit end webhooks are being lost                                             | warn                                              |

Gap (Phase 2.7): the repository has no metrics endpoint and no alert rules; these alerts exist only once configured in the log platform. Example log-based rule for the critical one: `event = "call.cleanup_failed"`, count ≥ 1 in 1 min → page; the line carries `call_id`, `sip_call_id`, `room` and `reason` for manual cleanup (LiveKit Cloud dashboard → Rooms → the room → remove the participant / close the room). Automatic backstop since Phase 2.9: klyro's room sweep (§6c) disconnects such a caller within ~10 min of the agent's end report, or at klyro's maximum call duration + 10 min when the agent never reported the end. Before production, test that alert path once in staging (e.g. with a revoked LiveKit API key on a test pod).

Kubernetes: alert on pod restarts > 2/h and on readiness failing for > 2 min (the readiness probe is 200 only when connected to LiveKit with the inference process running).

### 6b. Failed room cleanup: failure modes and independent call-duration safeguards (Phase 2.8 audit, Phase 2.9 status)

Today's limits, from the code and the installed SDKs (`livekit-server-sdk` 2.19.2, `@livekit/protocol` 1.53.1):

| Call     | Limit today                                                                                                                                                   | Independent of the agent process?                                |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| outbound | `CreateSIPParticipant.maxCallDuration = MAX_CALL_SECONDS` (`call.ts` dialOutbound): enforced by LiveKit's SIP service                                         | yes (provider-side; enforcement not yet observed on a live call) |
| inbound  | the agent's own timer (`call.ts`: `end("max_duration")` after `MAX_CALL_SECONDS`), which uses the SAME delete-room / remove-participant path that can fail    | **no**                                                           |
| both     | reconcile sweep: after 180 min without an end event the `call_logs` row is closed `livekit_end_event_missing` (unbilled); **the LiveKit room is not touched** | DB only                                                          |

Failure modes in which a caller stays connected with nobody answering:

1. Delete-room and remove-participant both fail (LiveKit API unreachable from the pod, revoked or rotated API key, LiveKit API outage): `call.cleanup_failed` is logged (alertable).
2. The job process dies before cleanup (OOM kill, SIGKILL, node loss): no cleanup and **no `call.cleanup_failed` line**; only the pod restart is visible. Whether LiveKit reassigns the job or ends the room is not established (docs not reachable from this environment).
3. The pod loses network: as 1, but the log line may not be shipped until the network returns.
4. The agent waits on a framework call that never returns: the max-duration timer still fires, but ends through the same path as 1.

In all four, the caller (and LiveKit SIP + Vobiz minutes, which are billed by the providers even though klyro does not bill the row) continues until the caller hangs up or the carrier ends the call.

Safeguards (Phase 2.9):

- **B. klyro room sweep: IMPLEMENTED** (`src/lib/voice-agent/room-sweep.server.ts`, cron `POST /api/public/cron/sweep-sip-rooms` every 5 min). Independent of the agent process and its network. Details, alerts, manual recovery and acceptance criteria: §6c.
- **A. LiveKit inbound-trunk `max_call_duration`: NOT implemented (unresolved questions below).** Verified from source: the field exists (`SIPInboundTrunkInfo` field 12, in the SDK's own `@livekit/protocol` 1.51.0); open-source LiveKit applies it to inbound calls (`livekit/protocol` `sip.go` copies `trunk.MaxCallDuration` into the dispatch result; `livekit/sip` `inbound.go` wraps the call in `context.WithTimeout(disp.MaxCallDuration)` and hangs up with a BYE when it expires; values `<= 0` or above a package-level maximum are clamped to that maximum). It can only be set with `UpdateSIPInboundTrunk` action **replace** (the partial `SIPInboundTrunkUpdate` message has no such field), which overwrites the whole trunk with no concurrency check; read-back: `listSipInboundTrunk({ trunkIds: [id] })[0].maxCallDuration`.
- **C. Vobiz-side cap:** capability unknown (Vobiz docs not reachable).
- Not suitable: `RoomConfiguration.emptyTimeout` / `departureTimeout` (a stranded SIP caller keeps the room non-empty).

Unresolved before implementing A (owner / LiveKit support / staging):

1. Does **LiveKit Cloud** enforce inbound-trunk `max_call_duration` like the open-source service, and what is the server-side maximum it is clamped to (not found in the fetched source files)?
2. `replace` safety: the SDK (protocol 1.51.0) does not know field 21 `ringing_timeout_status`, which newer servers have; a replace through this SDK resets any field the SDK does not know. Does `ListSIPInboundTrunk` return every field we set (`allowed_addresses`, `numbers`, `krisp_enabled`, any auth secret) so a read-modify-write preserves them? Required: upgrade `livekit-server-sdk` to a version whose protocol matches the server, then replace, then read back and compare every field.
3. Staging test **[approval: paid call]**: set the cap to 120 s on the staging trunk only, call once, confirm the drop at ~120 s, the `participant_left` webhook and the billing path; then set it to klyro's `VOICE_AGENT_MAX_CALL_SECONDS` + 600 s (above the agent's goodbye and the sweep).
4. LiveKit: when an agent job process dies, does the server reassign the job or end the room? (The sweep covers both answers.)

### 6c. Room sweep: operation, alerts, manual recovery, acceptance criteria

(Phase 2.9, hardened in Phase 2.11 after the Phase 2.10 review; code: `src/lib/voice-agent/room-sweep.server.ts`, `call-meta.ts`.)

**Rows considered** (inbound `livekit_sip`, answered in the last 24 h):

| Case                                                                                                     | Decision (recorded before deleting, applied only after the room is gone)    |
| -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| A. active, no agent end report, older than **this call's** limit + 5 min                                 | `failed` / `max_duration_exceeded`, **not billed**                          |
| B. active, the agent reported the end (bound to this room/SIP call) > 5 min ago, no LiveKit confirmation | `completed` at the agent's reported end, billed **once** with that duration |
| C. closed without LiveKit's confirmation (agent-report billing, 3-hour rule)                             | none (room only)                                                            |
| LiveKit-confirmed, outbound, older than 24 h                                                             | never touched                                                               |

**Per-call limit (F2):** at session start klyro records `provider_metadata.max_call_seconds` = min(`VOICE_AGENT_MAX_CALL_SECONDS`, the agent's own `MAX_CALL_SECONDS`) and returns it; the agent ends the call at that limit. A later configuration change never shortens a running call. Older agents (no limit sent) and rows created before Phase 2.11 use the 7200 s ceiling.

**Before anything is closed or deleted (F1, F7):** the room must be the one recorded for the call (`call-` prefix), every SIP participant must be this call (`sip.callID` = `provider_call_id`), there must be nothing else in the room, and **no agent participant may be connected** (kind AGENT / identity `agent-`). A connected agent = a live call: the row is left as is (`waiting`, rechecked every 5 min; one `room_sweep_agent_stuck` alert if the agent is still there 30 min after the call's limit). Mismatch / invalid room: nothing changes (row stays active) and an alert fires. Then the decision is recorded with a conditional update that requires the call to be still active; if LiveKit's webhook completed the call first, nothing is deleted (`superseded`). Only after the deletion succeeds (or the room is gone) is the row closed; if deletion fails the row stays active with its decision, and LiveKit's later webhook applies that decision (never LiveKit's duration).

**End reports (F1):** the agent sends its room and `sip.callID`; a mismatching report is refused (HTTP 409) and records nothing. Reports from older agents (no binding) are accepted and marked `agent_end_unbound`.

**Orphan rooms (F4):** `call-` rooms (ListRooms) older than 10 min, with only SIP participants, no agent, no ACTIVE row for their SIP call ids and not recorded as the room of any active call: deleted (unknown number, call refused at session start, klyro unreachable). At most 2 per run; the starting point rotates every 5 min so skipped rooms cannot starve others. No row is changed.

**Reliability (F3, F5, F8):** every database result is checked; a database error is an error (`voice_agent:room_sweep_db_error`, route 500), never "nothing to do". One row's failure never aborts the run. Each run stops claiming work when its 18 s time budget (pg_net timeout 25 s) or 45-subrequest budget (Workers Free: 50) would be exceeded (`budgetExhausted`, `deferred`). The lease is the claim time; a lease left by a cancelled run counts as a failed attempt. Failures back off 5, 10, 20, 40, 60, 60 … min until the row leaves the 24 h window (`expired`, alert); `voice_agent:room_sweep_failed` fires once per row, at the 6th failure.

**Metadata recorded per row:** `room_sweep` (`pending` / `deleting` / `retry` / `waiting` / `done` / `gone` / `superseded` / `mismatch` / `invalid_room` / `expired`), `room_sweep_kind`, `room_sweep_failures`, `room_sweep_lease`, `room_sweep_next_at`, `room_sweep_alerted`, `room_sweep_close` (decision), `room_sweep_error`, `room_sweep_at`. All writers of `provider_metadata` (billing, end reports, sweep) are conditional on every key the others change, and merge into the current object on conflict (F6; no migration needed).

**Metrics:** `sip_room_sweep:tick` / `sip_room_sweep:tick_failed` with `{ examined, closedNoAgentReport, closedFromAgentReport, roomsDeleted, roomsGone, retryScheduled, waitingForAgent, agentStuck, alertsRaised, mismatched, invalidRoom, superseded, expired, lostRace, deferred, dbErrors, rowErrors, orphanRoomsDeleted, orphanRoomsSkipped, subrequests, elapsedMs, budgetExhausted, unconfigured }`.

**Scheduling:** staging: `scripts/staging/schedule-cron.sql` (every 5 min). Production: the external scheduler (RUNBOOK.md, Deploy step 6). WAF: rate-limit `/api/public/cron/*` (RUNBOOK.md step 7).

**Alerts:**

| Signal                                                                                                       | Severity | Action                                                                                                 |
| ------------------------------------------------------------------------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------ |
| no `sip_room_sweep:tick` for 15 min, or any `sip_room_sweep:tick_failed`                                     | page     | the backstop is not running or cannot read the database                                                |
| `voice_agent:room_sweep_failed`, `voice_agent:room_sweep_expired`                                            | page     | LiveKit refused 6+ times / gave up after 24 h: the caller may still be connected. Manual recovery.     |
| `voice_agent:room_sweep_agent_stuck`                                                                         | page     | an agent is still in a room 30 min after the call's limit: inspect the agent pod; end the room by hand |
| `voice_agent:room_sweep_mismatch`, `voice_agent:room_sweep_invalid_room`, `voice_agent:orphan_room_mismatch` | page     | recorded room does not match the call: nothing was deleted. Investigate.                               |
| `voice_agent:room_sweep_unconfigured` (route 503), `voice_agent:room_sweep_db_error`                         | page     | backstop off / database errors                                                                         |
| `voice_agent:room_swept`, `voice_agent:orphan_room_swept`                                                    | warn     | the agent failed to end a call itself: check agent pods, `call.cleanup_failed`                         |
| `voice_agent:end_report_binding_mismatch`                                                                    | warn     | an agent reported the end of a call it is not in: investigate the agent                                |

**Manual recovery** (`room_sweep` in `expired` / `mismatch` / `invalid_room`, a `retry` with many failures, or a caller reported stuck):

1. `select id, organization_id, status, answered_at, provider_call_id, provider_metadata from call_logs where provider = 'livekit_sip' and provider_metadata->>'room_sweep' in ('retry','expired','mismatch','invalid_room') order by answered_at desc;`
2. LiveKit Cloud dashboard → Rooms → the room in `provider_metadata.livekit_room` (for `invalid_room`, find it by `sip.callID` = `provider_call_id`) → confirm the participants → end the room (CLI: `lk room delete <room>`).
3. If LiveKit cannot end it: hang the call up at Vobiz.
4. Record the outcome without touching status or billing: `update call_logs set provider_metadata = provider_metadata || '{"room_sweep":"done","room_sweep_manual":true}' where id = '<id>';` For a row still active after the room is gone, LiveKit's `participant_left` webhook (or the reconcile sweep) closes it.

**Acceptance criteria** (staging; nothing here is verified against LiveKit Cloud yet; source reading of open-source LiveKit is not proof):

1. All Phase 2.9/2.11 tests pass (`voice-agent-api.test.ts`, `voice_agent_room_sweep.pg.test.ts`, agent `runtime.spec.ts` / `outbound-dispatch.spec.ts`).
2. Cron: a `sip_room_sweep:tick` every 5 min for 1 h, `unconfigured: false`, `elapsedMs` < 18000, `subrequests` ≤ 45; unsigned `POST` → 401.
3. LiveKit Cloud API: on a staging room, `ListParticipants` reports the agent with kind `AGENT` and the caller with `sip.callID`; `DeleteRoom` on a missing room answers 404; `ListRooms` returns `creationTime`.
4. Agent crash **[approval: paid call]**: with `VOICE_AGENT_MAX_CALL_SECONDS=300` on staging, call, kill the agent pod; the caller is disconnected by ~10–15 min; the row ends `failed` / `max_duration_exceeded`, `room_sweep = done`, no wallet debit.
5. Agent cleanup failure **[approval: paid call]**: test pod with a revoked LiveKit key, end a call normally; the agent leaves, the caller is disconnected within ~10 min; billed once with the agent-reported duration.
6. Orphan **[approval: paid call]**: call an unknown staging number with the agent's room deletion disabled; the room is deleted after 10–15 min.
7. No false positives over 24 h of staging traffic: `roomsDeleted` + `orphanRoomsDeleted` = injected failures; no `waiting` row ever deleted while its agent was present.

### 6d. LiveKit URL policy and cron authentication (Phase 2.12)

**F13, LiveKit credentials:** klyro (`livekit-api.ts` `livekitApiBase`) refuses, before minting any token, a `LIVEKIT_URL` that is not `wss://`/`https://` to a subdomain of `livekit.cloud` (or an exact host in `LIVEKIT_ALLOWED_HOSTS`), that uses plain `ws://`/`http://` to anything but localhost, or that carries credentials, a path, query or fragment. The room sweep then reports `unconfigured` (route 503, `reason: livekit_url_rejected`); an outbound dispatch is a definite rejection. The agent's configuration applies the same host rule outside development. Grants: DeleteRoom = `{ roomCreate }` only (the single grant LiveKit's DeleteRoom accepts; project-wide by LiveKit's design, so 30 s lifetime, per request, bound room only); ListRooms = `{ roomList }`, 30 s; ListParticipants / CreateDispatch = `roomAdmin` for one room, 60 s. Request shapes and grants are checked against livekit-server-sdk 2.19.2 (`outbound-dispatch.spec.ts`).

**F14, cron routes:** see RUNBOOK.md Deploy step 6 (credential, signing, bearer, limits, rotation). Verified locally on the built Worker (`wrangler dev --local`, placeholder values, no outbound calls): unauthenticated, shared-secret, forged-signature, stale-signature and trailing-slash POSTs → 401 `{"error":"unauthorized"}`; GET/PUT never reach the handlers (HTML shell); Worker logs contain the route and a reason only.

## 7. What protects what (for reviewers)

| Route                                                                 | Before auth (per isolate, no I/O)                                                                                | Auth                                                                   | After auth (shared, Postgres)                                                                                                                                 |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/api/internal/voice-agent/{session,tool,session-end,outbound-claim}` | verify first; sources with ≥ 30 counted failures/min get 429 for further INVALID requests (not counted: `stale`) | HMAC + timestamp ±60 s + one-time nonce                                | start: 30/min per called number; tool: 60/min per call; end: 10/min per call; claim: 10/min per call                                                          |
| `/api/public/webhooks/livekit`                                        | verify first; same, for unverifiable events (not counted: `expired`, `not_yet_valid`)                            | LiveKit JWT (iss, exp, body sha256)                                    | none; a correctly signed event is never rate-limited. Each event is claimed once (`webhook_events`)                                                           |
| outbound (server function `startAgentOutboundCall`)                   | Supabase session                                                                                                 | owner/admin of the **number's** organization; idempotency key required | 10/min per org, 5/min per user; ≤ 3 active and ≤ 100 per 24 h per org, reserved atomically (DB function, per-org lock); India-only destinations; wallet; gate |
| `/api/public/cron/reconcile-sip-calls`                                | n/a                                                                                                              | `LOVABLE_CRON_SECRET`                                                  | n/a                                                                                                                                                           |
| `/api/public/cron/sweep-sip-rooms`                                    | n/a                                                                                                              | `LOVABLE_CRON_SECRET`                                                  | n/a                                                                                                                                                           |

Sources are counted as IPv4 addresses and IPv6 /64s; at most 10,000 are tracked per isolate (the oldest is evicted, nobody is refused because the table is full). A 429 always comes before any replay claim, call row or billing step. The shared limits fail closed, like the existing public-assistant limiter.

Outbound lifecycle (every transition is one conditional UPDATE):

| Step                 | Transition                                  | Guarantees                                                                                                                                                |
| -------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| request              | → row `initiated` (id derived from the key) | a repeated or concurrent request maps to the same primary key: one row, one dispatch                                                                      |
| dispatch             | dispatched / rejected / unknown             | rejected (4xx) → row `failed`; unknown (timeout, network, 5xx, 429) → row stays `initiated`, caller sees `pending`, retry with the same key re-dispatches |
| agent claim          | `initiated` → `ringing` (one job, ≤ 5 min)  | destination and caller ID come only from the row; a second job (duplicate dispatch) is refused and dials nothing                                          |
| dial fails           | `ringing` → `failed`                        | never billed; the agent deletes the room                                                                                                                  |
| session start        | `ringing` → `answered` (once per row)       | a second SIP call on the row is refused (`already_started`)                                                                                               |
| LiveKit end event    | `answered` → `completed` + billing lease    | billed once; outbound duration counted from klyro's answered time (ringing excluded)                                                                      |
| sweep (every 15 min) | stale rows only                             | unclaimed after 10 min → `not_dialed`; claimed but unanswered after 30 min → `dial_not_completed`; billing left in `retry`/stale `pending` is billed once |

## 8. Smoke tests (staging)

Free (no call):

1. `curl -s -o /dev/null -w '%{http_code}' -X POST https://<staging>/api/internal/voice-agent/session` → `401`.
2. Same request 700 times in one minute from one IP → the tail returns `429` with `Retry-After`.
3. Signed webhook replay: re-POST a captured LiveKit webhook body → `200 {"duplicate": true}`; no second debit in `wallet_transactions`.
4. Outbound authorization (flag still unset): as an owner, call `startAgentOutboundCall` (with a fresh `idempotencyKey` UUID) → error "AI outbound calling is not enabled". As staff (flag set) → "Only workspace owners and admins…". Neither creates a `call_logs` row. A non-Indian or 1800/1860/1900 destination → "…not enabled…" / "Only regular Indian…".
5. Cron: `curl -X POST -H "Authorization: Bearer $LOVABLE_CRON_SECRET" https://<staging>/api/public/cron/reconcile-sip-calls` → `200` with `{"notDialed":0,"dialNotCompleted":0,"endEventMissing":0,"billedFromAgentReport":0,"billingRetried":0,"deferred":0}` (all zero on an idle staging database) and one `sip_reconcile:tick` Worker log line. Without the bearer: `401`.

Paid **[approval]**, one at a time, with the costs in §10:

6. Inbound, English: call the test number and book a test appointment. Expect one `call_logs` row (`provider=livekit_sip`, `completed`, duration set), one wallet debit, logs `call.joined` → `turn.*` → `tool` → `booking.result` → `call.ended` with no transcript text, and a Google Calendar event if the test business has Calendar connected (`saved_calendar_sync_failed` is reported to the caller as saved and retried by the calendar sweep).
7. Inbound, Hindi, then Telugu: the same, speaking only that language. Expect a greeting and replies in that language (business `primary_language` / `extra_languages`).
8. Caller hangs up mid-sentence: the call is completed and billed once (LiveKit `participant_left`).
9. Outbound (set `VOICE_AGENT_OUTBOUND_ENABLED=true` and the agent's `SIP_OUTBOUND_TRUNK_ID`): call a team phone. Expect caller ID = the business's number. Then repeat to a phone that rejects or doesn't answer: the row becomes `failed` with `dial_failed:*` within ~30 s and is not billed.
10. Failure recovery: scale the agent to 0 during a call → the call drops; the row is closed by LiveKit's webhook (billed for the real duration) or, if no webhook arrives, by the reconcile sweep within 3 h 15 min (not billed).

## 9. Rollback

- Number: re-link the staging test number to its previous Vobiz Voice Application (answer URL). This takes effect immediately; then remove it from `SIP_INBOUND_NUMBERS` and run `provision:sip -- --apply` (verified by read-back). Removing the LAST number is refused (`SIP_INBOUND_NUMBERS` must not be empty: an inbound trunk without numbers could match any number); to retire the path entirely, delete the trunk `clickai-vobiz-inbound` and the rule `clickai-receptionist` in the LiveKit dashboard.
- Outbound: unset `VOICE_AGENT_OUTBOUND_ENABLED` (immediate; no deploy).
- Agent: `kubectl -n clickai-staging scale deploy/voice-agent --replicas=0`. Active calls drain first.
- Cron: `select cron.unschedule('clickai-staging-reconcile-sip-calls');` and `select cron.unschedule('clickai-staging-sweep-sip-rooms');`.
- klyro: redeploy the previous staging build from the Cloudflare dashboard. The new routes are inert without SIP traffic. The outbound reservation migration only adds a function; to roll it back: `DROP FUNCTION public.reserve_voice_agent_outbound_call(uuid, uuid, uuid, uuid, text, text, text, timestamptz, integer, integer, integer);` (outbound then fails closed).

## 10. Cost per minute (estimate; verify every price before relying on it)

Per connected minute of an inbound call, list prices found 2026-11-02:

| Component                       | Unit price (source)                                                                                | Per minute (assumption)                                                                |
| ------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| LiveKit agent session           | $0.01/min beyond the plan's included minutes ([LiveKit pricing](https://livekit.io/pricing))       | $0.01 (0 inside the included allowance)                                                |
| LiveKit SIP (third-party trunk) | $0.004/min Ship, $0.003/min Scale, beyond included ([LiveKit pricing](https://livekit.io/pricing)) | $0.003–0.004                                                                           |
| Sarvam STT                      | ₹30 per audio hour ([Sarvam pricing](https://docs.sarvam.ai/api-reference-docs/pricing))           | ₹0.50 (caller audio streamed for the whole minute)                                     |
| Sarvam TTS `bulbul:v3`          | ₹30 per 10,000 characters (same source)                                                            | ~₹1.2 at ~400 spoken characters/min (assumption; Telugu/Hindi script lengths differ)   |
| Claude `claude-sonnet-4-6`      | $3 / $15 per million input / output tokens; cache reads ~10% of input                              | ~$0.01–0.04: ~3 LLM turns/min × ~4k input tokens (instructions + history) × ~80 output |
| klyro Worker + Supabase         | Cloudflare/Supabase plan                                                                           | negligible per minute (a few requests and RPCs per turn)                               |

**Indicative total, excluding telephony:** about $0.025–0.055 plus ₹1.7 per minute (the provider currencies are kept separate on purpose; convert at the current rate).

Unknown and not estimated:

- **Vobiz per-minute rates** (inbound and outbound, India). No official rate card was found. Read them from the Vobiz console or contract.
- The Vobiz monthly number rental.
- The actual token usage per turn: measure it from the first staging calls (LiveKit `MetricsCollected` events) before using the LLM line.
- Whether the LiveKit plugin enables Anthropic prompt caching. If it doesn't, use the upper LLM figure.
- LiveKit plan base fees and included allowances; egress or recording (not used).
- A fallback LLM, if `FALLBACK_LLM_*` is configured.
- The minimum billing increments of each provider (LiveKit per-second or per-minute; Vobiz pulse length).

Watch item: newer Claude models are cheaper (for example `claude-sonnet-5-5` at $2 / $10). Changing `CLAUDE_MODEL` is a product decision that needs a quality check. The agent's Anthropic plugin pins `@anthropic-ai/sdk` 0.33.1 (API version `2023-06-01`), under which its `temperature: 0.2` is accepted.
