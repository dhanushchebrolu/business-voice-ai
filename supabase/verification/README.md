# Klyro AI — Database Verification Instructions

## What this is

`verify_klyro_database.sql` is a **read-only** SQL script that inspects the
live Supabase database's schema, RLS policies, grants, functions, and
triggers, and compares them against what the 17 repository migrations are
expected to have created.

It contains **no** `INSERT`, `UPDATE`, `DELETE`, `ALTER`, `DROP`, `CREATE`,
`TRUNCATE`, `GRANT`, or `REVOKE` statements. It creates no test users and no
test data. It is safe to run as-is against a live database.

## How to run it

1. Open the **Supabase Dashboard** at https://supabase.com/dashboard.
2. Select the project named **Klyro Ai**, project ref
   `eorazvlmqwunmhwiocn`, region South Asia (Mumbai).
   **Do not run this against any other project** — in particular not the
   old `fnitm...` project or the old Lovable-created `blr...` project.
3. Go to **SQL Editor**.
4. Open `verify_klyro_database.sql` from this repo, copy its full contents
   into a new query, and run it. You can also run it section-by-section
   (each section is numbered and separated by a comment header) if you'd
   rather review results incrementally.
5. Copy the complete results (all sections) back into the conversation with
   Claude — the full text/table output, not just a screenshot summary, so
   each check can be verified precisely.

## What it checks (static/catalog only)

- Every table, enum, column, index, and constraint the 17 migrations are
  expected to have created
- Every function and trigger, including full definitions (so they can be
  diffed against the migration source)
- RLS enabled/forced status per table
- Every RLS policy's actual live definition
- Table- and column-level grants for the `authenticated` and `anon` roles
  (this is the layer RLS does **not** cover — RLS restricts rows, not
  columns)
- The live `handle_new_user()` definition, plus an automated flag for
  whether it still references `organizations`, `organization_members`, or
  `subscriptions` (it must not, after the Phase B fix)
- The seeded `public_knowledge_base` content, including a per-row check for
  leftover "Vaani" branding vs. "Klyro AI" branding
- `supabase_migrations.schema_migrations` — which migration versions
  Postgres's own bookkeeping shows as applied

## What it cannot check

This script can only prove what the catalog *declares* — table shapes,
grants, and policy text. It **cannot** prove runtime behavior. In
particular it does **not** prove:

- That customer A's authenticated session actually cannot read or write
  customer B's data
- That a real signup actually results in only a profile row (no
  organization, membership, or subscription)
- That an authenticated customer session is actually rejected when
  attempting to write a protected column (e.g. `lifecycle_status`,
  `payment_override`)
- That a customer cannot actually self-escalate to `platform_admin`
- That `increment_rate_limit()` or the wallet functions actually enforce
  their intended authorization under a real call

Those all require **runtime testing** — running real queries as a real
authenticated (non-service-role) session — not just reading catalog
definitions. The script labels every section `[STATIC]` or
`[RUNTIME REQUIRED]` accordingly.

## Safety reminders

- Read-only — no writes, no schema changes, no test data.
- Target only `eorazvlmqwunmhwiocn` (Klyro Ai).
- Never paste any secret key (service-role key, database password, etc.)
  back into the conversation or into any tracked file.
