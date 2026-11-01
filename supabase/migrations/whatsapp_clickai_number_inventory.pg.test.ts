import { test, describe, before, after, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
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
 * 20261028090000_whatsapp_clickai_number_inventory on a disposable cluster:
 * every migration replayed in order with production-like privileges (no
 * default privileges), then the ClickAI-number invariants checked as the
 * real database roles — capabilities, the platform-wide purchase lock, the
 * atomic purchase record, cross-organization ownership in both directions
 * (including two genuinely concurrent writers), reassignment while
 * connected, and that voice-only rows behave exactly as before.
 */

const migrationsDir = dirname(fileURLToPath(import.meta.url));
const FIX = "20261028090000_whatsapp_clickai_number_inventory.sql";
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

const ORG_A = randomUUID();
const ORG_B = randomUUID();
const OWNER_A = randomUUID();
const OWNER_B = randomUUID();
const ADMIN = randomUUID();
const LEGACY_VOICE = randomUUID();

let cluster: Cluster | null = null;
let execSql: ((sql: string) => RunResult) | null = null;
let skipReason: string | null = null;
let setupFailure: string | null = null;
let unregister: (() => void) | null = null;

const sql = (statement: string): RunResult => execSql!(statement);

function value(statement: string): string {
  const r = sql(`\\pset format unaligned\n\\pset tuples_only on\n${statement}`);
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim().split("\n").pop()!.trim();
}

function ok(statement: string, message = statement) {
  const r = sql(statement);
  assert.equal(r.status, 0, `${message}\n${r.stderr}`);
}

function refused(statement: string, pattern: RegExp, message = statement) {
  const r = sql(statement);
  assert.notEqual(r.status, 0, `${message} (expected a refusal)`);
  assert.match(r.stderr, pattern, message);
}

function asRole(role: string, user: string | null, statement: string): RunResult {
  return sql(`BEGIN;
SET LOCAL ROLE ${role};
${user ? `SELECT set_config('request.jwt.claim.sub', '${user}', true) \\g /dev/null` : ""}
${statement}
COMMIT;`);
}

function execSqlAsync(statement: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const c = cluster!;
    const args = [
      "-h",
      c.sockDir,
      "-U",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      "-q",
      "-X",
      "-f",
      "-",
    ];
    const child = c.useSu
      ? spawn("su", ["postgres", "-c", [`${c.pgBinDir}psql`, ...args].join(" ")])
      : spawn(`${c.pgBinDir}psql`, args);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("close", (code) => resolve({ status: code ?? 1, stdout, stderr }));
    child.stdin.write(statement);
    child.stdin.end();
  });
}

/** An inventory row; WhatsApp-only unless `voice` is set. */
const number = (
  id: string,
  org: string | null,
  e164: string,
  status: string,
  opts: { voice?: boolean; whatsapp?: boolean } = {},
) =>
  `INSERT INTO public.phone_numbers (id, organization_id, e164, provider, status, voice_capable, whatsapp_capable)
   VALUES ('${id}', ${org ? `'${org}'` : "NULL"}, '${e164}', 'vobiz', '${status}', ${opts.voice ?? false}, ${opts.whatsapp ?? true});`;

/** A live Vobiz WhatsApp connection. */
const connection = (
  id: string,
  org: string,
  display: string,
  opts: { inventory?: string; status?: string } = {},
) =>
  `INSERT INTO public.whatsapp_connections (id, organization_id, waba_id, phone_number_id, display_phone_number, status, provider, vobiz_channel_id, number_onboarding_mode, inventory_number_id)
   VALUES ('${id}', '${org}', 'waba-${id.slice(0, 8)}', 'pn-${id}', '${display}', '${opts.status ?? "connected"}', 'vobiz', 'ch-${id}',
     '${opts.inventory ? "buy_from_vobiz" : "bring_your_own"}', ${opts.inventory ? `'${opts.inventory}'` : "NULL"});`;

