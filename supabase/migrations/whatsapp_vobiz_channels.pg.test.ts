import { test, describe, before, after, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bootstrapCluster,
  makeExecSql,
  registerSignalCleanup,
  teardownCluster,
  type Cluster,
  type RunResult,
} from "./pg-test-cluster.ts";

/**
 * 20261027090000_whatsapp_vobiz_channels on a disposable cluster: every
 * migration replayed in order with production-like privileges (no default
 * privileges), an existing direct-Meta connection seeded just before it,
 * then the new columns, constraints, purchase lock and tenant isolation
 * checked as the real database roles.
 */

const migrationsDir = dirname(fileURLToPath(import.meta.url));
const FIX = "20261027090000_whatsapp_vobiz_channels.sql";
const MIGRATIONS = readdirSync(migrationsDir)
  .filter((f) => /^\d{14}_.*\.sql$/.test(f))
  .sort();

const STANDIN = `
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA auth;
CREATE SCHEMA extensions;
CREATE TABLE auth.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text,
  raw_user_meta_data jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now()
);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT '{}'::jsonb $$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT 'authenticated' $$;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
`;

const ORG = randomUUID();
const OTHER_ORG = randomUUID();
const BIZ = randomUUID();
const OWNER = randomUUID();
const OTHER_OWNER = randomUUID();
const LEGACY_CONN = randomUUID();

let cluster: Cluster | null = null;
let execSql: ((sql: string) => RunResult) | null = null;
let skipReason: string | null = null;
let setupFailure: string | null = null;
let unregister: (() => void) | null = null;
let seeded = false;

const sql = (statement: string): RunResult => execSql!(statement);

function rows(statement: string): string[] {
  const r = sql(`\\pset format unaligned\n\\pset tuples_only on\n${statement}`);
  assert.equal(r.status, 0, r.stderr);
  return r.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("Output format") && !l.startsWith("Tuples only"));
}

function asRole(role: string, user: string | null, statement: string): RunResult {
  return sql(`BEGIN;
SET LOCAL ROLE ${role};
${user ? `SELECT set_config('request.jwt.claim.sub', '${user}', true) \\g /dev/null` : ""}
${statement}
COMMIT;`);
}

const vobizConn = (
  id: string,
  org: string,
  channel: string | null,
  phone: string,
  status = "connected",
) =>
  `INSERT INTO public.whatsapp_connections (id, organization_id, waba_id, phone_number_id, status, provider, vobiz_channel_id, number_onboarding_mode)
   VALUES ('${id}', '${org}', 'waba', '${phone}', '${status}', 'vobiz', ${channel ? `'${channel}'` : "NULL"}, 'bring_your_own');`;

const order = (org: string, phone: string, status = "requested") =>
  `INSERT INTO public.whatsapp_number_orders (organization_id, phone_number, status) VALUES ('${org}', '${phone}', '${status}');`;

before(() => {
  const result = bootstrapCluster();
  if (!result.ok) {
    skipReason = result.reason;
    return;
  }
  cluster = result.cluster;
  execSql = makeExecSql(cluster);
  unregister = registerSignalCleanup(() => cluster);
  const standin = sql(STANDIN);
  if (standin.status !== 0) {
    setupFailure = `stand-in failed: ${standin.stderr}`;
    return;
  }
  for (const file of MIGRATIONS) {
    if (file === FIX) {
      const seed = sql(`
        INSERT INTO public.organizations (id, name, owner_id) VALUES
          ('${ORG}', 'Smile Dental', '${OWNER}'), ('${OTHER_ORG}', 'Other Clinic', '${OTHER_OWNER}');
        INSERT INTO public.organization_members (organization_id, user_id, role) VALUES
          ('${ORG}', '${OWNER}', 'owner'), ('${OTHER_ORG}', '${OTHER_OWNER}', 'owner');
        INSERT INTO public.businesses (id, organization_id, name, timezone)
          VALUES ('${BIZ}', '${ORG}', 'Smile Dental', 'Asia/Kolkata');
        INSERT INTO public.whatsapp_connections (id, organization_id, waba_id, phone_number_id, status)
          VALUES ('${LEGACY_CONN}', '${ORG}', 'legacy-waba', 'legacy-pn', 'connected');`);
      if (seed.status !== 0) {
        setupFailure = `seed failed: ${seed.stderr}`;
        return;
      }
      seeded = true;
    }
    const applied = sql(`BEGIN;\n${readFileSync(join(migrationsDir, file), "utf8")}\nCOMMIT;`);
    if (applied.status !== 0) {
      setupFailure = `migration ${file} failed to apply: ${applied.stderr}`;
      return;
    }
  }
  if (!seeded) setupFailure = `migration ${FIX} not found`;
});

after(() => {
  unregister?.();
  if (cluster) teardownCluster(cluster);
});

function pgTest(name: string, fn: (t: TestContext) => void | Promise<void>) {
  test(name, async (t) => {
    if (skipReason) {
      t.skip(skipReason);
      return;
    }
    if (setupFailure) {
      assert.fail(`PostgreSQL is available, but setup failed — a real failure: ${setupFailure}`);
    }
    await fn(t);
  });
}

