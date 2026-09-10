# Sarvam Telephony Migration — Final Report

Status: **Phase 1–3/10/13 complete. Phases 4–9, 11, 12, 14 blocked by unverified Sarvam wire contracts and the absence of Sarvam credentials in this environment.** Exotel remains fully in place, as required. This report is deliberately honest about what is and is not done — nothing below is claimed working that hasn't been verified.

## 1. Architecture before

Klyro brought its own telephony carrier (Exotel): Exotel did call control and streamed **raw 8kHz linear16 PCM audio** to Klyro over a WebSocket (Voicebot Applet). Klyro ran its own STT→LLM→TTS loop (`voice-runtime.server.ts` + `sarvam-realtime.server.ts`, using Sarvam only as the STT/TTS/LLM vendor) against that raw audio, coordinated across Cloudflare Worker isolates by a dedicated Durable Object (`CallSessionDurableObject`) because a live WebSocket and its correlated webhook could land on different isolates.

## 2. Architecture after (target, partially built)

Sarvam Voice Agents owns the number, the call, and the entire STT/LLM/TTS conversation internally. Klyro's job shrinks to: configure the agent, attach it to a number (inbound) or a campaign (outbound), and receive a webhook once something happened. **No live audio ever reaches Klyro's servers in this model** — so the Durable Object, the media bridge, and Klyro's own realtime STT/TTS client become unnecessary once Sarvam is live. This shift is architecturally straightforward (a provider adapter + webhook), but nearly every concrete detail (exact endpoints, exact request bodies, exact webhook auth) that a real implementation needs remains unverified — see §4.

## 3. Official Sarvam API references used