const order = (phone: string, status = "requested") =>
  `INSERT INTO public.whatsapp_number_orders (organization_id, requested_by, phone_number, status)
   VALUES (NULL, '${ADMIN}', '${phone}', '${status}') RETURNING id;`;

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
      // A voice number that exists before this migration.
      const seed = sql(`
        INSERT INTO public.organizations (id, name, owner_id) VALUES
          ('${ORG_A}', 'Smile Dental', '${OWNER_A}'), ('${ORG_B}', 'Other Clinic', '${OWNER_B}');
        INSERT INTO public.organization_members (organization_id, user_id, role) VALUES
          ('${ORG_A}', '${OWNER_A}', 'owner'), ('${ORG_B}', '${OWNER_B}', 'owner');
        INSERT INTO public.phone_numbers (id, organization_id, e164, provider, status)
          VALUES ('${LEGACY_VOICE}', '${ORG_A}', '+918000000001', 'sarvam', 'active');`);
      if (seed.status !== 0) {
        setupFailure = `seed failed: ${seed.stderr}`;
        return;
      }
    }
    const applied = sql(`BEGIN;\n${readFileSync(join(migrationsDir, file), "utf8")}\nCOMMIT;`);
    if (applied.status !== 0) {
      setupFailure = `migration ${file} failed to apply: ${applied.stderr}`;
      return;
    }
  }
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

describe("capabilities", () => {
  pgTest("existing numbers become voice-only; a number must be good for something", () => {
    assert.equal(
      value(
        `SELECT voice_capable || '/' || whatsapp_capable FROM public.phone_numbers WHERE id = '${LEGACY_VOICE}';`,
      ),
      "true/false",
    );
    refused(
      number(randomUUID(), ORG_A, "+918000000002", "provisioning", {
        voice: false,
        whatsapp: false,
      }),
      /phone_numbers_capability_check/,
    );
  });

  pgTest("voice-only rows keep their old rules (same number in two organizations' setup)", () => {
    const e164 = "+918000000003";
    ok(number(randomUUID(), ORG_A, e164, "provisioning", { voice: true, whatsapp: false }));
    ok(number(randomUUID(), ORG_B, e164, "provisioning", { voice: true, whatsapp: false }));
  });
});

describe("purchase", () => {
  pgTest("one live order per number, platform-wide", () => {
    ok(order("+918100000001"));
    refused(order("+918100000001"), /idx_whatsapp_number_orders_one_live_number/);
  });

  pgTest("record_whatsapp_number_purchase records the order and the number together", () => {
    const orderId = value(order("+918100000002"));
    const numberId = value(
      `SET ROLE service_role; SELECT public.record_whatsapp_number_purchase('${orderId}', '${ORG_A}', 'vz-ord-2', 'pending', 'IN', '${ADMIN}');`,
    );
    assert.equal(
      value(
        `SELECT status || '/' || vobiz_order_id || '/' || phone_number_inventory_id FROM public.whatsapp_number_orders WHERE id = '${orderId}';`,
      ),
      `pending/vz-ord-2/${numberId}`,
    );
    assert.equal(
      value(
        `SELECT organization_id || '/' || status || '/' || voice_capable || '/' || whatsapp_capable || '/' || inbound_enabled
           FROM public.phone_numbers WHERE id = '${numberId}';`,
      ),
      `${ORG_A}/provisioning/false/true/false`,
    );
    // Recording the same order again changes nothing.
    refused(
      `SET ROLE service_role; SELECT public.record_whatsapp_number_purchase('${orderId}', '${ORG_B}', 'vz-ord-x', 'pending', 'IN', '${ADMIN}');`,
      /whatsapp_number_order_not_requested/,
    );
    assert.equal(
      value(`SELECT count(*) FROM public.phone_numbers WHERE e164 = '+918100000002';`),
      "1",
    );
  });

  pgTest("if the number can't be recorded, the order isn't either (one transaction)", () => {
    const e164 = "+918100000003";
    ok(connection(randomUUID(), ORG_B, e164)); // customer-owned elsewhere
    const orderId = value(order(e164));
    refused(
      `SET ROLE service_role; SELECT public.record_whatsapp_number_purchase('${orderId}', '${ORG_A}', 'vz-ord-3', 'pending', 'IN', '${ADMIN}');`,
      /whatsapp_number_owned_elsewhere/,
    );
    assert.equal(
      value(
        `SELECT status || '/' || coalesce(vobiz_order_id, 'none') FROM public.whatsapp_number_orders WHERE id = '${orderId}';`,
      ),
      "requested/none",
      "the lock stays 'requested' so the purchase is never repeated",
    );
  });

  pgTest("only the server role can record purchases; customers can't see admin orders", () => {
    const orderId = value(order("+918100000004"));
    for (const role of ["authenticated", "anon"]) {
      const r = asRole(
        role,
        role === "authenticated" ? OWNER_A : null,
        `SELECT public.record_whatsapp_number_purchase('${orderId}', '${ORG_A}', 'vz', 'pending', 'IN', '${OWNER_A}');`,
      );
      assert.match(r.stderr, /permission denied for function record_whatsapp_number_purchase/);
    }
    const seen = asRole(
      "authenticated",
      OWNER_A,
      `\\pset format unaligned\n\\pset tuples_only on\nSELECT count(*) FROM public.whatsapp_number_orders WHERE organization_id IS NULL;`,
    );
    assert.equal(seen.status, 0, seen.stderr);
    assert.match(seen.stdout, /^0$/m);
    const write = asRole(
      "authenticated",
      OWNER_A,
      number(randomUUID(), ORG_A, "+918100000005", "active"),
    );
    assert.match(write.stderr, /permission denied/);
  });
});

