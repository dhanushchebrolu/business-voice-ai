# Rotating the Sarvam webhook token (`SARVAM_WEBHOOK_SECRET`)

Every step that touches production needs explicit approval at the time. Never
paste a token into chat, tickets, logs or audit reasons.

## How Sarvam webhooks are authenticated

Sarvam does not sign webhooks. ClickAI gives each deployment a webhook URL
whose `verify_token` query value is `SARVAM_WEBHOOK_SECRET`; the webhook route
accepts a request only when that value matches (constant-time compare).

During a rotation, `SARVAM_WEBHOOK_SECRET_PREVIOUS` may also be set. Then a
webhook carrying **either** the current or the previous token is accepted.
Outside a rotation it is unset and only the current token works, exactly as
before. URLs ClickAI writes always use the current token.

Deployment reads classify the token in Sarvam's stored URL as `current`,
`previous`, `unknown` or `none` and never keep the token itself. Verification
(provisioning, "Re-verify live deployment") passes only for `current` or
`previous`.

## Why there is a short interruption

Sarvam's documentation says deployments, including their webhook settings,
can only be edited while paused, and a live edit of an active deployment was
refused on 2026-11-12 ("Only paused deployments can be edited"). Updating the
URL therefore pauses an active deployment for a few seconds and resumes it.
**While paused, Sarvam does not answer calls to that number.** This is a short
controlled interruption, not zero downtime. A webhook-only edit of an active
deployment has not been tested and is not assumed to work.

Webhook deliveries themselves are not rejected at any point, because both
tokens are accepted until the deployment has the new one.

## Production sequence

Prerequisites: the Worker runs a version with dual-token support (this
change), "Re-verify live deployment" passes for the customer, the operator has
the current token value from a secure record or from the deployment's webhook
setting in the Sarvam console, and the change is scheduled at a quiet time.

1. **Keep the old token accepted.** Set `SARVAM_WEBHOOK_SECRET_PREVIOUS` to the
   current (old) value with `wrangler secret put` (typed or piped from a local
   file, not pasted into a shell history). Behaviour does not change.
2. **Introduce the new token.** Generate a new random value locally (at least
   32 random bytes, URL-safe) and set it as `SARVAM_WEBHOOK_SECRET`. The Worker
   now accepts new (current) and old (previous); the deployment still sends the
   old one, which is accepted. Each secret change deploys a new Worker version.
3. **Check:** "Re-verify live deployment" for the customer still passes (the
   deployment's token now reads as `previous`).
4. **Update the deployment** with the admin action "Update webhook token in
   Sarvam", ticking the pause confirmation. It pauses (if active), updates the
   webhook, resumes, and reads back. Expect outcome "rotated": token `current`,
   status the same as before, agent/version/number unchanged.
5. **Verify:** "Re-verify live deployment" passes with the token `current`; one
   approved test call produces an accepted webhook and a call log; optionally,
   one approved read of Sarvam's webhook delivery list shows success.
6. **End the grace period:** `wrangler secret delete SARVAM_WEBHOOK_SECRET_PREVIOUS`.
   Optionally (approved) confirm that a request with the old token now gets
   401 and with the new token an empty body gets 400 (authenticated, invalid
   payload). Destroy local copies of both tokens.

Repeat step 4 for every customer deployment before step 6 (today there is one).

## If something goes wrong

- Step 4 reports "failed": the deployment is back in (or never left) its
  original state; it still sends the old token, which is still accepted. Read
  the detail, fix, retry. Retrying is safe: an already-updated deployment is
  reported as "already current" and not edited again.
- Step 4 reports **"recovery required"** (for example the resume after the
  edit failed, or the read-back failed after a pause): the deployment may be
  left paused and **not answering calls**. The customer's admin page shows a
  red "Recovery required" alert. Run **"Resume deployment"** straight away. It
  resumes only that customer's deployment, only if it was active before the
  update and Sarvam still shows the same agent, version and number, then reads
  it back. If it fails, retry it or resume the deployment in the Sarvam
  console. Further token updates for that customer are refused until the
  recovery succeeds.
- Recovery state is durable and does not depend on the audit log: before
  pausing an active deployment, ClickAI writes a recovery marker on the
  customer's own phone number row (`phone_numbers.metadata.sarvam_webhook_recovery`,
  an existing column; no schema change). If that write fails, nothing is
  paused. The marker survives a failed audit write, a page reload and a Worker
  restart mid-operation, and drives the "Recovery required" alert. It is
  cleared only after Sarvam confirms the deployment is back in its original
  state with the same agent, version and number. If it cannot be cleared, the
  update is reported as not complete (never "rotated") and "Resume deployment"
  confirms and clears it.
- Every attempt is audited, including refusals and errors: the admin, the
  customer, the deployment id, the reason, the stage reached and the outcome.
  Audit records never contain the webhook URL, a token or provider error text.
  The audit log is a trail only; it is not used to decide recovery.
- New token problems: set `SARVAM_WEBHOOK_SECRET` back to the old value while
  `SARVAM_WEBHOOK_SECRET_PREVIOUS` is still set; nothing is rejected.
- Never delete `SARVAM_WEBHOOK_SECRET_PREVIOUS` until every deployment reads
  as `current`.

## Limitations

- The pause in step 4 is a real, if short, call-answering interruption.
- The operator needs the old token value for step 1 (Cloudflare secrets cannot
  be read back).
- Sarvam's deployment reads return the full webhook URL, so anyone with read
  access to the Sarvam workspace can see the token; rotation limits how long a
  leaked token is valid, it cannot hide the current one from Sarvam readers.
- Tested only with mocked Sarvam APIs; the live PATCH of `webhook_config` is
  documented but has not been exercised by this code.
