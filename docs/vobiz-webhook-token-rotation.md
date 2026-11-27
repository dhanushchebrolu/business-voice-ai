# Vobiz webhook-token rotation and Exotel retirement

Status: **prepared, not executed.** Every step that changes a credential, a
Worker version or a provider setting needs explicit approval.

## Why

The webhook `verify_token` was stored in plain text in production:
175 Vobiz `call_logs` rows, and 23 Exotel `call_logs` rows plus 26 Exotel
`webhook_events` rows. Cleaning those rows doesn't make the old tokens
safe, so the Vobiz token is rotated and Exotel is retired.

## How the overlap works (code, not yet deployed)

`VobizTelephonyAdapter.verifyWebhookSignature` accepts:

- `VOBIZ_WEBHOOK_VERIFY_TOKEN`: the current token. It is always accepted,
  and it is the only token Klyro puts into the answer/hangup URLs it hands
  to Vobiz.
- `VOBIZ_WEBHOOK_VERIFY_TOKEN_PREVIOUS`: the token being replaced. It is
  accepted only while `VOBIZ_WEBHOOK_VERIFY_TOKEN_PREVIOUS_EXPIRES_AT` (ISO
  8601 with `Z` or an offset) is in the future **and** at most 14 days away.
  A missing or invalid expiry, an expiry more than 14 days ahead, or a
  previous value equal to the current one all mean the previous token is
  refused (fail closed).

Both comparisons are constant-time and always run. Logs carry only
`matched`, `matchedToken: "previous"` (warning level) or
`previousTokenStatus` (`expired`, `invalid_expiry`, `window_too_long`,
`same_as_current`), never a value. The Vobiz signature check
(`X-Vobiz-Signature-V3`, required by default) applies to both tokens
unchanged. Both Vobiz entry points (`/api/public/webhooks/telephony` and
`/api/public/webhooks/vobiz-answer`) use this check.

## Prerequisites

- [ ] The Worker containing this code is deployed (step 5 of
      `production-security-remediation-plan.md`). Without it, the
      `_PREVIOUS` variables do nothing.
- [ ] Record the live version (`wrangler deployments status --name klyro`)
      as the rollback target.
- [ ] Confirm there are no Vobiz calls in progress (read-only `call_logs`
      check and the Vobiz console). The overlap makes this a precaution,
      not a requirement.

## Rotation sequence (each command is a separate approval)

Generate the new value on the operator's machine, never in chat or tickets:
`openssl rand -hex 32` (64 characters). It must differ from the old one.

1. **Stage both tokens in one new version.** `wrangler versions secret put`
   creates a version without deploying it:
   ```
   wrangler versions secret put VOBIZ_WEBHOOK_VERIFY_TOKEN_PREVIOUS --name klyro               # paste the OLD value
   wrangler versions secret put VOBIZ_WEBHOOK_VERIFY_TOKEN_PREVIOUS_EXPIRES_AT --name klyro    # e.g. 2026-11-27T12:00:00Z (≤ 14 days)
   wrangler versions secret put VOBIZ_WEBHOOK_VERIFY_TOKEN --name klyro                        # paste the NEW value
   ```
   Each call creates a new version based on the previous one. Use the last
   version id it prints.
2. **Deploy that version:** `wrangler versions deploy <last-version-id>@100% --name klyro`.
   Both tokens now work. New calls get URLs with the new token.
3. **Update the Vobiz console:** set the new token in the `verify_token`
   query parameter of the answer/hangup URLs of the application serving the
   active Vobiz number. Change nothing else on the number.
4. **Monitor** until well before the expiry (at least 24 hours):
   - the `vobiz_provider:webhook_verify_token_check` warnings with
     `matchedToken: "previous"` stop (only calls that started before step 2
     should produce them);
   - no `matched: false` errors.
5. **Finish:** delete both `_PREVIOUS` secrets:
   ```
   wrangler secret delete VOBIZ_WEBHOOK_VERIFY_TOKEN_PREVIOUS --name klyro
   wrangler secret delete VOBIZ_WEBHOOK_VERIFY_TOKEN_PREVIOUS_EXPIRES_AT --name klyro
   ```
   Each deletion deploys a new version from the deployed code. Even if this
   step is forgotten, the old token stops working at the expiry.

## Rollback

- **Before step 5:** the old token still works. To go back, put the old
  value back as `VOBIZ_WEBHOOK_VERIFY_TOKEN`, delete the `_PREVIOUS`
  pair, and restore the old URL in the Vobiz console.
- **After a bad deploy:** run `wrangler rollback <recorded-version-id> --name klyro`.
  That version holds the old (exposed) token, so treat it as temporary and
  rotate again.
- **If callbacks fail after step 3:** compare the console URL's token with
  the new value. The logs show `matched: false` with
  `receivedTokenPresent: true`.

## Exotel retirement (prepared; do not delete anything yet)

Update 2026-11-27: the Worker holds no `EXOTEL_` secret any more, and the
Exotel code is removed on branch `chore/remove-exotel` (not merged or
deployed). Step 2 (the Exotel console) is still the owner's; step 4's
readiness check no longer exists.

Evidence (read-only, 2026-11-18):

- both Exotel numbers are `released` (2026-10-05);
- the last Exotel call and webhook were on 2026-09-17;
- no Exotel configuration is used by any active number.

Steps, each needing approval, in this order:

1. **Freeze:** confirm again that there is no Exotel traffic (`call_logs` and
   `webhook_events` for `exotel` since 2026-09-17: expect 0).
2. **Provider side:** in the Exotel console, remove or disable every
   flow/applet URL that points at ClickAI (`/api/public/webhooks/telephony?provider=exotel…`
   and the media-stream URL). If the account is closed, record that instead.
3. **Worker side:** delete `EXOTEL_WEBHOOK_SECRET`, then `EXOTEL_TOKEN`,
   `EXOTEL_API_KEY`, `EXOTEL_SID` (and `EXOTEL_SUBDOMAIN` if set) with
   `wrangler secret delete … --name klyro`. Each deletion deploys a new
   version from the deployed code. With them gone, `getTelephonyAdapter("exotel")`
   returns null and any stray Exotel webhook is refused.
4. **Verify:** the runtime readiness check reports Exotel as unconfigured,
   the Sarvam and Vobiz paths are unaffected, and no errors appear.
5. **Data:** the historical rows are handled by the two cleanup scripts
   (`call_logs` and `webhook_events`), not by retirement.

Rollback: re-add the secrets from the operator's records and restore the
console URLs. The `EXOTEL_WEBHOOK_SECRET` value is exposed, so set a new one
if Exotel is ever revived.
