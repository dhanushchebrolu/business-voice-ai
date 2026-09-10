# Sarvam Provider-Mapping Implementation Report

Builds directly on `SARVAM_TELEPHONY_MIGRATION_FINAL_REPORT.md` (Phase 1 verification) and the approved V1 design/security review from this session. This is the first phase where real, working code — not just adapter scaffolding — was implemented and committed. Exotel is untouched. No Sarvam API call has been made; none is claimed to work.

## What this phase implements

The approved V1 architecture: Sarvam app creation, connection creation, and managed-number rental are manual Sarvam-dashboard steps (no public API found for any of them — not guessed). This phase automates the Klyro-side bookkeeping for that manual step and the boundary for what comes after it.

### 1. Database migration — `20260908110000_sarvam_provider_mapping.sql`

Three nullable columns, no new table:
- `agent_configs.sarvam_app_id text`, `agent_configs.sarvam_app_version integer`
- `telephony_connections.provider_connection_id text`
- `phone_numbers.provider_deployment_id text`

Plus the security-review-corrected grants and indexes:
- `agent_configs`' blanket authenticated `INSERT`/`UPDATE` grant is replaced with an explicit column list, **verified against the actual current client code** (`app.onboarding.tsx`'s insert, `app.agent.tsx`'s update) rather than guessed — both are also asserted programmatically in the test suite (see below), so any future drift between the grant and the real client code is caught automatically.
- Two partial unique indexes (`agent_configs.sarvam_app_id`; `telephony_connections(provider, provider_connection_id)`), both `WHERE ... IS NOT NULL` so unmapped rows never collide.
- One plain (non-unique) index on `phone_numbers.provider_deployment_id` — deliberately **not** unique, because one Sarvam deployment can span multiple phone numbers.
- `telephony_connections`/`phone_numbers` needed no new grant — both were already admin/service-role-write-only.
- SELECT is deliberately left unrestricted on all three new columns (security review: they're inert identifiers, no privilege-escalation path exists, and restricting them would have broken `workspace.ts`'s existing `select("*")` on `agent_configs`).

`src/integrations/supabase/types.ts` updated by hand to match (no live Supabase codegen access in this sandbox).

### 2. Adapter boundary — `sarvam-provider.server.ts`

Added `SarvamTelephonyConfig.orgId`/`workspaceId` (optional — the webhook-processing path needs neither, so their absence never breaks it) and `createInboundDeployment(input): Promise<{deploymentId}>`. Per your explicit instruction, this method does **not** call Sarvam:
- If `orgId`/`workspaceId` aren't configured, throws a distinct "not configured" error.
- Otherwise throws "not implemented — X-API-Key auth unverified against a live response, apps.sarvam.ai unreachable from this sandbox regardless."

`telephony.server.ts`'s `sarvam` branch now reads `SARVAM_ORG_ID`/`SARVAM_WORKSPACE_ID` (optional) alongside the existing `SARVAM_API_KEY` (required).

### 3. Three admin operations — new file `sarvam-admin.functions.ts`

All three: `assertPlatformAdmin`-gated, write through `supabaseAdmin` (service_role) only, audited via `writeAudit`.

- **`setSarvamAppMapping`** (`agents.write`) — validates `sarvamAppId` non-empty and `sarvamAppVersion` a positive integer, updates `agent_configs`, translates the unique-index violation into "This Sarvam app is already mapped to a different agent." **Fully working today** — no Sarvam API dependency.
- **`registerTelephonyConnection`** (`numbers.write`) — upserts one `telephony_connections` row per `(org, provider='sarvam')`, translates the unique-index violation into "This Sarvam connection ID is already registered to a different organization." **Fully working today** — no Sarvam API dependency.
- **`createSarvamInboundDeployment`** (`numbers.write`) — validates every phone number in the request shares one organization (this is what makes cross-tenant mapping structurally impossible, not just checked), one connection, and one agent; validates the connection is Sarvam-registered and the agent is Sarvam-mapped; only then calls the adapter's `createInboundDeployment`, which throws as described above. **Validation is fully working and tested; the actual deployment call is not, and does not fake success** — `provider_deployment_id` is never written and no audit record is created unless the adapter call genuinely succeeds (it can't yet).

## Deterministic tests — 31 new (264/264 total, up from 233)

- `sarvam-admin.functions.test.ts` (17) — admin-gating on all three functions before any DB write; service_role-only writes; duplicate-app/duplicate-connection rejection; cross-tenant/cross-connection/cross-agent rejection; validation-before-Sarvam-call ordering; "no fake success" ordering (adapter call → DB write → audit, strictly in that order); multi-number-per-deployment support.
- `sarvam-provider-mapping-migration.test.ts` (10) — schema-level proof of every grant/index claim above, including two **cross-file consistency checks** that parse `app.onboarding.tsx`/`app.agent.tsx`'s actual column usage and assert it's a subset of the migration's grant lists (so onboarding/settings breaking would fail this test, not just be asserted by inspection).
- `sarvam-provider.server.test.ts` (+2) — `createInboundDeployment`'s two-stage fail-closed behavior.
- `telephony.server.test.ts` (+2) — `SARVAM_ORG_ID`/`SARVAM_WORKSPACE_ID` are optional for adapter construction, and, when set, actually reach the adapter's config.

## Verification results

- Full suite: **264/264 passing**.
- Typecheck: clean.
- Build: succeeds.
- Lint (touched scope): clean — all issues were prettier-only, auto-fixed. `src/integrations/supabase/types.ts` (generated file) has pre-existing, file-wide prettier non-compliance unrelated to this change (confirmed: errors start at line 1, nowhere near my 3 additions, which match the surrounding style exactly) — not reformatted, to avoid touching thousands of unrelated lines.
- Secret scan (touched scope): no matches. Confirmed separately: the actual `SARVAM_ORG_ID`/`SARVAM_WORKSPACE_ID` UUID values you shared are not hardcoded anywhere — only referenced as env var names.

## What is still not live

Everything requiring an actual Sarvam API call remains unimplemented, exactly as instructed:
- `createInboundDeployment`'s real HTTP request (X-API-Key auth unverified against a live response; `apps.sarvam.ai` unreachable from this sandbox independent of credentials).
- Campaign/instant-outbound submission, agent create/update, number rental — all still throw the same honest "not implemented" errors from the prior phase, untouched.
- Webhook authentication remains fail-closed (`SARVAM_WEBHOOK_AUTH_VERIFIED = false`), untouched.

## Exotel

No Exotel file was read, modified, or deleted this phase. `git status` confirms the diff touches only the files listed above.

## Commit

Committed locally to `claude/apply-phase-abc-patch-vcoamf`, not pushed, not merged into main, per instruction.
