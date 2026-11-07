# Local self-hosted LiveKit stack (development)

A reproducible local stack for the ClickAI voice agent on **self-hosted, open-source LiveKit**:

| Service       | Image (pinned by digest in `deploy/docker-compose.dev.yml`) | Purpose                                                                                                                                    |
| ------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `redis`       | `redis:7.4.7-alpine`                                        | LiveKit and SIP state/bus, **including SIP trunks and dispatch rules**. Internal network only, password required, **no persistence** (§4a) |
| `livekit`     | `livekit/livekit-server:v1.13.11`                           | Rooms, signalling (`:7880`), WebRTC media, signed webhooks                                                                                 |
| `sip`         | `livekit/sip:v1.23.0`                                       | SIP ↔ room bridge (`:5060`, RTP `10000-10099`)                                                                                             |
| `voice-agent` | built from `services/voice-agent/Dockerfile`                | The existing Node.js/TypeScript LiveKit Agents worker, **Sarvam only** (LLM, STT `saaras:v3`, TTS `bulbul:v3`)                             |

Version pairing: server `v1.13.11` (protocol 1.53.1, psrpc 0.8.2), SIP `v1.23.0` (protocol 1.53.2, psrpc 0.8.2), agent SDKs `livekit-server-sdk` 2.19.2 / `@livekit/protocol` 1.53.1 / `@livekit/agents` 1.9.5.

It changes nothing in klyro (Cloudflare Worker), Supabase or Vobiz, and it is **not** a production deployment.

## 1. Prerequisites

- Docker Engine with Compose v2 (tested: Engine 29.9.2, Compose 5.6.1, Linux). Docker Desktop works for everything except receiving real SIP from the internet (see §8).
- `openssl` and `bash` (for `init-env.sh`), Node.js ≥ 22.6 and `npm ci` in `services/voice-agent` (for the smoke test).
- Network access at build time: Docker Hub (or `mirror.gcr.io`), `registry.npmjs.org`, `github.com` (tini) and, for the multilingual turn detector, `huggingface.co` and its CDNs (`hf.co`, `cdn-lfs*.hf.co`, `cas-bridge.xethub.hf.co`).
- A Sarvam API key **with a spending limit** (the stack calls Sarvam only when a call reaches a conversation).
- Free host ports: `127.0.0.1:7880-7881/tcp`, `127.0.0.1:50000-50100/udp`, `127.0.0.1:5060/udp+tcp`, `127.0.0.1:10000-10099/udp`, `127.0.0.1:8081/tcp`, and `8790/tcp` for the smoke test's fake klyro.

## 2. Environment and secrets

```sh
bash services/voice-agent/deploy/local/init-env.sh
```