describe("ownership", () => {
  pgTest(
    "a customer-owned WhatsApp number can't be put in another organization's (or the pool's) inventory",
    () => {
      const display = "+91 82000 00001"; // Meta's display form
      ok(connection(randomUUID(), ORG_B, display));
      refused(
        number(randomUUID(), ORG_A, "+918200000001", "provisioning"),
        /whatsapp_number_owned_elsewhere/,
      );
      refused(
        number(randomUUID(), ORG_A, "+918200000001", "provisioning", {
          voice: true,
          whatsapp: false,
        }),
        /whatsapp_number_owned_elsewhere/,
      );
      refused(
        number(randomUUID(), null, "+918200000001", "available", { voice: true, whatsapp: false }),
        /whatsapp_number_owned_elsewhere/,
      );
      // The owner's own organization may hold it.
      ok(number(randomUUID(), ORG_B, "+918200000001", "provisioning"));
    },
  );

  pgTest("a ClickAI number held by one organization can't be connected by another", () => {
    const inv = randomUUID();
    ok(number(inv, ORG_A, "+918200000002", "active"));
    refused(connection(randomUUID(), ORG_B, "+918200000002"), /whatsapp_number_owned_elsewhere/);
    refused(
      connection(randomUUID(), ORG_B, "+918200000002", { inventory: inv }),
      /whatsapp_number_not_assigned|whatsapp_number_owned_elsewhere/,
    );
    ok(connection(randomUUID(), ORG_A, "+918200000002", { inventory: inv }));
    refused(
      connection(randomUUID(), ORG_A, "+918200000002", { inventory: inv }),
      /idx_whatsapp_connections_inventory_live|duplicate key/,
    );
  });

  pgTest("an unassigned (pool) number can't be connected by anyone", () => {
    ok(number(randomUUID(), null, "+918200000003", "available", { voice: true, whatsapp: false }));
    refused(connection(randomUUID(), ORG_A, "+918200000003"), /whatsapp_number_owned_elsewhere/);
  });

  pgTest("a WhatsApp-only number never sits in the voice pool", () => {
    refused(
      number(randomUUID(), null, "+918200000007", "available"),
      /phone_numbers_whatsapp_only_assigned_check/,
    );
    const inv = randomUUID();
    ok(number(inv, ORG_A, "+918200000008", "provisioning"));
    refused(
      `UPDATE public.phone_numbers SET organization_id = NULL, status = 'available' WHERE id = '${inv}';`,
      /phone_numbers_whatsapp_only_assigned_check/,
    );
  });

  pgTest(
    "a number is connectable from the inventory only once assigned, WhatsApp-capable and active",
    () => {
      const inv = randomUUID();
      ok(number(inv, ORG_A, "+918200000004", "provisioning"));
      refused(
        connection(randomUUID(), ORG_A, "+918200000004", { inventory: inv }),
        /whatsapp_number_not_assigned/,
      );
      const voiceOnly = randomUUID();
      ok(number(voiceOnly, ORG_A, "+918200000005", "active", { voice: true, whatsapp: false }));
      refused(
        connection(randomUUID(), ORG_A, "+918200000005", { inventory: voiceOnly }),
        /whatsapp_number_not_assigned/,
      );
    },
  );

  pgTest("a WhatsApp number is held by one organization at a time", () => {
    ok(number(randomUUID(), ORG_A, "+918200000006", "provisioning"));
    refused(
      number(randomUUID(), ORG_B, "+918200000006", "provisioning"),
      /idx_phone_numbers_whatsapp_e164_held|whatsapp_number_owned_elsewhere/,
    );
    refused(
      number(randomUUID(), ORG_B, "+918200000006", "provisioning", {
        voice: true,
        whatsapp: false,
      }),
      /whatsapp_number_owned_elsewhere/,
    );
  });
});

