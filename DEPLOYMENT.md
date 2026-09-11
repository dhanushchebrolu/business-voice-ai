# Deploying Klyro to Cloudflare Workers

This documents how the `klyro` Worker (production: `https://klyro.aiblaze-io.workers.dev`)
is built and deployed, and — most importantly — which configuration lives where,
so a deploy never wipes dashboard-managed variables/secrets again.

## Three places configuration can live

| Where | What goes here | Example |
|---|---|---|
| **Repo: `wrangler.json`** | Non-secret, deploy-shape config that must be identical on every deploy: Worker name, Durable Object bindings, migrations, `keep_vars`, and the *names* (never values) of required secrets. | `name`, `durable_objects`, `migrations`, `keep_vars`, `secrets.required` |
| **Repo: build-time public vars** | `VITE_*`-prefixed variables, inlined into the client bundle at `vite build` time via `import.meta.env`. These are public by design (shipped to every browser) and are **not** secrets. | `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` |
| **Cloudflare Dashboard only** | Every runtime value the server reads via `process.env` at request time: the Supabase service-role key, provider API keys/webhook secrets, the admin bootstrap secret, etc. **Never committed, never put in `wrangler.json`'s `[vars]`, never printed.** | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `PLATFORM_ADMIN_BOOTSTRAP_SECRET`, `RAZORPAY_KEY_ID`/`RAZORPAY_KEY_SECRET`/`RAZORPAY_WEBHOOK_SECRET`, `SARVAM_API_KEY`/`SARVAM_ORG_ID`/`SARVAM_WORKSPACE_ID`/`SARVAM_WEBHOOK_SECRET`, `EXOTEL_SID`/`EXOTEL_API_KEY`/`EXOTEL_TOKEN`/`EXOTEL_SUBDOMAIN`/`EXOTEL_WEBHOOK_SECRET`, `MEDIA_SESSION_TOKEN_SECRET`, `TELEPHONY_WEBHOOK_BASE_URL` |

`wrangler.json` intentionally has **no `[vars]` block**. Runtime secrets/variables
are managed exclusively through the Cloudflare dashboard (or `wrangler secret put`),
never through the repo — that's what keeps real values out of git.

See `.env.example` for the full, currently-known list of variable *names* the
server code reads (kept in sync with `src/**/*.server.ts` — it documents names
only, never values).

## Why dashboard variables used to disappear on deploy

By default, `wrangler deploy` treats the Wrangler config as the **complete**
description of the Worker's vars/bindings and replaces whatever is live with
exactly what's in the config. Since `wrangler.json` never held a `[vars]`
block (correctly — secrets don't belong in git), every deploy replaced the
live variable set with an *empty* one, deleting anything configured by hand
in the dashboard.

Cloudflare's fix for this is the top-level `keep_vars` setting: when `true`,
a deploy leaves any variable/secret that exists on the Worker but isn't
declared in the config untouched, instead of deleting it. `wrangler.json` now
sets `"keep_vars": true` at the top level (the only level it's valid at —
it cannot be scoped to a named environment).

A second, related bug was also found and fixed: `wrangler.json` had no
`name` field, so the build tool synthesized one
(`dhanushchebrolu-business-voice-ai`) instead of using the actual production
Worker name. Since the production URL is `https://klyro.aiblaze-io.workers.dev`
— and a `workers.dev` URL is always `<worker-name>.<subdomain>.workers.dev`
— the Worker's real name is `klyro`. `wrangler.json` now pins
`"name": "klyro"` explicitly so a deploy can never target an
auto-generated/mismatched Worker name.

## How the deploy config is actually produced

This project has no npm `deploy` script — production deploys run externally
(Cloudflare Workers Builds, or a manual `npx wrangler deploy` / `npx nitro
deploy --prebuilt`), which is why this file exists: to document the pipeline
that isn't otherwise version-controlled.

1. `bun run build` runs `vite build`, which uses Nitro's Cloudflare preset
   (bundled inside `@lovable.dev/vite-tanstack-config`, not in this repo) to
   produce `.output/server/`.
2. As part of that build, Nitro reads the repo's own `wrangler.json` (via
   `readWranglerConfig`, walking up from the project root) and deep-merges it
   with its own build-generated fields (`main`, `assets`, `compatibility_date`,
   `compatibility_flags`, `no_bundle`, `rules`) using `defu(overrides,
   ctxConfig, userConfig, defaults)`. Nothing in Nitro's own `overrides` ever
   touches `name`, `keep_vars`, or `secrets` — so any value set for those keys
   in the repo's `wrangler.json` passes straight through unchanged. This was
   confirmed by reading `node_modules/nitro/dist/_presets.mjs` and by
   rebuilding: `.output/server/wrangler.json` now shows `"name": "klyro"`,
   `"keep_vars": true`, and `"secrets": { "required": [...] }` verbatim.
