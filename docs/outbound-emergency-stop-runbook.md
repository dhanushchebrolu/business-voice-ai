# Outbound emergency stop — operator runbook

Applies once migration 20261121090000 (GATE C1) is in production. Before that,
only layer 2 (`OUTBOUND_CALLING_DISABLED`) exists.

## 1. The two stops

| Layer                 | Where                                                                                                  | Takes effect                                 | Stops                                                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. Database stop      | `platform_settings` key `outbound.calling_paused` = `{"enabled": true}` (private: `is_public = false`) | The next admission, no deploy                | Every new outbound call, single and campaign: both `admit_single_outbound_call` and `admit_campaign_outbound_call` refuse with `outbound_paused` |
| 2. Worker kill switch | Worker secret `OUTBOUND_CALLING_DISABLED=true`                                                         | After the secret is set (new Worker version) | Every new outbound call before admission, and a campaign call admitted just before it, before dialling                                           |

Use layer 1 first: it is one SQL file and needs no deploy. Add layer 2 if the
database cannot be reached or the stop must survive a schema rollback (the
rollback deletes the setting row; a missing row means **not stopped**).

Campaign dispatch has its own switch: it runs only when
`CAMPAIGN_DISPATCH_ENABLED=true`. Leaving that unset keeps every campaign idle
regardless of the stops.

## 2. Activate

```powershell
npx -y supabase@2.120.0 db query --linked --project-ref eorazvlmqwunmhwviocn -f docs/outbound-emergency-stop-activate.sql
```

Returns the setting row with `"enabled": true`. If it fails with
`STOP_NOT_INSTALLED`, the migration is not applied or was rolled back: use
layer 2.

Layer 2, if needed (prompts for the value; type `true`):

```powershell
npx wrangler secret put OUTBOUND_CALLING_DISABLED --name klyro
```

## 3. Verify

```powershell
npx -y supabase@2.120.0 db query --linked --project-ref eorazvlmqwunmhwviocn -f docs/outbound-emergency-stop-status.sql
```

Read only. Expect:

- `stop_active: true`, `stop_installed: true`, `stop_private: true`;
- `outbound_admitted_since_stop: 0` — no outbound call row started after the
  stop was set. Re-run after a few minutes; it must stay 0;
- `open_outbound_calls` — calls that were already live (see §5);
- `outcome_unknown_calls` — calls needing an operator decision (see §6).

In the app: a single call request or campaign launch/resume shows "Outbound
calling is stopped on ClickAI (emergency stop)…"; the dispatcher logs
`campaign_dispatch:emergency_stop` (nothing claimed),
`campaign_dispatch:emergency_stop_before_dial` (admitted, not sent) or
`campaign_dispatch:admission_refused <campaign> outbound_paused`. Layer 2: `npx wrangler secret list --name klyro`
lists `OUTBOUND_CALLING_DISABLED` (names only).

## 4. Remove safely

Removing the stop lets **running campaigns resume dialling on the next
dispatch run** (about a minute) if dispatch is enabled. Their contacts were
left queued, not failed. So, before removing it:

1. Decide per campaign: pause or cancel any campaign that should not resume
   (admin or customer UI). Check with the status file's `campaigns_by_status`.
2. Resolve every `outcome_unknown` call (§6); `outcome_unknown_calls` should be 0.
3. Confirm the cause of the stop is fixed.

Then:

```powershell
npx -y supabase@2.120.0 db query --linked --project-ref eorazvlmqwunmhwviocn -f docs/outbound-emergency-stop-deactivate.sql
```

and verify `stop_active: false` with the status file. If layer 2 was set,
remove it too:

```powershell
npx wrangler secret delete OUTBOUND_CALLING_DISABLED --name klyro
```

Never remove the stop by deleting the row: that also turns it off, but
leaves nothing for the next activation (`STOP_NOT_INSTALLED`). Use the
deactivate file.

## 5. What happens to active calls

- Nothing is hung up. ClickAI does not call Sarvam to end a call; a call
  already ringing or connected continues until the person hangs up or the
  agent's maximum call length ends it (300 s for the Smile Dental outbound
  agent).
- Its webhook still arrives and finalizes it normally: billing, and the
  campaign contact's outcome.
- A call that was admitted but not yet sent to the provider when the stop
  landed is not sent. Since Worker `da71e765` (commit `0cd054a`, GATE C4 H3)
  the database stop is read again as the last step before every provider
  request: campaign calls, single Sarvam calls, and the LiveKit agent's claim
  before it dials. The call is recorded as never started (`failed`,
  `start_failure`: no charge, no budget). A stop set in the last milliseconds
  before the request leaves cannot be caught.
- Refused campaign contacts are given back exactly as they were (status and
  attempt count; no retry scheduled; `cancelled` if their campaign was
  cancelled); the campaign stays `running` and dispatches nothing while the
  stop is on. The dispatcher also checks the stop before claiming anything.
- Campaign launch and resume are refused while the stop is on ("Outbound
  calling is stopped on ClickAI (emergency stop)…"); so is a single call
  request. A failed read of the setting counts as stopped.
- `open_outbound_calls` in the status file falls to 0 as those calls end
  and their webhooks arrive (the longest is the maximum call length). A call still `initiated` with no Sarvam attempt id after
  30 minutes is moved to `outcome_unknown` automatically.

## 6. Recovering `outcome_unknown` calls

`outcome_unknown` means the start request to Sarvam failed ambiguously: the
call may or may not have been placed. Nothing resolves it automatically, the
campaign contact is never redialled while the call is unresolved, and
admission keeps the call's worst-case cost reserved against the wallet.

1. Admin → **Calls**; unresolved calls show as **Unconfirmed**.
2. Look the call up in Sarvam's dashboard (by time, agent and number).
3. Click **Resolve** and choose:
   - **Not placed** — no call in Sarvam. The call is marked failed with no
     charge; the campaign applies its normal failed outcome, which may retry
     the contact later.
   - **Placed**, with the outcome Sarvam shows (completed, no answer, busy,
     failed) and the duration. This goes through the same pipeline as a real
     webhook: billing and the campaign outcome apply exactly once, and a late
     real webhook for the same attempt is ignored.
   - For a call still `initiated` (Sarvam accepted it), you must also
     confirm you checked it in Sarvam: it may still be in progress.
4. A reason is required; every resolution is audited
   (`SARVAM_CALL_OUTCOME_RESOLVED`).

Related automatic recovery, for reference: a campaign contact claimed by the
dispatcher with no call row for 15 minutes (the Worker stopped between claim
and admission) is released back to the queue.

## 7. Local test (2026-11-20, PostgreSQL 17.6, rehearsal database)

All 9 checks passed: installed, private and off after GATE C1; activate;
status shows active; the admission predicate sees it; deactivate; status shows
off; activate without the row fails with `STOP_NOT_INSTALLED` and changes
nothing; the status file cannot write. The admissions' refusal with
`outbound_paused` is covered by
`supabase/migrations/campaign_context_engine.pg.test.ts`.