describe("whatsapp_connections", () => {
  pgTest("an existing direct-Meta connection is kept as provider 'meta_direct'", () => {
    assert.deepEqual(
      rows(
        `SELECT provider || '|' || coalesce(vobiz_channel_id, '-') FROM public.whatsapp_connections WHERE id = '${LEGACY_CONN}';`,
      ),
      ["meta_direct|-"],
    );
  });

  pgTest("a Vobiz connection needs a channel id and a known onboarding mode", () => {
    const missing = sql(vobizConn(randomUUID(), ORG, null, "pn-x"));
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /whatsapp_connections_vobiz_channel_check/);
    const badMode = sql(
      `INSERT INTO public.whatsapp_connections (organization_id, waba_id, phone_number_id, provider, vobiz_channel_id, number_onboarding_mode)
       VALUES ('${ORG}', 'w', 'pn-y', 'vobiz', 'ch-y', 'migrate');`,
    );
    assert.notEqual(badMode.status, 0);
    assert.match(badMode.stderr, /whatsapp_connections_onboarding_mode_check/);
    const badProvider = sql(
      `INSERT INTO public.whatsapp_connections (organization_id, waba_id, phone_number_id, provider) VALUES ('${ORG}', 'w', 'pn-z', 'twilio');`,
    );
    assert.match(badProvider.stderr, /whatsapp_connections_provider_check/);
  });

  pgTest(
    "one Vobiz channel is live for one connection only; a disconnected one can be reconnected",
    () => {
      const first = randomUUID();
      assert.equal(sql(vobizConn(first, ORG, "ch-shared", "pn-1")).status, 0);
      const dup = sql(vobizConn(randomUUID(), OTHER_ORG, "ch-shared", "pn-2"));
      assert.notEqual(dup.status, 0);
      assert.match(dup.stderr, /idx_whatsapp_connections_vobiz_channel_live|duplicate key/);
      assert.equal(
        sql(`UPDATE public.whatsapp_connections SET status = 'disconnected' WHERE id = '${first}';`)
          .status,
        0,
      );
      assert.equal(sql(vobizConn(randomUUID(), ORG, "ch-shared", "pn-3")).status, 0);
    },
  );

  pgTest(
    "browsers can read provider and onboarding mode, never the Vobiz channel id or ciphertext",
    () => {
      const ok = asRole(
        "authenticated",
        OWNER,
        "SELECT provider, number_onboarding_mode FROM public.whatsapp_connections;",
      );
      assert.equal(ok.status, 0, ok.stderr);
      for (const col of ["vobiz_channel_id", "vobiz_number_order_id", "access_token_ciphertext"]) {
        const r = asRole("authenticated", OWNER, `SELECT ${col} FROM public.whatsapp_connections;`);
        assert.notEqual(r.status, 0, col);
        assert.match(r.stderr, /permission denied/);
      }
    },
  );
});

describe("whatsapp_number_orders", () => {
  pgTest("at most one live order per organization and number (the purchase lock)", () => {
    assert.equal(sql(order(ORG, "+918000000001")).status, 0);
    const again = sql(order(ORG, "+918000000001", "pending"));
    assert.notEqual(again.status, 0);
    assert.match(again.stderr, /idx_whatsapp_number_orders_one_live|duplicate key/);
    // Another organization's interest in the same number isn't blocked by ours.
    assert.equal(sql(order(OTHER_ORG, "+918000000001")).status, 0);
    // A failed order frees the number for a new attempt.
    assert.equal(
      sql(
        `UPDATE public.whatsapp_number_orders SET status = 'failed' WHERE organization_id = '${ORG}' AND phone_number = '+918000000001';`,
      ).status,
      0,
    );
    assert.equal(sql(order(ORG, "+918000000001")).status, 0);
  });

  pgTest("phone numbers must be E.164 with a leading +", () => {
    for (const bad of ["918000000009", "+0123", "+91 80000"]) {
      assert.notEqual(sql(order(ORG, bad)).status, 0, bad);
    }
  });

  pgTest("members read only their own organization's orders and can't write any", () => {
    assert.equal(sql(order(OTHER_ORG, "+918000000077")).status, 0);
    const mine = asRole(
      "authenticated",
      OWNER,
      "\\pset format unaligned\n\\pset tuples_only on\nSELECT DISTINCT organization_id FROM public.whatsapp_number_orders;",
    );
    assert.equal(mine.status, 0, mine.stderr);
    assert.ok(mine.stdout.includes(ORG));
    assert.ok(!mine.stdout.includes(OTHER_ORG));
    const write = asRole("authenticated", OWNER, order(ORG, "+918000000088"));
    assert.notEqual(write.status, 0);
    assert.match(write.stderr, /permission denied/);
    const anon = asRole("anon", null, "SELECT 1 FROM public.whatsapp_number_orders;");
    assert.match(anon.stderr, /permission denied/);
  });

  pgTest("the server role can create and update orders", () => {
    const r = asRole(
      "service_role",
      null,
      `${order(ORG, "+918000000099")}
       UPDATE public.whatsapp_number_orders SET status = 'pending', vobiz_order_id = 'ord-1' WHERE phone_number = '+918000000099';`,
    );
    assert.equal(r.status, 0, r.stderr);
  });
});

describe("repeatability", () => {
  pgTest("re-applying the migration is a no-op", () => {
    const again = sql(`BEGIN;\n${readFileSync(join(migrationsDir, FIX), "utf8")}\nCOMMIT;`);
    assert.equal(again.status, 0, again.stderr);
  });
});
