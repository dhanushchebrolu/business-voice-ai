# One supervised Sarvam outbound call: current state and go-live steps

Prepared 2026-11-18. It adds to `docs/outbound-release-execution-checklist.md`
(Gates 0–6, already run) and replaces nothing in it. Campaign dispatch stays
off throughout. Every **GATE** needs its own explicit approval.

## 1. State verified 2026-11-18 (read-only)

| Item                                                        | Verified value                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Live Worker                                                 | `klyro` @ `bb7ef409` (100%) = code `0ad40b6` + Exotel secrets removed. Latest version `3aef6588` is undeployed (Gate 7, left untouched).                                                                                                                                                                                                                    |
| Outbound code live                                          | yes, all of it (`09327bc`, `062017e`, `0ad40b6`)                                                                                                                                                                                                                                                                                                            |
| Worker settings                                             | `SARVAM_VOICE_AGENTS_API_KEY` (used for outbound too; no separate outbound key), `SARVAM_ORG_ID`, `SARVAM_WORKSPACE_ID`, `SARVAM_WEBHOOK_SECRET`, `TELEPHONY_WEBHOOK_BASE_URL` (host `clickai.in`), `SARVAM_OUTBOUND_TEST_ALLOWLIST` (1 entry, valid +91 number). `CAMPAIGN_DISPATCH_ENABLED`, `KLYRO_DISPATCH_MODE` and `BYPASS_BILLING_GATES` are absent. |
| Migrations                                                  | 70, latest `20261118120000`                                                                                                                                                                                                                                                                                                                                 |
| Payment Enforcement                                         | `billing.payment_required` = `{"enabled": false}`                                                                                                                                                                                                                                                                                                           |
| Smile Dental agent `b2972814`                               | Sarvam `Conversatio-9c6a04cd-3334` **v5**. `sarvam_outbound_ready_app_id/_version` = **null** (not outbound-ready)                                                                                                                                                                                                                                          |
| Number 0061                                                 | Sarvam, active, inbound on, **outbound off**, connection `e16a623b` (connected, provider id set), deployment verified 2026-11-17                                                                                                                                                                                                                            |
| Wallet                                                      | 54,800 paise (₹548). Outbound rate is 400 paise (₹4) per started minute, so one short call is affordable. The phone feature is not locked.                                                                                                                                                                                                                  |
| Outbound calls / campaigns / unresolved Sarvam calls        | 0 / 0 / 0                                                                                                                                                                                                                                                                                                                                                   |
| Contacts                                                    | 2, none opted out                                                                                                                                                                                                                                                                                                                                           |
| Sarvam console state (v5 live, v6 draft, tools, connection) | **Not verified this session**: the `sarvam-voice-agents` MCP needs re-authorization.                                                                                                                                                                                                                                                                        |

## 2. What the code does today (single call)

Entry points:

- **Admin, on a customer's behalf** (`placeAdminSarvamOutboundCall`, panel "Place call"): platform admin with `numbers.write`, a ticked approval box, a reason, and an audit row for every attempt, including refused ones.
- **Customer** (`createSarvamInstantOutboundCall`): an owner or admin of the number's org. The server function exists, but **no customer UI calls it yet**.
- **Admin test** (`testSarvamOutboundCall`): demo organizations only, so it can't be used for Smile Dental (`is_demo = false`).

Gates in order:

1. Number belongs to the org.
2. Phone feature unlocked.
3. Number active with outbound enabled.
4. Sarvam number.
5. Wallet can cover 1 minute.
6. Valid E.164 destination.
7. Destination is on the allowlist.
8. Signed webhook URL can be built.
9. Destination is not opted out.
10. Connection and agent belong to the same org.
11. Agent is mapped, and the **mapped version is confirmed for outbound**.
12. No unresolved call to the same destination (checked first, then enforced atomically by a unique index).

Request:

- the same app and version as inbound;
- `call_direction=outbound`, `clickai_call_id` and `campaign_objective` (added in this change) are set last, so nothing else can override them;
- the opening line is overridden: "Hello, this is the virtual assistant calling from Smile Dental. Is this a good time to talk?".

Failures:

- a definite rejection → `failed`, zero-charge finalization;
- an ambiguous result (timeout, 5xx, 429) → `outcome_unknown`, never retried; an admin resolves it.

Result: the webhook (identifiers-only `webhook_events`, dedupe on `(provider, event_id)`) is followed by finalization:

- the outbound rate `ceil(s/60) × ₹4`;
- one `call_usage` debit per call (unique index);
- one usage record.

## 3. Change in this branch (`claude/outbound-single-call-objective`, from `0ad40b6`)

