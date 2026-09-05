# Vaani — Authentication, Account & Public Website Fixes — Final Report

Scope: the 18-section "AUTHENTICATION, ACCOUNT & PUBLIC WEBSITE FIXES" task.
Base commit: `1953e07` (Phase D.1, on `main`). No prior phase (Supabase Auth,
`platform_admins`, entitlements/lifecycle, telephony, Sarvam runtime) was
redesigned, replaced, or weakened — only read from and extended.

## 1. Landing page CTA (§1)

- `src/routes/index.tsx`: hero buttons are now "Create your workspace" /
  "Book a demo". "See pricing" was removed from the hero (it remains in the
  header nav via `PublicNav.tsx`, untouched, since the task only asked to
  remove it from the hero location).
- New route `src/routes/contact.tsx` ("Book a demo") — a real lead-capture
  form (name, email, business name, phone, message) that inserts into a new
  `public.demo_requests` table. No booking/scheduling logic exists; the copy
  says explicitly a human will follow up. No fake backend.

## 2/3. Password visibility + confirm password (§2, §3)

- New `src/components/ui/password-input.tsx`: an `<Input>` wrapper with an
  eye/eye-off toggle button (`aria-label`/`aria-pressed`, hidden by default).
  Reused everywhere a password is entered: sign-in, sign-up, confirm
  password, reset-password, and account settings → Security.
- `src/routes/auth.tsx` sign-up now has Password + Confirm password, both
  with toggles. Mismatch shows an inline "Passwords do not match." message
  and disables submit; existing `minLength={8}` validation is unchanged.

## 4. Email OTP verification (§4)

- `src/routes/auth.tsx`: after `supabase.auth.signUp(...)`, if Supabase
  returns no session (confirmation required), the form is replaced with a
  dedicated verification screen: 6-digit `InputOTP` (existing shadcn
  component, not new), Verify button, Resend with a 60s cooldown countdown,
  inline error text for wrong/expired codes, loading and success states.
  Verification calls `supabase.auth.verifyOtp({ email, token, type: "signup" })`;
  resend calls `supabase.auth.resend({ type: "signup", email })`. No custom
  OTP storage or generation — 100% Supabase's own mechanism.
