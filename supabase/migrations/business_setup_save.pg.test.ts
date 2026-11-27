import { test, describe, before, after, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
import {
  buildSetupPayload,
  formFromSaved,
  type OnboardingForm,
  type SavedSetup,
  type SetupPayload,
} from "../../src/lib/onboarding-save.ts";

/**
 * REAL-PostgreSQL coverage for 20261205090000 (save_business_setup): one atomic, serialized
 * save per customer, as the signed-in member, with production-like grants (no default
 * privileges). Payloads are built by the wizard's own code.
 */

const migrationsDir = dirname(fileURLToPath(import.meta.url));
const NEW = "20261205090000_business_setup_save.sql";
const ROLLBACK = join(
  migrationsDir,
  "..",
  "..",
  "docs",
  "production-rollback-20261205090000-business-setup-save.sql",
);
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

let cluster: Cluster | null = null;
let execSql: ((sql: string) => RunResult) | null = null;
let skipReason: string | null = null;
let setupFailure: string | null = null;
let unregister: (() => void) | null = null;

function ready(t: TestContext): boolean {
  if (setupFailure) assert.fail(setupFailure);
  if (skipReason) {
    t.skip(skipReason);
    return false;
  }
  return true;
}
const exec = (sql: string) => execSql!(sql);
const must = (sql: string) => {
  const r = exec(sql);
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};
/** The single JSON value a query prints. */
function json<T>(query: string): T {
  const out = must(`\\pset format unaligned\n\\pset tuples_only on\n${query}`);
  // json_agg breaks long arrays over lines: take everything from the first bracket on.
  const lines = out.split("\n");
  const start = lines.findIndex((l) => /^\s*[[{]/.test(l));
  return JSON.parse(lines.slice(start).join("\n")) as T;
}
const count = (table: string, org: string) =>
  json<{ n: number }>(
    `SELECT json_build_object('n', count(*)) FROM public.${table} WHERE organization_id = '${org}';`,
  ).n;

before(() => {
  const boot = bootstrapCluster();
  if (!boot.ok) {
    skipReason = boot.reason;
    return;
  }
  cluster = boot.cluster;
  execSql = makeExecSql(cluster);
  unregister = registerSignalCleanup(() => cluster);
  const standin = execSql(STANDIN);
  if (standin.status !== 0) {
    setupFailure = standin.stderr;
    return;
  }
  for (const file of MIGRATIONS) {
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    // Applied twice for the new one: it must be re-runnable.
    for (let pass = 0; pass < (file === NEW ? 2 : 1); pass++) {
      const r = execSql(`BEGIN;\n${sql}\nCOMMIT;`);
      if (r.status !== 0) {
        setupFailure = `${file}: ${r.stderr}`;
        return;
      }
    }
  }
});
after(() => {
  unregister?.();
  if (cluster) teardownCluster(cluster);
});

/** A customer with an owner who can sign in. */
function customer() {
  const org = randomUUID();
  const user = randomUUID();
  must(`INSERT INTO auth.users (id) VALUES ('${user}');
    INSERT INTO public.organizations (id, name, owner_id) VALUES ('${org}', 'C', '${user}');
    INSERT INTO public.organization_members (organization_id, user_id, role)
      VALUES ('${org}', '${user}', 'owner') ON CONFLICT DO NOTHING;`);
  return { org, user };
}
type Customer = ReturnType<typeof customer>;

const asMember = (c: Customer, sql: string) =>
  `SET ROLE authenticated;\nSELECT set_config('request.jwt.claim.sub', '${c.user}', false);\n${sql}`;
const literal = (value: unknown) => `$j$${JSON.stringify(value)}$j$::jsonb`;
const call = (c: Customer, p: SetupPayload, org = c.org) =>
  `SELECT public.save_business_setup('${org}', ${literal(p.initial)}, ${literal(p.changes)});`;
const save = (c: Customer, p: SetupPayload) => must(asMember(c, call(c, p)));

/** What the wizard would load (the receptionist's business, else the first one). */
function saved(c: Customer): SavedSetup {
  return json<SavedSetup>(`
    WITH a AS (SELECT * FROM public.agent_configs WHERE organization_id = '${c.org}'
                ORDER BY created_at, id LIMIT 1),
         b AS (SELECT * FROM public.businesses WHERE organization_id = '${c.org}'
                AND (NOT EXISTS (SELECT 1 FROM a) OR id = (SELECT business_id FROM a))
                ORDER BY created_at, id LIMIT 1)
    SELECT json_build_object(
      'business', (SELECT row_to_json(b) FROM b),
      'hours', coalesce((SELECT json_agg(h ORDER BY h.day_of_week) FROM public.business_hours h
                          WHERE h.business_id = (SELECT id FROM b)), '[]'),
      'services', coalesce((SELECT json_agg(s ORDER BY s.sort_order) FROM public.services s
                             WHERE s.business_id = (SELECT id FROM b)), '[]'),
      'agent', (SELECT row_to_json(a) FROM a));`);
}
const EMPTY: SavedSetup = { business: null, hours: [], services: [], agent: null };

/** A person filling in the wizard as it opened on `from`. */
function payload(from: SavedSetup, type: (f: OnboardingForm) => void = () => {}) {
  const loaded = formFromSaved(from);
  const form = structuredClone(loaded);
  type(form);
  return buildSetupPayload(form, loaded, "Thank you for calling.");
}
const fill = (f: OnboardingForm) => {
  f.typeId = "dental_clinic";
  Object.assign(f.info, {
    name: "Bright Dental",
    description: "A family dental clinic that looks after patients of every age.",
    address: "1 Main Road",
    city: "Chennai",
    primary_phone: "+91 90000 00000",
  });
  f.openDays = [1, 2, 3];
  f.openTime = "10:00";
  f.items = [
    { name: "Cleaning", price: "500" },
    { name: "Braces", price: "" },
    { name: "", price: "" },
  ];
  f.greeting = "Vanakkam.";
};

/** Everything of one customer, with ids and timestamps: equality means nothing was written. */
const everything = (org: string) =>
  json<Record<string, unknown>>(
    `SELECT json_build_object(${[
      "businesses",
      "business_hours",
      "services",
      "faqs",
      "business_rules",
      "agent_configs",
    ]
      .map(
        (t) =>
          `'${t}', (SELECT json_agg(x ORDER BY x.id) FROM public.${t} x WHERE organization_id = '${org}')`,
      )
      .join(", ")});`,
  );
const counts = (org: string) =>
  ["businesses", "business_hours", "services", "faqs", "business_rules", "agent_configs"].map((t) =>
    count(t, org),
  );
/** One business, a week of hours, the two services, suggestions once, one receptionist. */
function assertOneSetup(org: string, services = 2) {
  const [businesses, hours, svc, faqs, rules, agents] = counts(org);
  assert.deepEqual([businesses, hours, svc, agents], [1, 7, services, 1]);
  assert.ok(faqs! > 0 && rules! > 0);
  const duplicated = json<{ n: number }>(
    `SELECT json_build_object('n', count(*)) FROM (SELECT question FROM public.faqs
      WHERE organization_id = '${org}' GROUP BY question HAVING count(*) > 1) d;`,
  ).n;
  assert.equal(duplicated, 0);
}

/** Runs SQL in its own session, without waiting for others. */
function session(sql: string): Promise<{ status: number | null; stderr: string }> {
  const c = cluster!;
  const args = ["-h", c.sockDir, "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-q"];
  if (!c.useSu) args.push("-U", "postgres");
  const child = c.useSu
    ? spawn("su", ["postgres", "-c", [`${c.pgBinDir}psql`, ...args].join(" ")])
    : spawn(`${c.pgBinDir}psql`, args);
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += String(d)));
  child.stdin.end(sql);
  return new Promise((resolve) => child.on("close", (status) => resolve({ status, stderr })));
}
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** The first holds its transaction open; the others arrive while it is uncommitted. */
async function overlapping(first: string, others: string[]) {
  const a = session(`BEGIN;\n${first}\nSELECT pg_sleep(2);\nCOMMIT;`);
  // Not a fixed delay: wait until the first session really holds the customer's lock.
  const held = () =>
    json<{ n: number }>(
      `SELECT json_build_object('n', count(*)) FROM pg_locks WHERE locktype = 'advisory' AND granted;`,
    ).n > 0;
  for (let i = 0; !held(); i++) {
    assert.ok(i < 100, "the first session never took the customer's lock");
    await pause(50);
  }
  return Promise.all([a, ...others.map((sql) => session(sql))]);
}

describe("a first save", () => {
  test("writes one complete setup and marks it done; the same submission again changes nothing", (t) => {
    if (!ready(t)) return;
    const c = customer();
    const first = payload(EMPTY, fill);
    save(c, first);
    assertOneSetup(c.org);
    const s = saved(c);
    assert.equal(s.business!.name, "Bright Dental");
    assert.deepEqual(s.agent!.greetings, { "en-IN": "Vanakkam." });
    assert.deepEqual(
      s.hours.filter((h) => !h.is_closed).map((h) => h.day_of_week),
      [1, 2, 3],
    );
    assert.equal(
      json<{ done: boolean }>(
        `SELECT json_build_object('done', onboarding_completed) FROM public.organizations WHERE id = '${c.org}';`,
      ).done,
      true,
    );
    const before = everything(c.org);
    for (let i = 0; i < 3; i++) save(c, first);
    assertOneSetup(c.org);
    assert.deepEqual(everything(c.org), before, "not even a timestamp");
  });

  test("is all or nothing", (t) => {
    if (!ready(t)) return;
    const c = customer();
    const bad = payload(EMPTY, (f) => {
      fill(f);
      f.openTime = "22:00";
      f.closeTime = "09:00";
    });
    assert.notEqual(exec(asMember(c, call(c, bad))).status, 0);
    assert.deepEqual(counts(c.org), [0, 0, 0, 0, 0, 0]);
    save(c, payload(EMPTY, fill));
    assertOneSetup(c.org);
  });

  test("needs a business name", (t) => {
    if (!ready(t)) return;
    const c = customer();
    const r = exec(
      asMember(
        c,
        call(
          c,
          payload(EMPTY, (f) => (f.typeId = "dental_clinic")),
        ),
      ),
    );
    assert.match(r.stderr, /BUSINESS_SETUP_NAME_REQUIRED/);
    assert.deepEqual(counts(c.org), [0, 0, 0, 0, 0, 0]);
  });
});

describe("concurrent submissions resolve to one setup", () => {
  test("two tabs for a new customer: the second waits, then lands on the same records", async (t) => {
    if (!ready(t)) return;
    const c = customer();
    const tabA = payload(EMPTY, fill);
    // Opened empty too, and filled with a different name and an extra service.
    const tabB = payload(EMPTY, (f) => {
      f.typeId = "dental_clinic";
      f.info.name = "Bright Dental Care";
      f.items = [
        { name: " cleaning ", price: "" },
        { name: "Whitening", price: "900" },
      ];
    });
    const results = await overlapping(asMember(c, call(c, tabA)), [asMember(c, call(c, tabB))]);
    for (const r of results) assert.equal(r.status, 0, r.stderr);
    assertOneSetup(c.org, 3);
    const s = saved(c);
    assert.equal(s.business!.name, "Bright Dental Care", "what the second person typed");
    // Its untouched defaults did not replace what the first tab saved.
    assert.equal(s.business!.address, "1 Main Road");
    assert.deepEqual(
      s.hours.filter((h) => !h.is_closed).map((h) => h.day_of_week),
      [1, 2, 3],
    );
    assert.deepEqual(s.agent!.greetings, { "en-IN": "Vanakkam." });
  });

  test("many at once", async (t) => {
    if (!ready(t)) return;
    const c = customer();
    const p = payload(EMPTY, fill);
    const results = await overlapping(
      asMember(c, call(c, p)),
      Array.from({ length: 6 }, () => asMember(c, call(c, p))),
    );
    for (const r of results) assert.equal(r.status, 0, r.stderr);
    assertOneSetup(c.org);
  });

  test("an older browser tab writing directly cannot add a second business or receptionist", async (t) => {
    if (!ready(t)) return;
    const c = customer();
    const direct = asMember(
      c,
      `INSERT INTO public.businesses (organization_id, name) VALUES ('${c.org}', 'Direct');`,
    );
    const results = await overlapping(direct, [direct, direct]);
    assert.deepEqual(results.map((r) => r.status === 0).sort(), [false, false, true]);
    assert.match(results.map((r) => r.stderr).join(""), /BUSINESS_SETUP_EXISTS/);
    assert.equal(count("businesses", c.org), 1);
    // Saving through the wizard then completes that same business.
    save(c, payload(saved(c), fill));
    assert.equal(count("businesses", c.org), 1);
    const again = exec(
      asMember(
        c,
        `INSERT INTO public.agent_configs (organization_id, business_id)
          SELECT organization_id, id FROM public.businesses WHERE organization_id = '${c.org}';`,
      ),
    );
    assert.notEqual(again.status, 0);
    assert.equal(count("agent_configs", c.org), 1);
  });

  test("server-side writes may still give a customer another business; a browser still cannot add its receptionist", (t) => {
    if (!ready(t)) return;
    const c = customer();
    save(c, payload(EMPTY, fill));
    const annex = randomUUID();
    must(`SET ROLE service_role;
      INSERT INTO public.businesses (id, organization_id, name) VALUES ('${annex}', '${c.org}', 'Annex');`);
    assert.equal(count("businesses", c.org), 2);
    const r = exec(
      asMember(
        c,
        `INSERT INTO public.agent_configs (organization_id, business_id) VALUES ('${c.org}', '${annex}');`,
      ),
    );
    assert.match(r.stderr, /BUSINESS_SETUP_EXISTS/);
    assert.equal(count("agent_configs", c.org), 1);
  });
});

describe("returning to the wizard", () => {
  test("submitting it unchanged writes nothing", (t) => {
    if (!ready(t)) return;
    const c = customer();
    save(c, payload(EMPTY, fill));
    const before = everything(c.org);
    const unchanged = payload(saved(c));
    assert.deepEqual(unchanged.changes, { business: {}, hours: [], services: [], agent: {} });
    save(c, unchanged);
    assert.deepEqual(everything(c.org), before);
  });

  test("edits are applied; blanks and untouched fields keep their saved values", (t) => {
    if (!ready(t)) return;
    const c = customer();
    save(c, payload(EMPTY, fill));
    // Details the wizard cannot show, edited elsewhere.
    must(`UPDATE public.business_hours SET intervals = '[{"start":"09:00","end":"12:00"},{"start":"14:00","end":"18:00"}]'
            WHERE organization_id = '${c.org}' AND day_of_week = 2;
          UPDATE public.agent_configs SET capabilities = '{"calendar_book": true}', transfer_number = '+911234567890'
            WHERE organization_id = '${c.org}';
          DELETE FROM public.faqs WHERE organization_id = '${c.org}';`);
    const from = saved(c);
    save(
      c,
      payload(from, (f) => {
        f.info.name = "Renamed Dental";
        f.info.address = "";
        f.info.email = "front@example.com";
        f.openDays = [1, 2, 3, 5];
        f.items[0]!.price = "650";
        f.items[1] = { ...f.items[1]!, name: "" };
        f.items.push({ name: "Whitening", price: "900" });
        f.agentName = "Meera";
        f.greeting = "";
      }),
    );
    const s = saved(c);
    assert.deepEqual(
      [s.business!.name, s.business!.address, s.business!.email, s.business!.city],
      ["Renamed Dental", "1 Main Road", "front@example.com", "Chennai"],
    );
    const day = (d: number) => s.hours.find((h) => h.day_of_week === d)!;
    assert.equal((day(2).intervals as unknown[]).length, 2, "the saved break stays");
    assert.equal(day(5).is_closed, false);
    assert.deepEqual(
      s.services.map((x) => [x.name, Number(x.price)]),
      [
        ["Cleaning", 650],
        ["Braces", 0],
        ["Whitening", 900],
      ],
    );
    assert.deepEqual(
      s.services.map((x) => x.id).slice(0, 2),
      from.services.map((x) => x.id),
      "edited in place",
    );
    assert.equal(s.agent!.agent_name, "Meera");
    assert.deepEqual(s.agent!.greetings, { "en-IN": "Vanakkam." });
    const kept = s.agent as unknown as Record<string, unknown>;
    assert.deepEqual(kept["capabilities"], { calendar_book: true });
    assert.equal(kept["transfer_number"], "+911234567890");
    assert.equal(count("faqs", c.org), 0, "deleted suggestions are not brought back");
    assert.deepEqual(
      counts(c.org).filter((_, i) => i === 0 || i === 5),
      [1, 1],
    );
  });

  test("the function itself ignores blank values", (t) => {
    if (!ready(t)) return;
    const c = customer();
    save(c, payload(EMPTY, fill));
    const before = everything(c.org);
    const blank = payload(saved(c));
    Object.assign(blank.changes, {
      business: { name: " ", address: "", city: "" },
      agent: { agent_name: "", greeting: "  ", voice_id: "" },
      services: [{ name: "  ", price: 5 }],
    });
    blank.changes.services.push({ id: saved(c).services[0]!.id, name: "", price: null });
    save(c, blank);
    assert.deepEqual(everything(c.org), before);
  });

  test("a newly chosen language gets a greeting; the earlier one stays", (t) => {
    if (!ready(t)) return;
    const c = customer();
    save(c, payload(EMPTY, fill));
    save(
      c,
      payload(saved(c), (f) => (f.language = "ta-IN")),
    );
    assert.deepEqual(saved(c).agent!.greetings, { "en-IN": "Vanakkam.", "ta-IN": "Vanakkam." });
  });

  test("a half-finished setup is completed around what is already there", (t) => {
    if (!ready(t)) return;
    const c = customer();
    must(`INSERT INTO public.businesses (organization_id, name, city)
            VALUES ('${c.org}', 'Half Dental', 'Madurai');
          INSERT INTO public.business_hours (organization_id, business_id, day_of_week, is_closed, intervals)
            SELECT organization_id, id, 1, false, '[{"start":"08:00","end":"11:00"}]' FROM public.businesses
             WHERE organization_id = '${c.org}';
          INSERT INTO public.business_hours (organization_id, business_id, day_of_week, is_closed, intervals)
            SELECT organization_id, id, 2, false, '[{"start":"12:00","end":"15:00"}]' FROM public.businesses
             WHERE organization_id = '${c.org}';
          INSERT INTO public.faqs (organization_id, business_id, question, answer)
            SELECT organization_id, id, 'Own question', 'Own answer' FROM public.businesses
             WHERE organization_id = '${c.org}';`);
    save(
      c,
      payload(saved(c), (f) => {
        f.typeId = "dental_clinic";
        f.items = [{ name: "Cleaning", price: "500" }];
      }),
    );
    assertOneSetup(c.org, 1);
    const s = saved(c);
    assert.deepEqual([s.business!.name, s.business!.city], ["Half Dental", "Madurai"]);
    const of = (d: number) => s.hours.find((h) => h.day_of_week === d)!.intervals;
    assert.deepEqual(
      [of(1), of(2)],
      [[{ start: "08:00", end: "11:00" }], [{ start: "12:00", end: "15:00" }]],
    );
    assert.equal(count("faqs", c.org), 1, "their own answers; no suggestions added over them");
  });

  test("older duplicate businesses are neither merged nor removed", (t) => {
    if (!ready(t)) return;
    const c = customer();
    const [first, second] = [randomUUID(), randomUUID()];
    must(`INSERT INTO public.businesses (id, organization_id, name, created_at) VALUES
            ('${first}', '${c.org}', 'First', now() - interval '2 days'),
            ('${second}', '${c.org}', 'Second', now() - interval '1 day');
          INSERT INTO public.agent_configs (organization_id, business_id) VALUES ('${c.org}', '${second}');`);
    const untouched = () =>
      json(`SELECT row_to_json(b) FROM public.businesses b WHERE id = '${first}';`);
    const before = untouched();
    assert.equal(saved(c).business!.name, "Second", "the receptionist's business is prefilled");
    save(
      c,
      payload(saved(c), (f) => ((f.typeId = "dental_clinic"), (f.info.city = "Salem"))),
    );
    assert.deepEqual(untouched(), before);
    assert.deepEqual([count("businesses", c.org), count("agent_configs", c.org)], [2, 1]);
    assert.equal(saved(c).business!.city, "Salem");
  });
});

describe("who may save", () => {
  test("the function runs with the caller's own rights", (t) => {
    if (!ready(t)) return;
    assert.deepEqual(
      json(
        `SELECT json_build_object('definer', prosecdef) FROM pg_proc WHERE proname = 'save_business_setup';`,
      ),
      { definer: false },
    );
  });

  test("only a member of that customer; nobody signed out", (t) => {
    if (!ready(t)) return;
    const mine = customer();
    const other = customer();
    save(other, payload(EMPTY, fill));
    const before = everything(other.org);
    const p = payload(EMPTY, fill);
    const r = exec(asMember(mine, call(mine, p, other.org)));
    assert.match(r.stderr, /BUSINESS_SETUP_NOT_ALLOWED/);
    const anon = exec(`SET ROLE anon;\n${call(mine, p)}`);
    assert.match(anon.stderr, /permission denied/);
    // Another customer's service id in my save changes nothing of theirs.
    const foreign = saved(other).services[0]!.id;
    const sneaky = payload(EMPTY, fill);
    sneaky.changes.services.push({ id: foreign, name: "Stolen", price: 1 });
    save(mine, sneaky);
    assert.deepEqual(everything(other.org), before);
  });
});

describe("rollback", () => {
  test("removes the function and the guard, keeps every row, and the migration re-applies", (t) => {
    if (!ready(t)) return;
    const c = customer();
    save(c, payload(EMPTY, fill));
    const rows = counts(c.org);
    const sql = readFileSync(ROLLBACK, "utf8");
    for (let pass = 0; pass < 2; pass++) must(`BEGIN;\n${sql}\nCOMMIT;`);
    assert.notEqual(exec(asMember(c, call(c, payload(EMPTY, fill)))).status, 0);
    assert.deepEqual(counts(c.org), rows);
    must(`BEGIN;\n${readFileSync(join(migrationsDir, NEW), "utf8")}\nCOMMIT;`);
    save(c, payload(saved(c)));
    assert.deepEqual(counts(c.org), rows);
  });
});