describe("reassignment", () => {
  pgTest(
    "a connected number can't be reassigned, released or lose WhatsApp until disconnected",
    () => {
      const inv = randomUUID();
      const conn = randomUUID();
      ok(number(inv, ORG_A, "+918300000001", "active"));
      ok(connection(conn, ORG_A, "+918300000001", { inventory: inv }));
      refused(
        `UPDATE public.phone_numbers SET organization_id = '${ORG_B}', status = 'provisioning' WHERE id = '${inv}';`,
        /whatsapp_number_connected/,
      );
      refused(
        `UPDATE public.phone_numbers SET status = 'released' WHERE id = '${inv}';`,
        /whatsapp_number_connected/,
      );
      refused(
        `UPDATE public.phone_numbers SET whatsapp_capable = false, voice_capable = true WHERE id = '${inv}';`,
        /whatsapp_number_connected/,
      );
      // Ordinary updates of the connected row and the number still work.
      ok(`UPDATE public.whatsapp_connections SET status = 'needs_attention' WHERE id = '${conn}';`);
      ok(`UPDATE public.phone_numbers SET suspended_reason = NULL WHERE id = '${inv}';`);

      ok(`UPDATE public.whatsapp_connections SET status = 'disconnected' WHERE id = '${conn}';`);
      ok(
        `UPDATE public.phone_numbers SET organization_id = '${ORG_B}', status = 'provisioning' WHERE id = '${inv}';`,
      );
      // The previous organization's old connection can't come back to life on it.
      refused(
        `UPDATE public.whatsapp_connections SET status = 'connected' WHERE id = '${conn}';`,
        /whatsapp_number_not_assigned|whatsapp_number_owned_elsewhere/,
      );
      ok(`UPDATE public.phone_numbers SET status = 'active' WHERE id = '${inv}';`);
      ok(connection(randomUUID(), ORG_B, "+918300000001", { inventory: inv }));
    },
  );

  pgTest("concurrent reassignment and connection can't both win", async () => {
    for (let round = 0; round < 5; round++) {
      const inv = randomUUID();
      const e164 = `+91840000000${round}`;
      ok(number(inv, ORG_A, e164, "active"));
      const connect = `BEGIN; ${connection(randomUUID(), ORG_A, e164, { inventory: inv })} SELECT pg_sleep(0.2); COMMIT;`;
      const reassign = `BEGIN; UPDATE public.phone_numbers SET organization_id = '${ORG_B}', status = 'provisioning' WHERE id = '${inv}'; SELECT pg_sleep(0.2); COMMIT;`;
      const [a, b] = await Promise.all([execSqlAsync(connect), execSqlAsync(reassign)]);
      assert.equal(
        [a, b].filter((r) => r.status === 0).length,
        1,
        `exactly one wins\n${a.stderr}\n${b.stderr}`,
      );
      const live = value(
        `SELECT count(*) FROM public.whatsapp_connections c JOIN public.phone_numbers p ON p.id = c.inventory_number_id
          WHERE c.inventory_number_id = '${inv}' AND c.status <> 'disconnected' AND c.organization_id <> p.organization_id;`,
      );
      assert.equal(live, "0", "never a live connection for a number another organization holds");
    }
  });

  pgTest(
    "concurrent claims of a customer-owned number by two organizations: at most one",
    async () => {
      for (let round = 0; round < 5; round++) {
        const e164 = `+91850000000${round}`;
        const byon = `BEGIN; ${connection(randomUUID(), ORG_B, e164)} SELECT pg_sleep(0.2); COMMIT;`;
        const assign = `BEGIN; ${number(randomUUID(), ORG_A, e164, "provisioning")} SELECT pg_sleep(0.2); COMMIT;`;
        const [a, b] = await Promise.all([execSqlAsync(byon), execSqlAsync(assign)]);
        assert.equal([a, b].filter((r) => r.status === 0).length, 1, `${a.stderr}\n${b.stderr}`);
      }
    },
  );
});

describe("repeatability", () => {
  pgTest("re-applying the migration is a no-op", () => {
    const again = sql(`BEGIN;\n${readFileSync(join(migrationsDir, FIX), "utf8")}\nCOMMIT;`);
    assert.equal(again.status, 0, again.stderr);
  });
});