- **Required Supabase project configuration this code cannot set:** the
  "Confirm signup" email template must include `{{ .Token }}` (the 6-digit
  code), not only `{{ .ConfirmationURL }}`, and "Confirm email" must be
  enabled under Authentication settings. If the project has email
  confirmation disabled entirely, `signUp` returns a session immediately and
  the code correctly skips the OTP screen (there's nothing to verify) — this
  was a deliberate fallback, not a bug.

## 5. Google OAuth redirect fix (§5)

Root cause found during inspection: Google sign-in goes through Lovable's
own OAuth broker (`@lovable.dev/cloud-auth-js`, `/~oauth/initiate`), which
does a full-page redirect and returns control only after Supabase's client
auto-detects the session from the URL. The bug was that `redirect_uri` was
set to the bare site origin (`window.location.origin`, i.e. `/`), so the
user always landed on the public marketing page with no destination logic —
the auth mechanism itself was never broken.

Fix (the actual callback flow, not a frontend hack):
- New `src/lib/post-auth-destination-logic.ts` (pure, unit-tested) +
  `src/lib/post-auth-destination.ts` (`resolvePostAuthDestination`): reads
  `platform_admins` and `organization_members` through RLS-scoped queries
  and returns `/admin`, `/app`, or `/account` — never inferred from the
  browser, a URL parameter, or which provider was used to sign in.
- New route `src/routes/auth.callback.tsx`: the Google button's
  `redirect_uri` now points here. It waits for the session, then calls the
  resolver and navigates. Falls back to a "sign-in didn't complete" screen
  with a retry link if no session appears (expired/cancelled OAuth).
- The same resolver now drives email/password sign-in and the "already
  signed in" redirect on `/auth` — previously both unconditionally sent
  everyone to `/app`, which was itself a latent version of the same bug for
  admins and no-workspace users.
- `window.location.origin` is still what's used to build the callback URL,
  so this works unchanged across local dev, preview and production without
  any new environment variable.

## 6. Forgot / reset password (§6)

- `src/routes/reset-password.tsx`: rewritten with Confirm password (both
  fields via `PasswordInput`), match validation, a real "this reset link is
  invalid or expired" state (detected via `useAuth()`'s session — a
  valid recovery link establishes one; no session after loading means the
  link is bad), weak-password check (≥8 chars), loading/success states.
  After a successful reset the user is signed out and sent to `/auth` (the
  spec's literal "→ sign in" step), not silently left on a stale session.
- The "Forgot your password?" link on sign-in was already present; the
  `resetPasswordForEmail`/`redirectTo` flow was already using Supabase's own
  mechanism and is unchanged.

## 7. Admin emails (§7) — no code change

`aiblaze.io@gmail.com` and `chdhanush56@gmail.com` are **not** referenced
anywhere in source (verified: `grep -rn` across `src/` and `supabase/`
returns nothing). Per the explicit constraints, authorization stays entirely
in the existing `platform_admins` table / `is_platform_admin()` SQL
function / `assertPlatformAdmin()` — nothing here was touched. To grant
these two accounts admin access, using the **existing** mechanism only:

1. Both people sign up normally through the app (creates their `profiles` row).
2. Whoever signs up first claims super admin at `/admin` using the
   first-time bootstrap secret (`PLATFORM_ADMIN_BOOTSTRAP_SECRET`, an
   operator-configured env var — unset by default, so bootstrap is closed
   until an operator deliberately opens it once).
3. That super admin then goes to **Admin → Admin team** and grants the
   second email a role via the existing `upsertPlatformAdmin` server
   function (looks up their `profiles` row by email; refuses if they
   haven't signed up yet).

No self-promotion path exists, no frontend email comparison exists, and the
bootstrap secret never appears in client code.

## 8/9. No-workspace experience + Profile (§8, §9)

- `src/components/app/NoWorkspace.tsx` was repurposed from a full-page
  dead-end into a `SectionCard` status banner (same file, same guard
  concept, different usage — it is no longer a blocking screen).
- `src/routes/app.tsx`: when a signed-in user has no organization, it now
  redirects to `/account` instead of rendering a takeover. `/app/*` still
  requires a real organization for everything else — customer-only
  functionality (calls, leads, billing, agent config, numbers) stays
  exactly as gated as before.
- New `src/routes/account.tsx` (layout, session-gated) +
  `src/components/app/AuthenticatedShell.tsx` (header/nav: Account,
  Settings, sign out — deliberately NOT the customer dashboard `Shell`).
- New `src/routes/account.index.tsx`: shows the `NoWorkspace` status banner
  (or, if the user does have a workspace, a "go to dashboard" link instead —
  visiting `/account` is never a dead end either way), plus a Profile
  section (name, email + verified badge, phone, account status) sourced
  only from `profiles`/`auth.users`, and a Security section linking to
  password change. Nothing here can auto-create a workspace, grant
  dashboard capabilities, or bypass payment/entitlement rules — it only
  reads `organizations`/`organization_members` the same way `PublicNav`
  already did.

## 10. Settings (§10)

- New `src/routes/account.settings.tsx`: tabs for **Account** (name, phone —
  email shown read-only, not editable, since it's Supabase Auth-owned),
  **Security** (change password, `PasswordInput` + match validation, calls
  `supabase.auth.updateUser`), **Preferences** (preferred language — from
  the existing `LANGUAGES` list — and timezone), **Notifications** (email
  notifications, call-summary emails).
- Preferences/Notifications are genuinely persisted, not fake: migration
  `20260905080000_demo_requests_and_profile_preferences.sql` adds
  `preferred_language`, `timezone`, `notify_email`,
  `notify_call_summaries` to the existing `profiles` table (already
  RLS'd to `id = auth.uid()` — no new policy needed). No new table.

## 11/12/13. Website AI: chatbot, voice assistant, admin management (§11–§13)

**Database** — `20260905080100_public_knowledge_base.sql`: new
`public_knowledge_base` table (title, content, category, is_active,
sort_order, timestamps). RLS: anyone (`anon`+`authenticated`) can `SELECT`
only where `is_active`; only platform admins (`is_platform_admin()`) can
write. Seeded with 6 accurate starter entries derived from the existing
landing page copy. This table has no `organization_id` and no relation to
any tenant table — it is structurally incapable of carrying customer data.

**Chatbot/voice backend** — `src/lib/public-assistant.functions.ts`
(unauthenticated `createServerFn`s, since this is public marketing-site
surface):
- `publicChat`: loads active `public_knowledge_base` rows +
  `platform_settings` `pricing.*` rows (already public), builds a system
  prompt that explicitly instructs the model it has no customer data access
  and must answer only from what's provided, then calls the existing
  `sarvam.runConversation` (no new LLM client). Gated on a
  `website_ai.chatbot_enabled` platform setting.
- `publicVoiceTurn`: same knowledge/prompt path, but takes browser-recorded
  audio (base64), transcribes with a new `sarvam.speechToText` method
  (added to the existing `src/lib/sarvam.server.ts` — Saaras REST
  multipart endpoint, the one Sarvam capability that wasn't wrapped yet),
  runs the same chat logic, then synthesizes the reply with the existing
  `sarvam.generateSpeech`. Gated on `website_ai.voice_enabled` AND
  `sarvam.isConfigured()`.
- **Verified isolation**: `grep` confirms this file's only `.from(...)`
  calls are `platform_settings` and `public_knowledge_base` — no
  `organizations`, `businesses`, `agent_configs`, `call_logs`,
  `phone_numbers`, `knowledge_documents`, or any other tenant table appears
  anywhere in it.
- `src/components/app/PublicAssistantWidget.tsx`: the floating
  bottom-right "Talk to Vaani" button, mounted in `__root.tsx` on every
  route except `/app/*` and `/admin/*`. Chat mode always available; Voice
  mode (mic capture via `MediaRecorder`) only shown when the settings say
  it's enabled.
- **Admin → Website AI** (`src/routes/admin.website-ai.tsx`, new nav entry
  in `AdminShell.tsx`): Knowledge Base CRUD (create/edit/activate/
  deactivate/delete, via new `src/lib/website-ai-admin.functions.ts` —
  `assertPlatformAdmin("settings.write")` + `writeAudit` on every mutation,
  same pattern as every other admin server function), Settings (chatbot
  on/off, voice on/off, welcome message, fallback response — reuses the
  **existing** `listPlatformSettings`/`updatePlatformSetting` server
  functions and the existing `ReasonDialog` audit-reason pattern; no
  duplicate settings mechanism), and a Preview panel that talks to the exact
  same `publicChat` function a visitor would hit.

## 14. Security (§14) — verified, not just asserted

- `grep`-scanned the actual production client bundle
  (`.output/public/assets/*.js`) for `SUPABASE_SERVICE_ROLE_KEY`,
  `SARVAM_API_KEY`, `PLATFORM_ADMIN_BOOTSTRAP_SECRET`, `EXOTEL_TOKEN`,
  `EXOTEL_API_KEY`, `RAZORPAY_KEY_SECRET`, `MEDIA_SESSION_TOKEN_SECRET`,
  and `createSupabaseAdminClient`/`supabaseAdmin`. The only hit was the
  literal *name* "SARVAM_API_KEY" inside admin-facing UI copy ("Requires
  SARVAM_API_KEY to be configured…") — no secret value, no service-role
  client code, anywhere in what ships to the browser.
- All new admin mutations go through `assertPlatformAdmin` +
  `supabaseAdmin` (service role, imported dynamically inside handlers,
  matching the existing `admin.functions.ts` convention) and are audited
  via `writeAudit`.
- No existing RLS policy, `platform_admins` row, entitlement, lifecycle
  rule, telephony/Exotel/Sarvam security control was modified.

## 15. Database rules

Two new tables (`demo_requests`, `public_knowledge_base`) — both genuinely
new concepts with no existing equivalent. Four new columns on the existing
`profiles` table for Settings — reused rather than duplicated. No existing
billing/telephony table was touched. `types.ts` was hand-updated to match
(this repo has no live Supabase connection to regenerate it from, and prior
phases established the same hand-update convention for Phase D's columns).

## 16. Testing — what actually ran

- `npx tsc --noEmit`: clean.
- `npm run build` (full Vite + Nitro/Cloudflare build, regenerates
  `routeTree.gen.ts`): succeeds.
- `npx eslint` on every new/changed file: clean (all `prettier/prettier`
  formatting issues auto-fixed via `eslint --fix`, restricted to files I
  authored or edited — verified with `git diff --stat` that the
  pre-existing files I only touched in a few lines (`app.tsx`, `__root.tsx`,
  `AdminShell.tsx`, `index.tsx`) show tight, targeted diffs, not mass
  reformatting).
- `npm test` (`node --test`, recursive discovery): **42/42 pass** — the
  existing 38 plus 4 new tests in `src/lib/post-auth-destination.test.ts`
  covering the admin/workspace/archived/no-workspace routing priority (the
  actual logic behind the OAuth fix), split into a dependency-free
  `post-auth-destination-logic.ts` specifically so it's unit-testable
  without a live Supabase connection.
- Static isolation check (documented above) that the public assistant code
  never references a tenant table.
- Secret-leak scan of the real production client bundle (documented above).

**What was NOT tested (and why), stated honestly:**
- The actual email OTP round-trip, Google OAuth redirect, and password
  reset email flow were **not** exercised end-to-end — this environment has
  no live Supabase project session, no real Google OAuth consent screen,
  and no email inbox to receive an OTP/reset link. The code paths were
  verified by reading Supabase's documented `verifyOtp`/`resend`/
  `resetPasswordForEmail`/`updateUser` contracts and by full type-checking,
  but "it compiles and matches the documented API" is not the same as "a
  real user completed sign-up." This matches the "don't claim a feature
  works if it wasn't actually tested" instruction.
- The public voice assistant's actual Sarvam STT/TTS calls were not
  exercised against a live Sarvam account — no `SARVAM_API_KEY` exists in
  this environment (consistent with every prior phase's report). The code
  fails closed with a clear "not configured" message rather than faking
  audio, and reuses the exact REST contract already used successfully
  elsewhere in `sarvam.server.ts`.
- No Supabase project exists here to actually apply the two new migrations
  against, so their SQL was written and reviewed but not run against a real
  Postgres instance.

## 17. Scope control

Nothing here replaced Supabase, Sarvam, Exotel, or Razorpay; no second auth
or admin system was created; no automatic workspace provisioning was added
(verified: `signUp` still contains no organization-creation code, and
`account.tsx`/`account.index.tsx` never write to `organizations`); no
setup/payment gate was bypassed (`/app`'s `showLockedScreen` logic is
untouched); no unrelated telephony or billing logic was modified (only
`sarvam.server.ts` gained one new, additive method).

## 18. Environment variables required

No new required variables for the auth/account fixes — they reuse the
existing Supabase project configuration and `window.location.origin`.
`SARVAM_API_KEY` (already documented in `.env.example` since Phase E) must
be set for the public voice assistant to actually speak; without it, voice
mode reports "not configured" rather than pretending to work. The Supabase
project's "Confirm signup" email template needs `{{ .Token }}` for OTP
verification to have a code to enter (documented in §4 above) — this is a
Supabase dashboard setting, not an environment variable, and cannot be set
from this repository.

## Files changed

New: `src/routes/contact.tsx`, `src/routes/auth.callback.tsx`,
`src/routes/account.tsx`, `src/routes/account.index.tsx`,
`src/routes/account.settings.tsx`, `src/routes/admin.website-ai.tsx`,
`src/components/app/AuthenticatedShell.tsx`,
`src/components/app/PublicAssistantWidget.tsx`,
`src/components/ui/password-input.tsx`, `src/lib/post-auth-destination.ts`,
`src/lib/post-auth-destination-logic.ts`,
`src/lib/post-auth-destination.test.ts`, `src/lib/profile.ts`,
`src/lib/public-assistant.functions.ts`,
`src/lib/website-ai-admin.functions.ts`,
`supabase/migrations/20260905080000_demo_requests_and_profile_preferences.sql`,
`supabase/migrations/20260905080100_public_knowledge_base.sql`.

Modified: `src/routes/index.tsx`, `src/routes/auth.tsx`,
`src/routes/reset-password.tsx`, `src/routes/app.tsx`,
`src/routes/__root.tsx`, `src/components/app/NoWorkspace.tsx`,
`src/components/admin/AdminShell.tsx`, `src/lib/sarvam.server.ts`,
`src/integrations/supabase/types.ts`, `src/routeTree.gen.ts` (generated).

## Limitations

- No live Supabase/Sarvam/Exotel credentials exist in this environment (as
  in every prior phase), so nothing that requires them was end-to-end
  tested — see §16 for the precise boundary between what was verified and
  what wasn't.
- The Preview panel on Admin → Website AI tests chat directly; there is no
  automated way to trigger a real microphone/speaker round-trip from this
  environment, so voice was verified by code review and the shared-logic
  reuse with the already-covered `sarvam.server.ts` REST client, not by an
  actual spoken exchange.