3. The merged result is written to `.output/server/wrangler.json`, and
   `.wrangler/deploy/config.json` is written pointing at it
   (`{"configPath":"../../.output/server/wrangler.json"}`).
4. `npx wrangler deploy` and `npx nitro deploy --prebuilt` both ultimately
   deploy using that generated file — **not** the repo's `wrangler.json`
   directly. Because Nitro forwards `keep_vars`/`name`/`secrets` through
   unmodified, fixing the repo's `wrangler.json` is sufficient; no separate
   Nitro-level setting is needed or bypassed.

So: **edit `wrangler.json` at the repo root.** It is the single source of
truth for deploy-shape config, and every production deploy path (`wrangler
deploy`, `nitro deploy --prebuilt`) picks up its `keep_vars`/`name`/`secrets`
values through Nitro's build step.

## `secrets.required`

```json
"secrets": {
  "required": ["SUPABASE_SERVICE_ROLE_KEY"]
}
```

This declares (by name only) that the Worker cannot run without
`SUPABASE_SERVICE_ROLE_KEY` configured as a dashboard secret. `wrangler
deploy` / `wrangler versions upload` will refuse to deploy if it's missing,
catching a misconfigured environment before it ships instead of after.

Deliberately **not** included:

- `PLATFORM_ADMIN_BOOTSTRAP_SECRET` — by design (see `admin.functions.ts`),
  this is meant to be unset once the first platform admin has been
  bootstrapped. Declaring it required would force it to stay configured
  forever, which is the opposite of its intended lifecycle.
- `SUPABASE_URL` — required for the app to boot, but it's a project URL, not
  a sensitive secret; it isn't configured as a Cloudflare "secret" binding.
- Every provider-specific credential (`RAZORPAY_*`, `SARVAM_*`, `EXOTEL_*`,
  `MEDIA_SESSION_TOKEN_SECRET`, etc.) — these gate individual telephony/
  billing providers, not the app as a whole. Requiring all of them would
  block deploys in any environment that hasn't connected every provider.

This list only grows when a value becomes unconditionally required for the
Worker to serve *any* request, not merely one feature.

Note: `secrets.required` also affects `wrangler dev`/local dev loading from
`.dev.vars`/`.env` — but this project's `dev` script is a plain `vite dev`
(no `@cloudflare/vite-plugin`, no `wrangler dev` in the loop), so that
behavior doesn't apply here.

## Deploying

```sh
bun run build
npx nitro deploy --prebuilt   # or: npx wrangler deploy
```

Both read `.output/server/wrangler.json` (generated by the build), which now
always carries `name: "klyro"` and `keep_vars: true` forward from the repo's
`wrangler.json`. Dashboard-configured variables/secrets not listed in the
config survive the deploy. This is idempotent: running the same build+deploy
repeatedly never removes an existing dashboard variable, because nothing in
the generated config ever declares a `[vars]` block that would replace them,
and `keep_vars` protects anything already live.

**Never** put a real secret value in `wrangler.json`, `.env.example`, or any
committed file. Set/update secrets only through the Cloudflare dashboard or
`wrangler secret put <NAME>`.
