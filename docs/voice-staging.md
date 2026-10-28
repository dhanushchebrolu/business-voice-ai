# Multilingual voice agent on hosted staging (`clickai-staging`)

How the staging helper guards a voice-agent deploy, which settings it needs, and what must be checked by hand before the first deploy. It builds on [whatsapp-staging-sandbox.md](whatsapp-staging-sandbox.md); everything there still applies.

**Never:** the production Worker `klyro`, the production Supabase project `eorazvlmqwunmhwviocn`, a production phone number, a customer's calendar, or live payments.

## Settings (names only; values live in the gitignored `.env.staging.local`)

| Group           | Required                                                                                                                                            | Optional                                                                                                                                                   |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Speech          | `SARVAM_API_KEY`                                                                                                                                    | `VOICE_LLM_PROVIDER` (`sarvam` or `claude`), `SARVAM_ORG_ID`, `SARVAM_WORKSPACE_ID`, `SARVAM_CONTEXT_SECRET`, `SARVAM_WEBHOOK_SECRET`, `ANTHROPIC_API_KEY` |
| Telephony       | `TELEPHONY_WEBHOOK_BASE_URL`, `MEDIA_SESSION_TOKEN_SECRET`, `VOBIZ_AUTH_ID`, `VOBIZ_AUTH_TOKEN`, `VOBIZ_PHONE_NUMBER`, `VOBIZ_WEBHOOK_VERIFY_TOKEN` | `VOBIZ_BASE_URL`, `VOBIZ_REQUIRE_SIGNATURE`                                                                                                                |
| Calendar        | `GOOGLE_CALENDAR_CLIENT_ID`, `GOOGLE_CALENDAR_CLIENT_SECRET`, `GOOGLE_CALENDAR_REDIRECT_URI`, `GOOGLE_CALENDAR_CREDENTIAL_ENCRYPTION_KEY`           | `GOOGLE_CALENDAR_WEBHOOK_URL`                                                                                                                              |
| Must stay unset | `RAZORPAY_*` (live and test), `EXOTEL_*`, `TWILIO_*`, `TELEPHONY_ALLOW_MOCK`                                                                        |                                                                                                                                                            |

The Supabase, Meta and cron names are listed in the WhatsApp sandbox doc.

## What `node scripts/staging/staging.mjs check` refuses

- Any required name above that is empty.
- `TELEPHONY_WEBHOOK_BASE_URL`, `GOOGLE_CALENDAR_REDIRECT_URI` or `GOOGLE_CALENDAR_WEBHOOK_URL` that isn't `https://clickai-staging.<subdomain>.workers.dev`. All of them must name the same Worker, and the webhook base must be the bare origin.
- Any `*_URL` or `*_URI` value pointing at `klyro`.
- Any payment, mock-telephony or other-provider setting, and any value containing a live Razorpay key.
- `VOBIZ_REQUIRE_SIGNATURE` set to anything but `true`. Unset already means "on".
- Malformed values: a non-E.164 `VOBIZ_PHONE_NUMBER`, a `MEDIA_SESSION_TOKEN_SECRET` shorter than 32 characters, a calendar encryption key that isn't 32 base64-encoded bytes, an unknown `VOICE_LLM_PROVIDER`, or a non-https `VOBIZ_BASE_URL`.
- **Keys identical to production**, only when you supply production fingerprints. Set `STAGING_PRODUCTION_FINGERPRINTS` to a JSON file of `{"NAME": "<sha256 hex of the production value>"}`; it holds hashes only, never values. Hash the exact value as the staging file would hold it: UTF-8, no surrounding quotes, spaces or trailing newline (for example `printf '%s' "$VALUE" | sha256sum`, run where the production value already lives). Keep the file outside the repository. Without it, `check` prints a `NOTE` that this couldn't be proven: an open item, not a pass.

`deploy --yes` also refuses a staging build whose generated config isn't named `clickai-staging`, or that sets `routes`, `route` or `env`, or that mentions `klyro` or the production project.

## `keep_vars: true`: what to check before the first deploy

`wrangler.json` sets `keep_vars: true`, and the staging build inherits it. A deploy then keeps whatever plain-text variables are already set **on the Worker being deployed** in the Cloudflare dashboard, instead of clearing them. That never reaches across Workers: `klyro`'s variables don't apply to `clickai-staging`.

- **If `clickai-staging` doesn't exist yet,** it starts with no variables. Its settings come only from the secrets file the helper uploads.
- **If it already exists,** someone may have set dashboard variables on it by hand, and they survive every deploy. Before the first deploy, list its variable and secret **names** (Cloudflare dashboard, Workers > `clickai-staging` > Settings > Variables and Secrets) and remove anything that isn't on the list above. Pay special attention to anything pointing at production, and to any plain variable that shares a name with one of the secrets the helper uploads: which of the two the Worker would see hasn't been verified, so remove the variable rather than rely on either.
- After every deploy, compare the names again. This is a read-only check, but it signs in to Cloudflare, so it needs explicit approval.

## Before the first deploy (each needs your approval)

1. Confirm in the dashboards that `klyro` uses `eorazvlmqwunmhwviocn`, and that the staging project and Worker are separate.
2. `check` prints `READY`, with production fingerprints supplied.
3. The Vobiz test number's answer URL points only at the staging Worker. The test number is dedicated: no customer calls it.
4. The Google OAuth client allows exactly the staging `GOOGLE_CALENDAR_REDIRECT_URI`, and the connected calendar is a test calendar.
5. Migrations: `migrate --ref <staging ref>` dry run first; push only on approval.
6. Then `deploy --yes`.

## Rollback

`wrangler rollback --name clickai-staging`, or delete the `clickai-staging` Worker; also point the test number back away from it. Neither touches `klyro`.
