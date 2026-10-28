# WhatsApp sandbox on hosted staging (`clickai-staging`)

How to stand up the hosted staging environment for a controlled WhatsApp sandbox test, without touching production.

**Never:** the production Worker `klyro`, the production Supabase project `eorazvlmqwunmhwviocn`, the production Meta app, or real customer WhatsApp accounts. No commit or push is needed for any step here; every command runs from this local checkout.

## What's already in place

- **Local staging:** local Supabase (all migrations applied), the dev server on `http://localhost:8080`, and `.env.local` with local-only test values. Verified end to end: the webhook handshake, signature checks, unmatched-payload minimization and deduplication, and both WhatsApp cron routes.
- **Staging build switch:** `CLICKAI_DEPLOY_TARGET=staging` makes the build target the `clickai-staging` Worker (`vite.config.ts`). Without it, a build targets production `klyro`.
- **`.env.staging.local`** (gitignored): every staging name. `WHATSAPP_CREDENTIAL_ENCRYPTION_KEY`, `WHATSAPP_WEBHOOK_VERIFY_TOKEN` and `LOVABLE_CRON_SECRET` are already generated, randomly and for staging only. The Supabase and Meta test-app fields are empty, waiting for the hosted resources.
- **`scripts/staging/staging.mjs`:** a guarded helper.
  - `check` (read-only, the default) lists present and missing names and shows the staging project reference, never a value.
  - `secrets --yes` sets the Worker secrets.
  - `deploy --yes` builds for staging and deploys.
  - It refuses the production Supabase project, mismatched projects, the `klyro` Worker, and any change without `--yes`.
- **`scripts/staging/schedule-cron.sql`:** the scheduler for the staging Supabase project. It is not a migration.

## Hosted resources needed

| Resource                                                  | Status                                                             | Cost                                                                                                                                                                                                |
| --------------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Supabase project for staging (not `eorazvlmqwunmhwviocn`) | Unknown or missing: nothing in the repo or CLI names one           | Free plan: $0, up to 2 active free projects; paused after about a week idle. In a paid organization, about $10/month extra compute for a Micro project. Check supabase.com/pricing before creating. |
| Cloudflare Worker `clickai-staging`                       | Unverified: check the Cloudflare dashboard before the first deploy | Expected $0 on the same account: staging cron is about 2,200 requests/day against the free 100k/day. The existing Durable Object classes are SQLite-backed.                                         |
| Meta **test** app, with a WhatsApp test number            | Not configured                                                     | Free (test numbers send to up to 5 verified recipients)                                                                                                                                             |

## Sequence

1. **Staging Supabase project.** Create it in the Supabase dashboard (or name an existing non-production one), in a region close to your users.
   - Copy its URL, publishable key and service-role key into `.env.staging.local`: `SUPABASE_*`, plus `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` with the same values.
   - In **Authentication > URL Configuration**, set the Site URL and redirect URL to the staging Worker URL (step 4).
2. **Migrations on the staging project only.**
   - First, confirm the reference that `node scripts/staging/staging.mjs check` prints is the new project and not `eorazvlmqwunmhwviocn`.
   - Then run the Supabase CLI against that project's connection string (the CLI isn't installed here, so this means a one-time `npx supabase@2` download):
     - `supabase migration list --db-url "$STAGING_DB_URL"` (read-only: it should show 0 of 53 applied);
     - `supabase db push --db-url "$STAGING_DB_URL"`;
     - `migration list` again: 53 of 53.
   - Keep the connection string in an environment variable, never in a file.
3. **Meta test app values.** Fill `META_*` and `VITE_META_*` from the test app: app ID, app secret, Embedded Signup configuration ID, and the Graph API version the dashboard shows as current. Then `node scripts/staging/staging.mjs check` should print `READY`.
4. **Worker.** Run `node scripts/staging/staging.mjs secrets --yes`, then `node scripts/staging/staging.mjs deploy --yes`. Wrangler prints the Worker URL, `https://clickai-staging.<subdomain>.workers.dev`.
5. **Scheduler.** In the staging project's Vault, store:
   - `clickai_staging_base_url`: the Worker URL;
   - `clickai_staging_cron_secret`: `LOVABLE_CRON_SECRET` from `.env.staging.local`.

   Then run `scripts/staging/schedule-cron.sql` in that project's SQL editor. It schedules `whatsapp-dispatch` every minute, `whatsapp-replies` every 3 minutes and `expire-payments` every 5 minutes, and refuses any URL that isn't `clickai-staging`.

6. **Meta test app webhooks.**
   - Callback URL: `<Worker URL>/api/public/webhooks/whatsapp`.
   - Verify token: `WHATSAPP_WEBHOOK_VERIFY_TOKEN` from `.env.staging.local`.
   - Subscribe `messages`, `account_update`, `phone_number_quality_update` and `message_template_status_update`.
   - Add the Worker's host to the app's allowed domains (JavaScript SDK / Embedded Signup).
7. **Sandbox test.**
   - Read-only first: inspect the sandbox token with `debug_token`, and confirm `expires_at`, `data_access_expires_at` and the granted WABA IDs.
   - Then connect the test number through Embedded Signup on staging, send and receive with a verified test recipient, and disconnect. Check `whatsapp_connections.metadata.meta_cleanup` and the cron responses.

## Rollback

- **Scheduler:** `select cron.unschedule(jobname) from cron.job where jobname like 'clickai-staging-%';`
- **Worker:** delete `clickai-staging` in the Cloudflare dashboard. This doesn't affect `klyro`.
- **Meta:** remove the test app's webhook subscription.
