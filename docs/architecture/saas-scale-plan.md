# ClickAI multi-tenant AI Employees platform: audit, target architecture and phased plan

Status: Phases 0 and 1 in production (migration `20261111090100` applied 2026-11-11 05:26 UTC). Code on `feature/clickai-staging-go-live`.
Written 2026-11-11 from the repository, read-only production queries and Sarvam's
official docs (docs.sarvam.ai). Every capacity number below is either **measured**
(with the command that produced it) or explicitly marked **unknown**. Nothing here
claims 10,000-tenant capacity: that needs load evidence we do not have yet.

---

## 1. Current architecture (as deployed, 2026-11-11)

| Layer           | What exists                                                                                                                                                                                                           | Evidence                                      |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Web + API       | One Cloudflare Worker `klyro` (TanStack Start SSR + 170 server functions), version `f05a0520`                                                                                                                         | `wrangler deployments list --name klyro`      |
| Database        | One Supabase Postgres 17 project (`eorazvlmqwunmhwviocn`), 63 public tables, ~3.7 MB, 4 organizations, 198 call rows                                                                                                  | read-only `pg_class` / `pg_policies` queries  |
| Voice runtime   | Sarvam Voice Agents (managed) for Sarvam calls; Vobiz/Exotel paths with Durable Objects `CallSessionDurableObject`, `VobizCallSessionDurableObject`; a LiveKit agent under `services/voice-agent`                     | `wrangler.json`, `src/lib/telephony/*`        |
| Background work | HTTP "cron" routes under `/api/public/cron/*` (dispatch-campaigns, expire-payments, reconcile-sip-calls, sweep-sip-rooms, sync-google-calendars, whatsapp-dispatch, whatsapp-replies)                                 | `src/routes/api/public/cron/`                 |
| Webhooks        | Telephony (Sarvam/Vobiz/Exotel), WhatsApp, Instagram, Razorpay, Google Calendar, LiveKit; dedupe via `webhook_events (provider, event_id)` UNIQUE and per-call `attempt_id`                                           | `src/routes/api/public/webhooks/`             |
| Billing         | `wallet_transactions` ledger (append-only by convention; enforced from Phase 1), `debit_wallet_for_call` (idempotent per call under an organization row lock), `usage_records`, `pricing_rules` + per-org overrides   | migrations `20260904120000`, `20261110100000` |
| Agent model     | `agent_configs` (one per business; `business_id UNIQUE`), `agent_versions` (published snapshots), `employee_type` (receptionist / sales / customer care), `sarvam_applications` registry (shared templates gated off) | migration `20261111090000`                    |

### Bottlenecks and gaps found (with evidence)

1. **No background processing runs in production.** No pg_cron (`cron.job` does not exist), no Worker cron trigger in `wrangler.json`, and `LOVABLE_CRON_SECRET` is not set on `klyro`. Every `/api/public/cron/*` route is therefore never called: no payment expiry, no SIP reconciliation, no calendar sweep, no WhatsApp dispatch, no campaign dispatch. (Campaign dispatch being off is currently _safe_; the rest is lost work.)
2. **Wallet balance was O(ledger size)** and per-tenant settlement serializes on the organization row. Measured below; fixed in Phase 1.
3. **One agent per business, one business per organization.** `agent_configs.business_id` is `UNIQUE` and `businesses` is read with `.maybeSingle()` by organization in 37 call sites. That is the artificial "one agent per customer" limit the requirements forbid.
4. **No durable queue, dead-letter or retry state** outside the per-call finalization lease (`call_logs.finalization_*`). Retries of webhook-driven work rely on the provider re-sending.
5. **Service-role code bypasses RLS.** RLS is enabled on all 63 tables and every permissive policy is intentional (demo requests, public settings, public knowledge base), but 103 server files use `supabaseAdmin` (98 query sites) where tenant isolation depends on explicit `organization_id` checks in code (present in 57 files). 165 of 170 server functions use `requireSupabaseAuth`; the other 5 are intentionally public (rate-limited website assistant chat/voice/settings, and two configuration flags that expose no secrets). Webhook and cron HTTP routes authenticate separately (signatures / verify tokens / bearer secrets).
6. **Provider limits unknown.** Sarvam documents that attempts-per-second and concurrency ceilings are _per plan and shared_ across campaigns, instant outbound and inbound, but does not publish the numbers.
7. **No consent records.** `contacts` has only `opted_out`; no consent basis, suppression list or calling-window enforcement for voice campaigns.

---

## 2. Provider capabilities (Sarvam), verified against official docs