**Bug:** the admin "Place call" path dropped the call's reason. Sarvam received no `campaign_objective`, so the agent's outbound section had no reason to give. The v6 test checklist needs "one admin outbound call with an objective".

**Fix:** an optional `objective` on `placeAdminSarvamOutboundCall` → `placeSarvamCallForOrganization` → the existing `sendSarvamInstantOutboundCall`. It is sanitized and capped at 300 characters there. The panel gets a "Reason for the call" field. Two tests were added in `sarvam-admin-dashboard.server.test.ts`. No schema, setting or behaviour change for calls without a reason.

## 4. Blockers before the supervised call

1. **Sarvam v6 isn't committed.** v5, the live version, doesn't declare `call_direction` and has no outbound section. Dialled as-is, it would follow the inbound script after the opening line. Still open on the v6 draft:
   - remove `send_reminder`;
   - apply blockers 1–3 (`docs/sarvam-smile-v6-blockers-1-3-dryrun.md`: direction-integrity prompt, opt-out after-call prompts, opt-out wording);
   - add the `record_call_outcome` tool body field `opted_out` (the Worker already accepts it);
   - text-test, then commit.
2. **Smile Dental isn't remapped to v6.** This is a live change for inbound callers, so an inbound regression check must pass afterwards.
3. **Outbound readiness isn't confirmed** (`sarvam_outbound_ready_*` is null), and **outbound is off on 0061**.
4. **Caller ID and outbound permission** for 0061 on its Sarvam connection (ClickAI row `e16a623b`), and Sarvam credit, are unverified.
5. **Known risk, mitigated only by the prompt:** on outbound calls the tools' `customer_phone` / `caller_number` come from Sarvam's `user_identifier`, which is unverified for instant outbound.
   - If it's empty or not a phone number, a `book_appointment` call would save a **real booking without a phone number** (`sarvam-agent-api.server.ts:863-900`). The v6 prompt forbids `book_appointment` and `request_callback` on outbound calls.
   - The supervised call must check that no booking or callback tool ran.
   - The proper fix is a follow-up: resolve the dialled number from `clickai_call_id`.

## 5. Not built yet (needed before customers, not before the supervised call)

- **Consent and DND.** There's no voice consent record and no NCPR/DND check. The allowlist is the only thing limiting destinations. It must not be removed until a consent/DND design is decided and built.
- **A customer-facing single-call UI.**
- The outbound booking fix (see 4.5).

## 6. Go-live sequence

| #   | Step                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Gate                           |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| 0   | You re-authorize the `sarvam-voice-agents` MCP, then a read-only check: v5 live and unchanged, the v6 draft as described, connection details, credit                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | none                           |
| 1   | Review this branch, fast-forward it into `feature/provisioning-phase1`, push, CI green                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | **O1** (push syncs to Lovable) |
| 2   | Build from that commit and `wrangler versions upload`, then a binding diff against `bb7ef409`. An upload probably takes its secrets from the latest version, `3aef6588`, so expect one extra binding, `VOBIZ_WEBHOOK_VERIFY_TOKEN_PREVIOUS_EXPIRES_AT`. On its own it does nothing, because no previous token is set. Remove it before deploying (`wrangler versions secret delete`, chained on the upload) if you want an identical set; anything else different is a stop. and `versions deploy …@100%` (`wrangler.json` has `keep_vars: true`). Rollback: `npx wrangler versions deploy bb7ef409-0a54-4016-9c8e-baf636e44acb@100% --name klyro --yes`. Note: base the upload on the code, and don't chain on `3aef6588`. | **O2**                         |
| 3   | Sarvam v6 writes: remove `send_reminder`, then apply blockers 1–3 and the tool body                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | **O3**                         |
| 4   | v6 text playground: one inbound and one outbound conversation (no calls)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | none                           |
| 5   | Commit v6 in Sarvam                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | **O4**                         |
| 6   | ClickAI admin: remap Smile Dental to v6 (verified remap, a few seconds' pause), then "Re-verify live deployment". Rollback: remap to v5.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | **O5**                         |
| 7   | Inbound regression call from the owner's test number (proposal §6 checklist)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | **O6** (real call)             |
| 8   | Enable outbound on 0061, then "Confirm this version for outbound" (v6)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | **O7**                         |
| 9   | One admin call from 0061 to the allowlisted number, with a reason                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | **O8** (paid call)             |
| 10  | Audit with `docs/sarvam-first-outbound-test.md` §4 queries, plus proposal §7: opening line, reason given, no booking or callback tool, opt-out phrase → `opted_out=yes`, value of `caller_number` recorded                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | none                           |
| 11  | Turn outbound off on 0061 again; withdraw readiness if anything misbehaved                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | **O9**                         |

Campaign dispatch, the allowlist removal and Payment Enforcement are not part of this sequence.
