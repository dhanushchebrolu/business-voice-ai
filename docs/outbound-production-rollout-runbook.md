# Outbound single calls: production rollout runbook

Prepared 2026-11-19 from read-only checks of production. **Nothing in this document has been executed.** Every step marked GATE needs its own explicit approval. Background: `docs/outbound-calling.md` (how it works) and `docs/outbound-single-call-go-live.md` (Sarvam v6 gates).

## 1. Preflight results (read-only, 2026-11-19)

| Check                | Result                                                                                                                                                                                                                 |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Release commit       | `8270fc96c39e26bac498ad689d12f301a6062a3c` on `feature/provisioning-phase1` (local, remote and the provisioning worktree agree); 53 commits ahead of `main`                                                            |
| CI                   | Run `44528772294` on `8270fc9`: success on every step; the PostgreSQL step allows no skips                                                                                                                             |
| Live Worker          | `klyro` version `a48eef80-5249-4fcc-b3c0-638c2b66f93e` (code `e48ff18`), 100%, 28 bindings. It is also the **latest uploaded** version, so a new upload inherits exactly these bindings                                |
| Production database  | PostgreSQL 17.6. Migration history = repo history (70), except `20261119090000` (not applied)                                                                                                                          |
| Schema compatibility | None of the new columns, indexes, constraints or the function exist. Every column the function reads exists. `idx_call_logs_sarvam_outbound_number_reservation` and `service_role` exist                               |
| Size and locks       | `call_logs` 207 rows / 656 kB; `agent_configs` 2 rows. Lock time for the migration: milliseconds                                                                                                                       |
| Open outbound calls  | 0. Outbound calls ever placed: 0                                                                                                                                                                                       |
| Sarvam outbound      | 0061: active, inbound on, **outbound off**. Smile Dental agent on v5, **not confirmed for outbound**                                                                                                                   |
| Campaigns            | none exist; 0 open campaign contacts; the `campaign.dispatch` job runs and returns `skipped: disabled`                                                                                                                 |
| Payment Enforcement  | `billing.payment_required = {"enabled": false}` (unchanged)                                                                                                                                                            |
| Smile Dental wallet  | 100,000 paise (₹1,000); outbound price 400 paise/min, no overrides                                                                                                                                                     |
| Test allowlist       | `SARVAM_OUTBOUND_TEST_ALLOWLIST` (plain var): **1 entry**, valid +91, ending **0030** (owner's test phone). Already a Smile Dental contact, not opted out, 180 inbound calls, so it passes the prior-relationship rule |

### Live risk found during preflight

Vobiz number …0870 has `outbound_enabled = true`, and the live Worker has Vobiz credentials. In the live code (`e48ff18`) the old generic `initiateOutboundCall` server function lets **any signed-in Smile Dental member (staff included)** dial from …0870 with no allowlist, calling hours, relationship rule, limits or cost cap. No outbound call has ever been placed, and nothing in the UI calls it, but the endpoint is reachable. `8270fc9` retires that function. Interim fix, if wanted before the deploy (**GATE R0**, production data change, reversible):

```sql
UPDATE public.phone_numbers SET outbound_enabled = false
 WHERE right(e164, 4) = '0870' AND provider ILIKE 'vobiz' AND status = 'active';
-- rollback: SET outbound_enabled = true with the same WHERE
```

## 2. Configuration

| Setting                                                                                                          | Live value                              | Needed for the test  | Notes                                                                                  |
| ---------------------------------------------------------------------------------------------------------------- | --------------------------------------- | -------------------- | -------------------------------------------------------------------------------------- |
| `SARVAM_OUTBOUND_TEST_ALLOWLIST`                                                                                 | set, 1 entry (…0030)                    | **keep as is**       | already restricted to one number; do not remove until the legal questions are answered |
| `OUTBOUND_CALLING_DISABLED`                                                                                      | absent (= calls allowed by this switch) | absent               | the emergency stop; see §6                                                             |
| `OUTBOUND_ALLOWED_COUNTRY_CODES`                                                                                 | absent (= `91`)                         | absent               |                                                                                        |
| `OUTBOUND_CALLING_HOURS`                                                                                         | absent (= 09–21 IST)                    | absent               | place the test call between 09:00 and 21:00 IST                                        |
| `CAMPAIGN_DISPATCH_ENABLED`                                                                                      | absent (= off)                          | **must stay absent** |                                                                                        |
| `KLYRO_DISPATCH_MODE`                                                                                            | absent (= no Sarvam-cohort campaigns)   | **must stay absent** |                                                                                        |
| `VOICE_AGENT_OUTBOUND_ENABLED`                                                                                   | absent (= LiveKit outbound off)         | must stay absent     |                                                                                        |
| `BYPASS_BILLING_GATES`                                                                                           | absent                                  | must stay absent     |                                                                                        |
| `SARVAM_API_KEY`, `SARVAM_VOICE_AGENTS_API_KEY`, `SARVAM_ORG_ID`, `SARVAM_WORKSPACE_ID`, `SARVAM_WEBHOOK_SECRET` | secret, present                         | present              | values not read                                                                        |
| `TELEPHONY_WEBHOOK_BASE_URL`                                                                                     | `https://clickai.in`                    | same                 | result webhook host                                                                    |

No new setting has to be created for the rollout.

## 3. Release artifacts

**Migration** — `supabase/migrations/20261119090000_outbound_call_admission.sql`, SHA-256 `f7d10f0d1076f7787731ff529b1eee17a767bf707f3937bfb88334dd85ce764e`. Adds `agent_configs.sarvam_outbound_max_call_seconds`; `call_logs.idempotency_key`, `billing_cap_minutes`, `billing_rate_per_minute`; three CHECKs; four indexes; `admit_single_outbound_call` (service role only). Additive; existing rows unchanged.

**Rollback SQL** — `docs/production-rollback-20261119090000-outbound-call-admission.sql`, SHA-256 `f0b9d90fae2d46aff4148e2a2f52766402e7c7039c20e79c6e8dffa747cb63af`. Tested forward → rollback → re-apply in CI and on a local PostgreSQL 18.

**Worker** — `klyro`, built from `8270fc9`, uploaded as a new version (inherits the live bindings) and deployed at 100%. Rollback target: `a48eef80-5249-4fcc-b3c0-638c2b66f93e`.

**What changes for users (e48ff18 → 8270fc9, 49 files):**

| Area                                                     | Change                                                                                                                                                                                                                                            | Live inbound impact  |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| Calls page (`/app/calls`)                                | "Call a number" button (hidden unless a Sarvam number exists; shows why calling is unavailable); outbound rows show the dialled number; readable statuses/outcomes                                                                                | display only         |
| Admin provisioning                                       | confirming outbound now requires the agent's max call length                                                                                                                                                                                      | none                 |
| Server functions                                         | `createSarvamInstantOutboundCall`, `placeAdminSarvamOutboundCall` go through atomic admission and the safety gate; new `getOutboundCallingStatus`; `initiateOutboundCall` retired; campaign launch and Sarvam campaign start obey the kill switch | none (outbound only) |
| Sarvam tool endpoints `/api/public/sarvam/agent/tools/*` | `book_appointment` / `request_callback` refuse only when the body carries an outbound `clickai_call_id` (v5 never sends it)                                                                                                                       | none                 |
| Call outcomes / leads                                    | lead direction decided by exact interaction match (inbound leads save immediately when no outbound call is open, which is always today)                                                                                                           | none expected        |
| Finalization, jobs                                       | single-call opt-outs go on do-not-call; capped billing; stuck starts flagged after 30 min; campaign dispatch obeys the kill switch                                                                                                                | outbound only        |

## 4. Rollout steps

Each GATE stops for approval. Order matters.

| #   | Step                                                                                                                                                                                                              | Command / action                                                                                                                                                                                                                                                                                 | Gate                            |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------- |
| 1   | Sarvam v6 draft: add `{"name":"clickai_call_id","type":"agent_variable","value":{"variable_name":"clickai_call_id"}}` to `book_appointment` and `request_callback`; disable `send_reminder`; text-test; commit v6 | Sarvam console or MCP                                                                                                                                                                                                                                                                            | **GATE R1**                     |
| 2   | Migration dry run                                                                                                                                                                                                 | `npx supabase db push --linked --dry-run` — must list exactly `20261119090000_outbound_call_admission.sql`                                                                                                                                                                                       | none (read-only)                |
| 3   | Apply migration                                                                                                                                                                                                   | `npx supabase db push --linked`                                                                                                                                                                                                                                                                  | **GATE R2**                     |
| 4   | Verify migration                                                                                                                                                                                                  | §5.1 queries                                                                                                                                                                                                                                                                                     | none                            |
| 5   | Build and upload Worker                                                                                                                                                                                           | from `8270fc9`: `bun install --frozen-lockfile`, `npm run build` with the production `VITE_SUPABASE_URL` and the plain `SUPABASE_PUBLISHABLE_KEY` value, then `npx wrangler versions upload --name klyro --message "outbound 8270fc9"`; diff bindings against `a48eef80` (must be identical, 28) | **GATE R3**                     |
| 6   | Deploy                                                                                                                                                                                                            | `npx wrangler versions deploy <new-version-id>@100% --name klyro --yes`                                                                                                                                                                                                                          | **GATE R4**                     |
| 7   | Verify deploy                                                                                                                                                                                                     | §5.2                                                                                                                                                                                                                                                                                             | none                            |
| 8   | Remap Smile Dental to v6, then one inbound check call from …0030                                                                                                                                                  | ClickAI admin (verified remap)                                                                                                                                                                                                                                                                   | **GATE R5** (real inbound call) |
| 9   | Admin → provisioning: "Confirm this version for outbound", max call length **15** minutes; admin → numbers: outbound **on** for 0061                                                                              | ClickAI admin                                                                                                                                                                                                                                                                                    | **GATE R6**                     |
| 10  | One supervised outbound call (§7)                                                                                                                                                                                 | admin panel "Place call"                                                                                                                                                                                                                                                                         | **GATE R7** (paid call)         |
| 11  | After the call: outbound **off** on 0061 again unless continuing supervised tests                                                                                                                                 | ClickAI admin                                                                                                                                                                                                                                                                                    | none                            |

## 5. Verification

### 5.1 After the migration (read-only)

```sql
SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = '20261119090000';      -- 1
SELECT count(*) FROM pg_proc WHERE proname = 'admit_single_outbound_call';                        -- 1
SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public'
   AND ((table_name = 'call_logs' AND column_name IN ('idempotency_key','billing_cap_minutes','billing_rate_per_minute'))
     OR (table_name = 'agent_configs' AND column_name = 'sarvam_outbound_max_call_seconds'));      -- 4
SELECT has_function_privilege('authenticated',
  'public.admit_single_outbound_call(uuid,uuid,text,text,text,integer,integer,integer,integer)', 'EXECUTE'); -- false
SELECT count(*) FROM public.call_logs;                                                            -- unchanged (≥ 207)
```

### 5.2 After the Worker deploy

- `npx wrangler deployments status --name klyro` shows the new version at 100%.
- https://clickai.in loads; sign-in works; `/app/calls` shows history and the "Call a number" button explains outbound is not switched on for 0061.
- An inbound call still works (GATE R5), and its `call_logs` row, context request and outcome event appear as before.
- Logs (`wrangler tail --name klyro`, a few minutes): no new `error` lines; the 5-minute job tick runs; `campaign.dispatch` still `skipped: disabled`.
- Read-only: no rows with `idempotency_key` yet; `SELECT count(*) FROM call_logs WHERE direction = 'outbound'` = 0.

## 6. Rollback and emergency stop

| Situation                 | Action                                                                                                                            | Effect                                                                    |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Stop outbound immediately | admin: outbound **off** on 0061 (or `UPDATE phone_numbers SET outbound_enabled = false WHERE right(e164,4) = '0061'`)             | refuses new calls at once; calls in progress finish and bill normally     |
| Stop every outbound path  | add `OUTBOUND_CALLING_DISABLED=true` and deploy it as a new version                                                               | stops single calls, LiveKit and campaigns                                 |
| Bad Worker                | `npx wrangler versions deploy a48eef80-5249-4fcc-b3c0-638c2b66f93e@100% --name klyro --yes`                                       | the old code ignores the new columns; the migrated schema is safe to keep |
| Bad migration             | only **after** the Worker rollback: run `docs/production-rollback-20261119090000-outbound-call-admission.sql` (pre-checks inside) | removes exactly what the migration added; call rows survive               |
| v6 misbehaves             | remap Smile Dental to v5; withdraw outbound readiness                                                                             | inbound returns to v5                                                     |

## 7. One-call controlled test (GATE R7)

**Preconditions:** steps 1–9 done; between 09:00 and 21:00 IST; Sarvam credit balance checked in the console (94 credits at the last check); someone holding phone …0030; no other outbound call open.

**Action:** ClickAI admin → Smile Dental → Sarvam outbound panel → "Place call": from 0061 to …0030, reason "Supervised test call", tick approval, reason for audit. Exactly once (the request id makes a repeat return the same call).

**During the call (the person on …0030):** confirm the opening line names Smile Dental and asks if it is a good time; ask to book (the agent must refer them to the clinic, not book); say "please don't call me again".

**After (read-only SQL):**

```sql
SELECT id, status, duration_seconds, billing_cap_minutes, billing_rate_per_minute, customer_charge,
       finalization_state, idempotency_key IS NOT NULL AS has_key
  FROM call_logs WHERE direction = 'outbound' ORDER BY started_at DESC LIMIT 1;
-- expect: completed, cap 15, rate 400, charge = ceil(duration/60) * 400, finalization done
SELECT kind, status, detail->>'error_code' FROM sarvam_agent_events
 WHERE created_at > now() - interval '30 minutes' ORDER BY created_at;
-- expect: no book_appointment/callback with status ok; if called, rejected OUTBOUND_*
SELECT opted_out, opted_out_reason FROM contacts WHERE right(phone, 4) = '0030';
-- expect: opted_out = true ("Requested during an outbound call") — reverse afterwards via
-- the owner's "reverse opt-out" action with a reason, so the test number can be used again
```

Also: no `call_finalization:billing_capped` log (if present, Sarvam ignored the 15-minute limit).

**Abort criteria:** the agent books or promises a callback; the opening line is the inbound greeting; the charge exceeds 15 × ₹4; any unexpected error log. Then outbound off on 0061 and investigate.

**Cost and risk of the test:**

|                                                      | Estimate                                                                                |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Customer charge (Smile Dental wallet)                | ₹4 per started minute; expected 1–3 min = ₹4–₹12; hard cap 15 min = ₹60 (wallet ₹1,000) |
| ClickAI's provider cost (configured `provider_cost`) | ₹3.50 per started minute, uncapped if Sarvam ignored the limit                          |
| Sarvam credits                                       | per-minute credit rate **not verified**; check the console balance before and after     |
| Who can be called                                    | only …0030 (allowlist + relationship rule + per-number limit of 2 a day)                |
| Side effects                                         | …0030 is marked do-not-call by the opt-out step (intended; reversible by the owner)     |

## 8. Safety confirmation (this preparation)

No campaign was activated or dispatched, no contacts were uploaded, no call was placed, no migration was applied, nothing was deployed, Sarvam was not published or remapped, Smile Dental and Payment Enforcement were not changed. All production access was read-only (`begin transaction read only … rollback`, `wrangler deployments status / versions view / versions list`).