Writes `services/voice-agent/deploy/local/.env` (git-ignored, mode 600) with **fresh random** `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `REDIS_PASSWORD`, `VOICE_AGENT_HMAC_SECRET` (`openssl rand -hex`); it never overwrites an existing file and prints no value. Then set `SARVAM_API_KEY` in that file. Never reuse staging or production values here.

All variables (names and defaults are in `deploy/local/.env.example`):

| Variable                                 | Required                                                            | Used by                                                     | Meaning                                                                                                   |
| ---------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | yes (generated)                                                     | server (`LIVEKIT_KEYS`), SIP, agent, smoke test             | LiveKit API key pair; the server also signs webhooks with it                                              |
| `REDIS_PASSWORD`                         | yes (generated)                                                     | redis, server, SIP                                          | Redis `requirepass`                                                                                       |
| `VOICE_AGENT_HMAC_SECRET`                | yes (generated)                                                     | agent (and klyro when you point the agent at a local klyro) | Signs agent → klyro requests                                                                              |
| `SARVAM_API_KEY`                         | yes (you)                                                           | agent                                                       | Sarvam LLM, STT and TTS                                                                                   |
| `KLYRO_BASE_URL`                         | no `[http://host.docker.internal:8790]`                             | agent                                                       | klyro the agent calls; default = the smoke test's fake klyro                                              |
| `LIVEKIT_WEBHOOK_URL`                    | no `[http://host.docker.internal:8790/api/public/webhooks/livekit]` | server                                                      | Where signed webhooks go                                                                                  |
| `LIVEKIT_ALLOWED_HOSTS`                  | no                                                                  | agent                                                       | Self-hosted LiveKit hostnames for `APP_ENV` staging/production (not enforced in this `development` stack) |
| `AGENT_NAME`                             | no `[clickai-receptionist]`                                         | agent                                                       | Must equal the SIP dispatch rule's agent                                                                  |
| `SARVAM_LLM_MODEL`                       | no `[sarvam-105b-conversations]`                                    | agent                                                       | or `sarvam-105b`                                                                                          |
| `VOICE_AGENT_TURN_DETECTION`             | no `[multilingual]`                                                 | agent                                                       | `vad` = no model files                                                                                    |
| `VOICE_AGENT_DOWNLOAD_TURN_DETECTOR`     | no `[1]`                                                            | agent build                                                 | `0` = image without the model (only with `vad`)                                                           |
| `VOICE_AGENT_MAX_CONCURRENT_SESSIONS`    | no `[2]`                                                            | agent                                                       | Calls per container                                                                                       |
| `LOCAL_BIND_IP`, `SIP_BIND_IP`           | no `[127.0.0.1]`                                                    | port publishing                                             | Host IPs the ports bind to. **Keep `LOCAL_BIND_IP` on `127.0.0.1`** (see the warning below)               |
| `SIP_NAT_1_TO_1_IP`                      | no                                                                  | SIP                                                         | Public IP for SIP/SDP behind NAT (§8 only)                                                                |
| `LIVEKIT_NODE_IP`                        | no `[detected]`                                                     | server                                                      | IP advertised for WebRTC media                                                                            |
| `LIVEKIT_LOG_LEVEL`                      | no `[info]`                                                         | server, SIP                                                 |                                                                                                           |
| `DOCKERHUB_MIRROR`                       | no `[docker.io]`                                                    | image pulls                                                 | e.g. `mirror.gcr.io` on HTTP 429 (same digests)                                                           |
| `NODE_BASE_REGISTRY`                     | no `[docker.io/library]`                                            | agent build                                                 | e.g. `mirror.gcr.io/library`                                                                              |

> **Warning: plain HTTP, no TLS.** LiveKit's API and WebSocket (`7880`), WebRTC (`7881`, `50000-50100/udp`) and the agent's health port (`8081`) are published **without TLS**. Never set `LOCAL_BIND_IP` to `0.0.0.0`, a LAN IP or a public IP: anyone who can reach the port gets an unencrypted API protected only by the key, and tokens and webhook bodies travel in clear text. To use the stack from another machine, use an SSH tunnel to `127.0.0.1`. `SIP_BIND_IP` may be widened only on a host deliberately exposed to Vobiz, with the firewall rules in §8.

Guarantees (checked by `tests/local-stack.spec.ts`): no credential has a literal value in committed files; Redis has no published port and sits on an `internal` network; every image is pinned by tag and digest; the agent receives only the variables listed in the compose file (no `env_file`), with `LLM_PROVIDER: sarvam` fixed, no Anthropic or fallback variable, and the agent refuses to start if `FALLBACK_LLM_BASE_URL` were set.

## 3. Start and stop

From the repository root (`ENV` and `C` are shell shortcuts):

```sh
ENV=services/voice-agent/deploy/local/.env
C="docker compose --env-file $ENV -f services/voice-agent/deploy/docker-compose.dev.yml"
$C up -d --build          # build the agent image and start all four services
$C ps                     # all four "healthy"
$C logs -f voice-agent    # look for the "registered worker" line with agentName clickai-receptionist
$C stop                   # stop (keeps containers)
$C down                   # remove containers and networks (see "Leftover volumes" below)
$C down -v                # same, and also remove the Redis container's anonymous volume
```

**Leftover volumes.** The compose file declares no volumes, but the Redis image declares `VOLUME /data`, so Docker gives the Redis container an anonymous volume. Persistence is off, so the volume stays **empty**: no data, no SIP configuration, no password. Restarting or recreating the container (`$C restart`, `$C up -d --force-recreate`) reuses that volume. Plain `$C down` leaves it behind, and the next `$C up` creates a new one, so empty volumes pile up over repeated `down`/`up` cycles.

- `$C down -v` removes the Redis container's current anonymous volume along with the containers and networks. The stack has no named volumes, so `-v` deletes nothing else from it.
- `down -v` does not remove volumes left by earlier `down` runs without `-v`. They are no longer attached to any container: list them with `docker volume ls -f dangling=true`, check them with `docker volume inspect <name>`, and remove them one by one with `docker volume rm <name>`. `docker volume prune` would also delete unused anonymous volumes belonging to other projects on the same host.

Without Hugging Face access, build a VAD-only agent: set `VOICE_AGENT_DOWNLOAD_TURN_DETECTOR=0` **and** `VOICE_AGENT_TURN_DETECTION=vad` in `.env`. Staging and production images must keep the defaults (model baked in and verified).

## 4. Health checks

Automated (recommended):

```sh
cd services/voice-agent
npm run local:smoke               # 10 infrastructure checks
npm run local:smoke -- --sip-call # + 5 checks with a local SIP call
```

It starts a fake klyro on `0.0.0.0:8790` (the stack's default `KLYRO_BASE_URL` and webhook target) that verifies requests **with klyro's own code** (`src/lib/voice-agent/livekit-webhook.ts`, `internal-auth.ts`) and refuses every call (`allowed: false`), so no booking, billing or Sarvam request happens. Checks:

1. LiveKit HTTP `GET /` → 200.
2. LiveKit API (`ListRooms`) with the key; a wrong secret is refused.
3. WebSocket signalling: `/rtc/validate` 200 and a server message over `/rtc`.
4. Redis not reachable from the host.
5. SIP answers `OPTIONS` on `127.0.0.1:5060/udp`.
6. Agent health `:8081/`, and `/worker` names the agent (a health endpoint only; registration is proven by 7).
7. Agent dispatch: an explicit dispatch puts an `AGENT` participant in a new room `smoke-dispatch-<runId>`.
8. Webhooks: `room_started`, `participant_joined` and `room_finished` for **that** room, signed by LiveKit and accepted by klyro's verifier; no webhook rejected.
9. (`--sip-call`) The target is proven local, then a per-run trunk `clickai-local-smoke-<runId>-inbound` and dispatch rule `clickai-local-smoke-<runId>-dispatch` (rooms `smoke-call-<runId>-…`, a fictitious per-run number `+9112345xxxxx`) are created.
10. (`--sip-call`) A SIP INVITE from this host is answered; the single room with this run's prefix has a `SIP` participant (dialled number = the run's number) and an `AGENT` participant.
11. (`--sip-call`) The agent's session request to klyro is HMAC-verified and carries the dialled number and that room.
12. (`--sip-call`) The refused call is ended (room closed; SIP sends `BYE`).
13. (`--sip-call`) Cleanup (always runs, also after a failed check): exactly this run's trunk and rule deleted.

**SIP smoke safety.** `--sip-call` writes SIP routing, so it refuses to run unless the server is demonstrably this local stack (`deploy/local/smoke-lib.ts`, tested by `tests/local-smoke-guards.spec.ts`):

- the LiveKit URL is plain `http`/`ws` on loopback, and `LIVEKIT_API_KEY` has the `init-env.sh` form `APIlocal` + 12 hex (exit code 2 otherwise);
- the server has already delivered a verified webhook for this run's own room to this process (a remote server reached through a tunnel posts webhooks to its own URL, not here);
- the server holds **no** object named `clickai-vobiz-inbound`, `clickai-vobiz-outbound` or `clickai-receptionist`, and no trunk with the run's number.

It never creates, updates or deletes an object with a production name. Cleanup deletes by the ids this run created, after re-reading each one and confirming it still has this run's name; objects of earlier, interrupted runs are reported and left alone (delete them by hand on the local server). If the run is killed (Ctrl-C) before cleanup, the run's objects remain on the local server only, until Redis restarts.

## 4a. Redis restarts and SIP provisioning

Redis in this stack has **no persistence** (`--save "" --appendonly no`), and it is where LiveKit stores SIP **trunks and dispatch rules**, not just transient room state. Any Redis restart, `$C restart redis`, `$C down`/`up` or container recreation erases them. All four services stay `healthy`, but every SIP INVITE is rejected until the configuration is provisioned again.

- `npm run local:smoke -- --sip-call` is unaffected: it creates and removes its own objects on every run.
- If you provisioned this stack with `provision:sip` (§8), run it again after **every** Redis restart and check that the plan reports both objects unchanged:

  ```sh
  cd services/voice-agent
  set -a; . deploy/local/.env; set +a   # local values only
  LIVEKIT_URL=ws://127.0.0.1:7880 SIP_INBOUND_NUMBERS=<test number> VOBIZ_SIP_SIGNALING_IPS=<Vobiz IPs> npm run provision:sip -- --apply
  LIVEKIT_URL=ws://127.0.0.1:7880 SIP_INBOUND_NUMBERS=<test number> VOBIZ_SIP_SIGNALING_IPS=<Vobiz IPs> npm run provision:sip   # dry run: inbound and rule "unchanged"
  ```

  A stack provisioned this way holds the production object names, so `--sip-call` will (correctly) refuse to run against it.

Persistence is deliberately left off locally: a disposable Redis means `down`/`up` always returns to a clean state, and nothing holding SIP configuration or the Redis password is written to disk (the Redis image's anonymous volume stays empty; §3, "Leftover volumes").

**Production requirements** (not provided by this stack): Redis with persistence (AOF `appendonly yes` on a durable volume, or a managed Redis with persistence and backups), private networking and a password, and a **start-up check** after every LiveKit, SIP or Redis restart that runs `provision:sip` in dry-run mode and alerts unless the inbound trunk and dispatch rule are reported `unchanged`. Without that check a Redis restart silently stops all inbound calls.

Manual:

```sh
curl -s http://127.0.0.1:7880/            # OK
curl -s http://127.0.0.1:8081/worker      # agent_name, active jobs
$C exec sip bash -c 'exec 3<>/dev/tcp/127.0.0.1/8080; printf "GET / HTTP/1.0\r\n\r\n" >&3; head -1 <&3'
```

Container health checks: Redis `redis-cli ping`; LiveKit `wget /`; SIP its health port 8080; agent `GET :8081/`. Every service has `restart: unless-stopped`; SIP and the agent start only after a healthy LiveKit.

## 5. Using it with a local klyro

Run klyro's dev server on the host, then set `KLYRO_BASE_URL=http://host.docker.internal:<port>` and `LIVEKIT_WEBHOOK_URL=http://host.docker.internal:<port>/api/public/webhooks/livekit` in `.env`, and give klyro (its local env, never production) `LIVEKIT_URL=ws://localhost:7880`, the same `LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET` and `VOICE_AGENT_HMAC_SECRET`. klyro allows plain `ws://` only for localhost. Point a local klyro only at a **non-production** database: this repository has no separate Supabase project, so do not connect the local stack to the production database.

## 6. Troubleshooting

| Symptom                                                       | Cause / fix                                                                                                                                        |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `429 Too Many Requests` pulling images                        | Set `DOCKERHUB_MIRROR=mirror.gcr.io` and `NODE_BASE_REGISTRY=mirror.gcr.io/library` (same digests)                                                 |
| Agent build fails at `download-files` (`huggingface.co`)      | No Hugging Face access: use the VAD-only settings (§3)                                                                                             |
| Agent build fails at `npm ci` behind a TLS-intercepting proxy | Build on a network without interception, or give the build the proxy CA (not part of the committed Dockerfile)                                     |
| `required variable ... is missing` from compose               | Run `init-env.sh` and set `SARVAM_API_KEY`; pass `--env-file`                                                                                      |
| Agent never `healthy`                                         | `$C logs voice-agent`: config errors name the variable (no value printed); with `TURN_DETECTION=multilingual` the image must contain the model     |
| Dispatch check fails                                          | `AGENT_NAME` must equal the dispatch rule / dispatch name; the agent registers only with an explicit name (no automatic room join)                 |
| Webhook check fails                                           | The server must reach `host.docker.internal:8790` (host firewall); `LIVEKIT_WEBHOOK_URL` must point at a listener                                  |
| `refusing to run: …` / `production SIP objects`               | The SIP smoke test's safety checks (§4): use the `init-env.sh` key against the local stack; never point it at a provisioned server                 |
| All healthy but every SIP INVITE rejected                     | Redis restarted and SIP trunks/rules were lost: re-provision (§4a)                                                                                 |
| SIP INVITE gets `403`/`404`                                   | Called number not in the trunk's numbers, or the source IP not in its allowed addresses (local test uses `172.16.0.0/12`, `SMOKE_SIP_SOURCE_CIDR`) |
| Call answered but no audio                                    | RTP must reach the advertised IP/port: inside Docker, set `SIP_NAT_1_TO_1_IP`/`LIVEKIT_NODE_IP` when clients are outside the Docker host           |
| Port already in use                                           | Another LiveKit/SIP on the host; change `LOCAL_BIND_IP`/`SIP_BIND_IP` or stop it                                                                   |

## 7. What the local tests do and do not prove

**Verified locally (2026-11-06, this stack):** all four containers healthy; LiveKit API auth, WebSocket signalling, Redis isolation, SIP OPTIONS; agent registration and explicit dispatch; webhook signatures accepted by klyro's verifier; a local SIP INVITE answered (`100`/`180`/`200`), a `call-` room with `SIP` + `AGENT` participants, the agent's HMAC-signed session request with the dialled number, and the refused call ended (room closed, SIP `BYE`).

After the SIP smoke test gained per-run names, the locality proof, id-based cleanup and the stricter webhook and room checks, it was re-run on this stack (2026-11-06): 15/15 checks passed. It refused a server holding `clickai-vobiz-inbound`/`clickai-receptionist` and left both untouched, and it refused a non-`init-env.sh` key with exit code 2 before any request.

**Not verified by these tests:** any Sarvam request (the fake klyro refuses every call, so no STT/TTS/LLM traffic), audio quality or latency, booking/billing/Google Calendar (they run in klyro, not here), the multilingual turn detector (the sandbox run used `vad`), Vobiz itself, and **any real phone call**.

## 8. Real Vobiz calls (needs a public endpoint)

Not possible on a laptop behind NAT. On a host deliberately exposed to Vobiz:

- a public IP; `SIP_BIND_IP=0.0.0.0`, `SIP_NAT_1_TO_1_IP=<public IP>`; firewall: `5060/udp+tcp` **only from Vobiz's signalling IPs**, RTP `10000-10099/udp` from Vobiz media;
- `provision:sip` with `SIP_INBOUND_NUMBERS=<one test number>` and `VOBIZ_SIP_SIGNALING_IPS=<Vobiz IPs>`, `LIVEKIT_URL` of that server;
- re-routing a Vobiz number is a production change: **approval required** (STAGING_DEPLOYMENT.md §6); record the previous Voice Application id first.

## 9. Production deployment prerequisites (not covered by this stack)

- **TLS:** LiveKit API/WebSocket behind a TLS proxy (`wss://`/`https://` on 443, public certificate). klyro and the agent refuse non-TLS LiveKit URLs outside localhost, and refuse hosts other than `*.livekit.cloud` unless listed in `LIVEKIT_ALLOWED_HOSTS` (set on **both** klyro and the agent).
- **Never `--dev`;** keys from a secret manager, not a `.env` file; Redis private with a password **and persistence**, plus a start-up check that the SIP trunk and dispatch rule exist (§4a); separate key pairs per environment; webhook URL `https://<klyro host>/api/public/webhooks/livekit`.
- **Networking:** public IP for SIP and media; `use_external_ip`/`node_ip` and `nat_1_to_1_ip` set for the public address; full RTP ranges sized for the call volume.
- **Agent image:** built with the turn-detector model (`verify-models: ok`); `APP_ENV=production` (manifest `deploy/k8s/voice-agent.yaml`) or `staging`; `LLM_PROVIDER=sarvam` explicitly (the code default is `anthropic`).
- **Sarvam:** the LLM is not yet accepted (`SARVAM_LLM_MIGRATION.md` §6 benchmark thresholds); STT/TTS streaming has not been tested against the real API.
- **klyro:** voice secrets and `LIVEKIT_URL`/`LIVEKIT_ALLOWED_HOSTS` on the Worker, the two voice cron routes scheduled, alerts (STAGING.md §6a), WAF rules; read-only database checks first (`scripts/staging/check-voice-agent-schema.sql`).
- **Rollout:** one test number first, real calls with approval, then number by number with Vobiz rollback ready (STAGING_DEPLOYMENT.md §6).