| Capability                           | REST API (production, `X-API-Key`)                                                | MCP (`https://mcp.sarvam.ai/voice-agents`)           | ClickAI today                        |
| ------------------------------------ | --------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------ |
| Agent create / configure             | **Not documented** in the API reference                                           | `configure_agent` (create/update/clone)              | Manual (dashboard)                   |
| Versions                             | Not documented; `app_version` is an integer on calls/deployments                  | `agents` → `commit` (freezes a version)              | Admin enters version                 |
| Agent testing                        | Tests API (`/api/evals`): suites, runs against a committed version                | `evals`, `run_eval`                                  | Not integrated                       |
| Deployments                          | Create/list/get/update/status/delete (`/api/app-authoring/.../deployments`)       | `configure_deployment`                               | Create/update + read-only list (new) |
| Number purchase                      | **Not available** (dashboard + KYC only, 30-day auto-renewing rental)             | Not listed                                           | Manual import to pool                |
| Number/connection sync               | **Not documented** in REST                                                        | `telephony` list connections / onboarded numbers     | Manual entry                         |
| Instant outbound                     | `POST /api/outbounds/v1/.../outbounds` → `{attempt_id}`                           | `place_test_call` (non-enterprise, verified numbers) | Implemented                          |
| Campaigns + cohorts                  | Full lifecycle (`/api/scheduling`)                                                | `campaigns`, `configure_campaign`, `upload_cohort`   | Implemented, disarmed                |
| Call events                          | Instant-outbound and campaign webhooks (documented payloads)                      | n/a                                                  | Implemented (verify_token auth)      |
| Transcripts / recordings / analytics | Analytics API: attempts, interactions, transcripts, recordings, traces            | `analytics`                                          | Count-only check (new)               |
| Per-call config                      | `agent_variables` on instant outbound; cohort columns on campaigns; on-start hook | n/a                                                  | Template variables (shared only)     |

**Authentication split (requirement B).** MCP authenticates with interactive OAuth 2.1 via Sarvam SSO, 24-hour token, no refresh token, one org/workspace per connection, 120 tool calls/min. It is therefore an **admin authoring tool only**. All unattended production operations use the REST API with the workspace API key stored as a Worker secret.

**Shared applications (requirement A).** Sarvam's docs do **not** state: whether agent variables are scoped to one interaction, what the on-start hook receives (the called number / deployment id are not documented), or how the hook is authenticated. Without a documented isolation guarantee, shared applications stay disabled (`SARVAM_SHARED_APPLICATIONS_ENABLED` unset). Each customer gets a dedicated Sarvam app, authored by an admin (dashboard or MCP), which is the only path that is both automatable and documented today. Revisit when Sarvam documents per-interaction variable isolation and hook authentication.

---

## 3. Target architecture

Modular services **inside the existing Worker + Supabase** (no microservices, Redis or Kafka until a measurement shows the need):

```
            Cloudflare Worker (klyro) ───────────────────────────────┐
 API & identity ─ tenant mgmt ─ agent mgmt ─ number mgmt ─ billing   │ scheduled() every minute
       │              │             │             │          │      │ (free Worker cron trigger)
       ▼              ▼             ▼             ▼          ▼      ▼
   Supabase Postgres (RLS on every tenant table; server code always scopes by organization_id)
       jobs (durable queue: claim with FOR UPDATE SKIP LOCKED, idempotency_key UNIQUE,
             attempts, next_run_at, locked_until, dead_letter) ◄── webhook ingest, campaigns
       │
       ▼
   Provider layer: VoiceAgentProvider interface ── SarvamProvider (REST) ── (future) others
                   MessagingProvider interface ─── WhatsApp (Meta/Vobiz)
```

- **Logical vs provider entities (A):** `agent_templates` → customer `agents` (many per organization) → `agent_versions` (config snapshots, exists) → `provider_app_mappings` (agent version ↔ provider app id + version; `sarvam_applications` is the start) → `provider_deployments` → `number_assignments` → `conversation_sessions`.
- **Durable work:** one free Worker cron trigger calls an internal dispatcher that drains a Postgres `jobs` table. Every handler is idempotent on `idempotency_key`; failures back off; after N attempts a job moves to `dead_letter` and raises an alert. Uncertain paid calls are **never** retried automatically (already enforced: `outcome_unknown`).
- **Channel-neutral core:** organizations, agents, knowledge, tools, contacts, usage and wallet are shared; voice (`call_logs`, call events) and WhatsApp (`whatsapp_*`) keep their own sessions, delivery state, billing kinds and compliance.
- **Tenant context in tools (G):** tool calls resolve the tenant server-side from Klyro-issued identifiers (call row, deployment, connection, active number, per-call token) and never from model output. This is already true for the client-context endpoint and outbound webhooks.