`docs.sarvam.ai` is egress-blocked from this sandbox at the network-policy level (confirmed repeatedly across this migration's sessions — direct fetch, the `.md`-suffix route, and `llms.txt` all denied; the MCP server endpoint is the same host and was not separately retried, per instruction not to repeatedly hit a blocked host). All verification in this report came from web-search result snippets (which surface real page titles/URLs and short quoted fragments, not full page content) plus payload schemas the user supplied directly, copied from the live docs. Pages referenced, by URL:

- `docs.sarvam.ai/api-reference-docs/authentication`
- `docs.sarvam.ai/conversations/overview`
- `docs.sarvam.ai/conversations/deploy/deploy-with-code`
- `docs.sarvam.ai/conversations/deploy/telephony` ("Phone Numbers")
- `docs.sarvam.ai/conversations/settings/secrets`
- `docs.sarvam.ai/conversations/api/campaigns/webhook-payload`
- `docs.sarvam.ai/api-reference/instant-outbound` and `.../webhook-payload`

## 4. The six wire details and their verified contracts

| # | Item | Verified | Not verified |
|---|---|---|---|
| A | Voice Agent create/update | Capability exists ("create or update an agent configuration... programmatically") | Endpoint path, method, request/response body |
| B | Managed number provisioning | Rental happens "directly inside Voice Agents," fulfilled via a Sarvam-managed Vobiz partner account, KYC required | Endpoint path, method, request/response body, ID field names |
| C | Inbound deployment | Named concept confirmed ("create an Inbound deployment to route the number to an agent") | Endpoint path, method, request/response body |
| D | Outbound campaign/call submission | Two distinct products confirmed: Campaigns and Instant Outbound; `webhook_config` confirmed as a real Instant-Outbound request field, echoed onto the resulting webhook | Endpoint path, method, full request body for either product |
| E | Webhook authentication | Sarvam's dashboard has **Settings → Secrets** for "webhook authentication headers and tokens" (2 independent, consistent search results) — a dashboard-configured shared secret/token sent as a header is the strongly implied shape | **Exact header name and comparison algorithm — not found.** Security-critical; not implemented on that basis. |
| F | Outbound correlation field | The verified webhook *output* schema already contains `user_identifier` and `metadata` (both wired as candidates, output side only) | Whether/how Klyro can *set* either at creation time (gated by D) |

Full inbound and outbound campaign webhook **payload field lists** (not endpoint contracts — these were separately confirmed by the user from live docs and are fully implemented):

- Inbound completion: `app_id, app_version, deployment_id, interaction_id, user_phone_number, agent_phone_number, duration, final_agent_variables, output_agent_variables, start_datetime, end_datetime, interaction_transcript ({role, en_text, indic_text?}), metadata`. Sent once, after the call finishes.
- Outbound campaign attempt: `app_id, app_version, attempt_id, campaign_id, cohort_id, completion_status, connectivity_status, next_action_status, failure_reason, user_identifier, user_phone_number, agent_phone_number, duration, interaction_id, retry_attempt, executed_at, start_datetime, end_datetime, initial/final/output_agent_variables, interaction_transcript, metadata`. Sent after every attempt, including unconnected ones.

**Per your own Phase 1 rule and Critical Safety Rule #16, items A–E block real implementation of Phases 2, 3 (live provisioning), 4, 5 (live deployment), 6 (live campaigns), 7 (real signature check), and by extension 9, 11, 12, 14.** Nothing was guessed to work around this.

## 5. Number provisioning flow

**Not implemented against a real endpoint** (item B unverified). `SarvamTelephonyAdapter.provisionNumber`/`releaseNumber` throw explicit "not implemented, endpoint unverified" errors rather than guessing. The Klyro-side control plane this would plug into is already correct and unchanged: `phone_numbers` stays the single table, `provisionPhoneNumber`/`reassignPhoneNumber`/`releasePhoneNumber` in `telephony-admin.functions.ts` are already admin-gated (`assertPlatformAdmin(..., "numbers.write")`), reassignment already atomically clears business/agent linkage and forces `status: "provisioning"` + both direction flags off in one update, and duplicate/cross-tenant activation is already prevented by the database's global unique-active-`e164` index (23505 handling). These were pre-existing (Phase D) and now have dedicated tests (§17) confirming the invariants hold — no code change was needed here, only test coverage that was missing before.

## 6. Agent synchronization flow

**Not implemented** — gated on item A. Klyro's `agent_configs`/`agent_versions` remain the source of truth (unchanged); no data was moved into Sarvam as primary storage. No sync code was written because there is no verified endpoint to sync against.

## 7. Inbound flow

Partially implemented (from the prior session, unchanged this session): webhook → signature check → **fails closed** (item E unverified) → *(once E is resolved)* normalized from the verified payload schema → tenant resolved via `phone_numbers` lookup on `agent_phone_number` (Klyro's own record, never the payload) → `call_logs` row created with `transcript`/`duration_seconds`/`ended_at` captured directly (since Sarvam's one-shot terminal webhook has no later event to patch these in) → `finalizeCallBilling` runs unchanged. Real inbound deployment configuration (item C) is not implemented.

## 8. Outbound campaign flow

Designed and partially wired (from the prior session): a Klyro-created `call_logs` tracking row's own UUID `id` is the client-reference design; `resolveOutboundCallByClientReference` looks it up (filtered by `id` + `provider` + `direction`, format-guarded by `isPlausibleClientReference`) and never falls back to phone number. Real campaign/instant-outbound submission (item D) is not implemented — `initiateOutboundCall` throws until it is.

## 9. Webhook security

`verifyWebhookSignature` **fails closed unconditionally** (`SARVAM_WEBHOOK_AUTH_VERIFIED = false`) — every Sarvam webhook is rejected until a real, confirmed mechanism (header name + algorithm) is implemented. This is a deliberate choice, not an oversight: per your Phase 7 instruction, "if Sarvam currently provides no cryptographic webhook signature, do NOT pretend it does" — and since even the *existence* of one couldn't be confirmed beyond the Settings → Secrets lead, failing closed is the only honest option. Content-type/size/schema validation, replay-safety via the existing `webhook_events (provider, event_id)` unique index, and never logging secrets or full payloads unnecessarily are all already how the shared webhook route behaves for every provider — unchanged.

## 10. Tenant isolation

Unchanged from the prior session, now with additional test coverage (§17): inbound resolves organization only from Klyro's own active `phone_numbers` row matching the called number; outbound resolves only from a Klyro-owned `call_logs` row matching a UUID-shaped client reference Klyro itself generated, rejected before any query if malformed. Neither path accepts an `organization_id` from any webhook payload. New this session: `telephony-admin.functions.test.ts` confirms every mutating admin function (`provisionPhoneNumber`, `activatePhoneNumber`, `reassignPhoneNumber`, `suspendPhoneNumber`, `releasePhoneNumber`, `setNumberDirection`) checks `assertPlatformAdmin("numbers.write")` before touching the database, and that `reassignPhoneNumber` clears the old tenant's business/agent linkage and both direction flags in the *same* update as the organization change — no window where the wrong tenant's flags survive.

## 11. Billing integration

Fully reused, unmodified, confirmed by new tests (§17): `checkTelephonyAccess`, `checkCallTransition`, `finalizeCallBilling`, `getCallRate`, `walletCanAffordOutbound`, `debit_wallet_for_call`, `pricing_rules`, `wallet_transactions`, `usage_records`. Three independent duplicate-billing protections were confirmed present and unmodified: (1) the call-state machine's same-status-is-a-no-op rule, (2) `debit_wallet_for_call`'s existing-reference check before inserting, (3) the storage-layer unique indexes on `wallet_transactions` and `usage_records`. `finalizeCallBilling` never branches on provider — the same function runs for Exotel or Sarvam calls alike.

## 12. Database changes

**None.** No migration was added. `phone_numbers`/`call_logs` were already provider-agnostic and originally defaulted `provider` to `'sarvam'`, predating Exotel. No `sarvam_agent_id`/`sarvam_deployment_id`-style column was added — per your own Phase 4 instruction ("first inspect the existing schema... do not create redundant identifiers... document exactly why the column is required"), adding one now would mean guessing the shape of an ID that doesn't exist yet, since the endpoints that would produce it (A, C) are unverified.

## 13. Environment variables

- Added: none new.
- Confirmed reused: `SARVAM_API_KEY` (already existed for chat/STT/TTS; verified to also authenticate this surface via the `api-subscription-key` mechanism).
- Removed (prior session): `SARVAM_TELEPHONY_ACCOUNT` — never wired to a real credential.
- Not added despite being plausible candidates, because their exact shape is unverified: a `SARVAM_WEBHOOK_SECRET`-equivalent (item E), a Sarvam base-URL variable.
- Exotel variables (`EXOTEL_SID`, `EXOTEL_API_KEY`, `EXOTEL_TOKEN`, `EXOTEL_SUBDOMAIN`, `EXOTEL_WEBHOOK_SECRET`) and `MEDIA_SESSION_TOKEN_SECRET`: **still required, not removed** — Exotel is still the only working provider.

## 14. Exotel components removed

**None.** Per Critical Safety Rule #11 and your explicit Phase 11 gate ("DO NOT delete Exotel before the Sarvam path has been proven"), and given the Sarvam path cannot be proven (six wire contracts substantially unverified, zero Sarvam credentials in this environment), Exotel removal did not happen. This is the correct outcome of following the rules as given, not a shortfall.

## 15. UI changes

**None.** Phase 14 is explicitly gated on Exotel removal (Phase 11), which did not happen. No Lovable UI work was performed.

## 16. Live tests performed

**None.** No `SARVAM_API_KEY` or any Sarvam credential is present in this environment (checked via `env | grep -i sarvam` — empty). Per Critical Safety Rule #12 ("NEVER fake a successful live test"), none of Phase 9's sixteen live-test steps were attempted or claimed.

## 17. Deterministic tests

Full suite: **233/233 passing** (207 carried over + 26 new this session):
- `telephony-admin.functions.test.ts` (17 tests, new): admin-gate-before-any-DB-write on every mutating/listing function; provisioning tenant safety and audit; duplicate-activation protection via the DB unique constraint; reassignment's atomic tenant-safety update; confirmation that customer-facing code never reaches this admin module.
- `telephony-billing-idempotency.test.ts` (9 tests, new): the three-layer duplicate-billing protection (state machine, application-layer existing-reference check, storage-layer unique indexes); `finalizeCallBilling`'s provider-agnostic reuse; `call_logs`' customer-facing grant excluding `provider_cost`/`gross_profit`/`provider_metadata`.
- Carried over from the prior session (unchanged): `sarvam-provider.server.test.ts`, `webhook-correlation.server.test.ts`, `telephony.server.test.ts`, `telephony-webhook-route.test.ts` (41 tests) plus 166 pre-existing tests across the rest of the codebase.

Typecheck: clean. Build: succeeds. Lint (touched scope): clean (prettier auto-fixed only). Secret scan (touched scope): no matches.

## 18. Remaining limitations

- Items A, B, C, D, E of §4 remain unverified; real implementation of Phases 2 (client), 3 (live provisioning), 4, 5, 6, 7 (real signature check) is blocked until they are confirmed against actual Sarvam documentation or an official machine-readable spec this environment can reach.
- No Sarvam credentials exist in this environment, independently blocking all live testing (Phase 9) regardless of the above.
- The `completion_status`/`connectivity_status` webhook status classification (already implemented, prior session) is a documented heuristic — field *names* are verified, exact string *values* are not, so it defaults conservatively to `"failed"` on anything unrecognized.
- Which of `user_identifier`/`metadata` actually carries a Klyro-supplied reference on an outbound attempt is unconfirmed, since the campaign/instant-outbound creation request body (where it would be set) is itself unverified.

## 19. Production deployment requirements

Before any of this can go live: (1) obtain the exact wire contracts for items A–E from Sarvam directly (account team, support, or a reachable copy of the docs/OpenAPI spec) — this is the single blocking dependency; (2) obtain a `SARVAM_API_KEY` with Voice Agents access for staged live testing per Phase 9's sixteen-step plan, using a clearly identifiable test organization, no bulk calls, no real customer numbers; (3) only after that path is proven, proceed to Phase 11 (Exotel removal) and Phase 14 (UI redesign) exactly as gated.

## 20. Exact commit hash

Pending commit in this session (see chat for the hash reported after this file is committed). Prior checkpoint: `42191a53cc868220f47f14826afdae00f11f1778`.