---

## 4. Database changes (incremental)

| Phase | Change                                                                                                                                                                                                                                                                                                    | Status                                                          |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 0     | `employee_type`, `sarvam_applications`, `sarvam_application_id` (+ guards)                                                                                                                                                                                                                                | **In production** (`20261111090000`)                            |
| 0     | Wallet functions read the real balance for `service_role`                                                                                                                                                                                                                                                 | **In production** (`20261110100000`)                            |
| 1     | `wallet_balances` running balance (trigger-maintained, same transaction), append-only ledger (UPDATE and TRUNCATE blocked); one debit per call stays enforced by the existing `idx_wallet_tx_call_usage_ref`                                                                                              | **In production** since 2026-11-11 05:26 UTC (`20261111090100`) |
| 2     | `jobs` queue (`20261111090200`): idempotent enqueue, leased claims with SKIP LOCKED, fenced complete/fail, exponential backoff, dead-letter, stats, prune; Worker cron trigger every minute; Sarvam call reconciliation and finalization sweeps; admin "Background jobs" page                             | **Implemented, tested, awaiting production approval**           |
| 3     | Agents many-per-organization: drop `agent_configs.business_id UNIQUE` in favour of `(organization_id, id)` ownership; `agent_templates`; `provider_app_mappings`                                                                                                                                          | Planned (touches 37 `businesses` call sites)                    |
| 4     | Number lifecycle: extend `phone_numbers.status` to the C-list (`purchasing`, `purchased`, `synchronizing`, `assigned`, `inbound_active`, `outbound_enabled`, `suspended`, `releasing`, `released`, `failed`), `number_assignments` history with a unique active assignment, rental cost/reference columns | Planned                                                         |
| 4     | Call lifecycle: add `queued`, `submitting`, `accepted`, `reconciliation_required`; billing state (`pending`, `settled`, `reversed`, `disputed`) on usage instead of overloading call status                                                                                                               | Planned                                                         |
| 5     | Consent: `contact_consents` (basis, source, time), `suppression_list` (org-wide + global DND), calling windows per campaign/timezone, `campaigns.budget_paise`, per-campaign concurrency cap; `dispatch_mode` already enforces one authoritative scheduler per campaign                                   | Planned                                                         |
| 6     | Retention: per-table retention policy + purge jobs; customer export and deletion jobs (organization delete already cascades, and the wallet cache follows it)                                                                                                                                             | Planned                                                         |

Partitioning of event tables (`call_logs`, webhook events, transcript segments) is deferred until a table reaches measured size/latency limits; today the largest table is 568 KB.

---

## 5. Security risks

1. **Service-role isolation in code** (Section 1, item 5). Mitigation: a lint/test that every `supabaseAdmin` query in a tenant path filters by an `organization_id` derived from the authenticated session or a Klyro-issued identifier.
2. **Unexplained Worker secret** named `6142eeca…` (48 hex chars), added alone via wrangler on 2026-09-16 09:03 UTC, read by no code. Likely a value pasted as a name. Not deleted (owner decision).
3. **`PLATFORM_ADMIN_BOOTSTRAP_SECRET`** still set after an admin exists (bootstrap works once; low risk, removable).
4. **Shared provider applications**: disabled until isolation is documented (Section 2).
5. **No consent records** for outbound voice campaigns (requirement: consent, DND, calling windows) before any campaign is armed.
6. **MCP tokens** grant operator access to the whole Sarvam workspace, including transcripts; keep them on admin machines only, never in the Worker.

---

## 6. Measured capacity (Phase 1 evidence)

Command (local throwaway PostgreSQL 17, 16 logical CPUs, no network; numbers are
**upper bounds** for the database layer, not for Supabase over the network):

```
node scripts/loadtest/db-hotpaths.mjs --port 55432 --tenants 2000 --clients 16 --seconds 10
```

| Scenario (2,000 tenants, 16 clients)              | Before Phase 1                       | After Phase 1                           |
| ------------------------------------------------- | ------------------------------------ | --------------------------------------- |
| Call settlement spread across tenants             | 19,521/s, 0.82 ms                    | 15,715/s, 1.02 ms (extra balance write) |
| Settlement, one hot tenant (row-lock bound)       | 677/s, 23.6 ms                       | 790/s, 20.2 ms                          |
| Same call settled by 16 clients at once           | exactly 1 debit                      | exactly 1 debit                         |
| Dial reservation, same destination, 16 clients    | exactly 1 winner (36,832 attempts/s) | exactly 1 winner                        |
| Duplicate webhook events (1,000 ids)              | 1,000 rows (80,599 inserts/s)        | 1,000 rows                              |
| Member read under RLS vs service role             | 1.28 ms vs 0.34 ms\*                 | 1.32 ms vs 0.35 ms\*                    |
| Cross-tenant rows visible to a member             | 0 of 20                              | 0 of 20                                 |
| `wallet_can_afford`, 100 / 10k / 100k ledger rows | 0.22 / 1.17 / 10.75 ms               | 0.22 / 0.18 / 0.20 ms                   |
| Cached balance vs ledger sum mismatches           | n/a                                  | 0                                       |

\* The RLS row includes three extra statements per transaction (role switch,
claim set, reset), so it overstates pure policy overhead.

### Phase 2 measurements (same harness, same machine, 16 clients)

| Scenario                                                                  | Result                                                     |
| ------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 20,000-job backlog drained by 16 concurrent runners (claim 10 + complete) | every job ran exactly once, 0 left unfinished, 0 ran twice |
| Idempotent enqueue, 50,000 possible keys, 16 clients for 5 s              | 28,003/s, 40,894 rows (one per distinct key)               |

Not yet measured: queue behaviour on Supabase over the network, and Worker CPU per
scheduled tick (Workers' CPU limit depends on the account plan; the tick is mostly
I/O wait, but this must be confirmed from Workers metrics after deploy).

**Unknown, and how to measure them** (none may be claimed until measured):

| Quantity                                          | Why unknown                                                      | How                                                                                                                           |
| ------------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Sarvam APS / concurrency ceiling for this account | Plan-specific, not published                                     | Ask Sarvam for the plan limits; then an approved, rate-limited test campaign to the test number                               |
| Webhook-to-settlement latency in production       | Needs real provider traffic                                      | Correlation id from call row through webhook; log p50/p95                                                                     |
| Supabase connection/pooler limits under load      | Depends on plan; local test has no network                       | Mocked-provider load test against a non-production Supabase project (none exists today; Supabase branching or a free project) |
| Worker CPU per webhook                            | Not instrumented                                                 | Workers analytics (free) after adding timing logs                                                                             |
| Recording storage growth                          | Recordings stay in Sarvam today                                  | Analytics API `recordings` sizes per call                                                                                     |
| Cost per call                                     | Provider cost is configured (₹3.50/min outbound), not reconciled | Compare Sarvam usage export with `usage_records` monthly                                                                      |

**Cost notes.** Phases 1–2 use only free features (Postgres, Worker cron trigger). Cloudflare Queues would need the Workers paid plan; not proposed until the Postgres job table is measured as the bottleneck. Sarvam numbers are rented from Sarvam wallet credits per 30 days (price per number in their catalog).

---

## 7. Phased plan

| Phase | Scope                                                                                                                                                                          | Production impact                 | Approval                        |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------- | ------------------------------- |
| 0     | AI employees, templates registry (gated), wallet service-role fix, admin Sarvam panel, read-only Sarvam check                                                                  | Done                              | Approved 2026-11-11             |
| 1     | O(1) wallet balance, append-only ledger; DB hot-path load test                                                                                                                 | 1 migration                       | **Needed** for `20261111090100` |
| 2     | Free Worker cron trigger + Postgres `jobs` queue with idempotency, backoff, dead-letter, queue-age metric; move existing cron routes onto it. Campaign dispatch stays disarmed | Code + 1 migration + cron trigger | Needed                          |
| 3     | Provider interface `VoiceAgentProvider` with capability flags (authoring `manual`, number purchase `unsupported`, …); many agents per organization                             | Code + migration                  | Needed                          |
| 4     | Number and call lifecycle states; usage pending/settled/reversed/disputed                                                                                                      | Migration                         | Needed                          |
| 5     | Consent, suppression, calling windows, budgets, concurrency caps; campaigns require explicit launch approval                                                                   | Code + migration                  | Needed                          |
| 6     | Observability (correlation ids, webhook failure alerts, provider health, usage alerts), retention, export/deletion                                                             | Code + migration                  | Needed                          |
| 7     | WhatsApp on the shared agent/contact/billing core                                                                                                                              | Code + migration                  | Needed                          |

Each phase ships with: unit tests, a real-PostgreSQL test in CI, a load-test scenario
in `scripts/loadtest/`, a rollback script captured from production before applying,
and explicit approval before any production migration or deploy.
